const express = require('express');
const path = require('path');
const { reconstructMinimalContent } = require('../lib/minimalDiff');
const { lineDiff, threeWay } = require('../lib/diff');
const { withRetry } = require('../lib/retry');
const createSessionMiddleware = require('../middleware/session');

// Compose the PR body so the reviewer's comments travel with the pull request.
// Anchored comments quote the paragraph they refer to; free comments are listed
// on their own. (Inline GitHub review comments are intentionally out of scope.)
function buildPrBody(session, comments) {
  const lines = [
    `Review edits imported from PR #${session.pr_number}.`,
  ];
  if (comments && comments.length) {
    lines.push('', '## Reviewer comments', '');
    for (const c of comments) {
      const where = c.file_path ? `\`${c.file_path}\`` : 'General';
      lines.push(`- **${where}**`);
      if (c.anchor_text) {
        lines.push(`  > ${String(c.anchor_text).split('\n').join('\n  > ')}`);
      }
      lines.push(`  ${c.body}`);
    }
  }
  return lines.join('\n');
}

function createReviewRouter({ db, github }) {
  const router = express.Router();
  const { requireSession, requireActiveOrSubmitted } = createSessionMiddleware(db);

  // Serve the partner UI
  router.get('/:token', (req, res) => {
    const { token } = req.params;
    const session = db.prepare('SELECT status FROM sessions WHERE token = ?').get(token);
    if (!session) return res.status(404).send('Link not found.');
    res.sendFile(path.join(__dirname, '../../public/review.html'));
  });

  // Session metadata + file list
  router.get('/api/:token', requireActiveOrSubmitted, async (req, res) => {
    const { session } = req;
    try {
      const prFiles = await github.getPRFiles(session.owner, session.repo, session.pr_number);
      const editedPaths = new Set(
        db.prepare('SELECT file_path FROM file_edits WHERE session_id = ?')
          .all(session.id)
          .map(r => r.file_path)
      );
      const visitedPaths = new Set(
        db.prepare('SELECT file_path FROM file_visits WHERE session_id = ?')
          .all(session.id)
          .map(r => r.file_path)
      );
      const files = prFiles.map(f => ({
        path: f.filename,
        status: f.status,
        edited: editedPaths.has(f.filename),
        visited: visitedPaths.has(f.filename),
      }));
      res.json({
        pr_number: session.pr_number,
        pr_title: session.pr_title,
        owner: session.owner,
        repo: session.repo,
        status: session.status,
        files,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get file content, change-aware: surfaces what moved upstream since the
  // reviewer last looked at this file (two-way diff). Three-way reconciliation
  // for files the reviewer has also edited is layered on in a later phase.
  router.get('/api/:token/files/*', requireActiveOrSubmitted, async (req, res) => {
    const { session } = req;
    const filePath = req.params[0];

    // A reviewer may only read files that are part of this session's review set.
    let reviewable;
    try {
      reviewable = await github.getPRFiles(session.owner, session.repo, session.pr_number);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!reviewable.some(f => f.filename === filePath)) {
      return res.status(404).json({ error: 'File is not part of this review.' });
    }

    const edit = db.prepare(
      'SELECT content, original_content, base_sha FROM file_edits WHERE session_id = ? AND file_path = ?'
    ).get(session.id, filePath);
    const visit = db.prepare(
      'SELECT seen_content, seen_sha FROM file_visits WHERE session_id = ? AND file_path = ?'
    ).get(session.id, filePath);
    const mine = edit ? edit.content : null;

    // Resolve the live branch head. The read is best-effort for display: a blip
    // falls back to the session's original head rather than blocking the reviewer.
    let liveHeadSha;
    try {
      liveHeadSha = await github.getCurrentHeadSha(session.owner, session.repo, session.head_branch);
    } catch {
      liveHeadSha = session.head_sha;
    }

    // Fast path: the head SHA identifies the whole tree, so if it has not moved
    // since the reviewer last looked, upstream is byte-for-byte what we already
    // have — serve it and skip the content fetch. (A *mismatch* only means
    // something on the branch moved, not necessarily this file, so it falls
    // through to a real content comparison below.)
    //   - unedited file: compare against the last-seen head.
    //   - edited file: compare against the head the edit baseline was taken at;
    //     if it hasn't moved, upstream can't have drifted from base, so there is
    //     nothing to reconcile — just show their edit.
    if (mine === null && visit && visit.seen_sha && visit.seen_sha === liveHeadSha
        && typeof visit.seen_content === 'string') {
      return res.json({ view: 'plain', content: visit.seen_content, source: 'github' });
    }
    if (mine !== null && edit.base_sha && edit.base_sha === liveHeadSha) {
      return res.json({ view: 'plain', content: mine, source: 'edit' });
    }

    let upstream;
    try {
      upstream = await github.getFileContent(session.owner, session.repo, filePath, liveHeadSha);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    if (upstream === null && mine === null) {
      return res.status(404).json({ error: 'File not found' });
    }

    let payload;
    if (mine !== null) {
      const base = edit.original_content;
      if (upstream !== null && typeof base === 'string' && upstream !== base) {
        // The reviewer edited this file AND upstream drifted from their baseline:
        // surface all three so they can reconcile (req 5).
        payload = {
          view: 'three_way',
          content: mine,
          source: 'edit',
          base,
          upstream,
          mine,
          diff: threeWay(base, upstream, mine),
        };
      } else {
        // No upstream drift (or no usable baseline) — just show their edit.
        payload = { view: 'plain', content: mine, source: 'edit' };
      }
    } else if (visit && typeof visit.seen_content === 'string' && visit.seen_content !== upstream) {
      // Upstream moved since the reviewer last looked at this file.
      payload = {
        view: 'two_way',
        content: upstream,
        source: 'github',
        seen: visit.seen_content,
        upstream,
        diff: lineDiff(visit.seen_content, upstream),
      };
    } else {
      payload = { view: 'plain', content: upstream, source: 'github' };
    }

    // Advance the "seen" watermark to the current upstream so the next visit
    // diffs against what is shown now. Only active sessions advance it.
    if (session.status === 'active') {
      db.prepare(`
        INSERT INTO file_visits (session_id, file_path, visited_at, seen_content, seen_sha)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, file_path) DO UPDATE SET
          visited_at = excluded.visited_at,
          seen_content = excluded.seen_content,
          seen_sha = excluded.seen_sha
      `).run(session.id, filePath, Date.now(), upstream, liveHeadSha);
    }

    res.json(payload);
  });

  // Autosave a file edit
  router.put('/api/:token/files/*', requireSession, (req, res) => {
    const { session } = req;
    const filePath = req.params[0];
    const { content, originalContent } = req.body;

    if (typeof content !== 'string') return res.status(400).json({ error: 'content is required' });

    // original_content and base_sha are only written once (on first save);
    // subsequent saves preserve them so the diff baseline never moves.
    const existing = db.prepare('SELECT original_content FROM file_edits WHERE session_id = ? AND file_path = ?').get(session.id, filePath);
    const origToStore = existing?.original_content ?? (typeof originalContent === 'string' ? originalContent : null);
    const baseShaToStore = session.head_sha;

    db.prepare(`
      INSERT INTO file_edits (session_id, file_path, content, original_content, base_sha, dirty, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(session_id, file_path) DO UPDATE SET content = excluded.content, original_content = COALESCE(original_content, excluded.original_content), base_sha = COALESCE(base_sha, excluded.base_sha), dirty = 1, updated_at = excluded.updated_at
    `).run(session.id, filePath, content, origToStore, baseShaToStore, Date.now());

    res.json({ ok: true });
  });

  // Submit — open a pull request from the reviewer's edits, then close the
  // session. The reviewer never writes to the PR's own branch: changes land on
  // a fresh branch and a PR targets the original PR's head branch (D1/D2).
  router.post('/api/:token/submit', requireSession, async (req, res) => {
    const { session } = req;

    const dirtyFiles = db.prepare(
      'SELECT file_path, content, original_content FROM file_edits WHERE session_id = ? AND dirty = 1'
    ).all(session.id);

    // Submitting with no edits still closes the session cleanly, opening no PR.
    if (dirtyFiles.length === 0) {
      db.prepare("UPDATE sessions SET status = 'submitted' WHERE id = ?").run(session.id);
      return res.json({ ok: true, submitted: false });
    }

    try {
      // Commit off the live head so we never clobber work that landed since the
      // session was created — the three-way view already surfaced any drift.
      // A transient blip on this read is retried; if it stays down we fail the
      // submit (session stays open) rather than risk committing off a stale base.
      const liveHeadSha = await withRetry(
        () => github.getCurrentHeadSha(session.owner, session.repo, session.head_branch)
      );

      const branchName = `review/pr${session.pr_number}-${session.token.slice(0, 8)}`;
      const newBranch = await github.createBranch(session.owner, session.repo, branchName, liveHeadSha);

      await github.commitChanges(
        session.owner,
        session.repo,
        newBranch,
        liveHeadSha,
        dirtyFiles.map(f => ({
          filePath: f.file_path,
          content: reconstructMinimalContent(f.original_content, f.content),
        }))
      );

      const comments = db.prepare(
        'SELECT file_path, anchor_text, body FROM comments WHERE session_id = ? ORDER BY created_at'
      ).all(session.id);
      const body = buildPrBody(session, comments);

      const pr = await github.createPullRequest(
        session.owner,
        session.repo,
        newBranch,
        session.head_branch,
        `Review: ${session.pr_title}`,
        body
      );

      db.prepare(
        "UPDATE sessions SET status = 'submitted', submitted_pr_number = ?, submitted_pr_url = ?, submitted_branch = ? WHERE id = ?"
      ).run(pr.number, pr.html_url, newBranch, session.id);

      res.json({ ok: true, submitted: true, pr_number: pr.number, pr_url: pr.html_url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createReviewRouter;
