const express = require('express');
const path = require('path');
const { reconstructMinimalContent } = require('../lib/minimalDiff');
const { lineDiff, threeWay } = require('../lib/diff');
const { withRetry } = require('../lib/retry');
const createSessionMiddleware = require('../middleware/session');

// Columns returned for a comment, shared by the list and create endpoints.
const COMMENT_COLS = 'id, file_path, anchor_text, paragraph_index, body, resolved, created_at';

// Render the reviewer's comments as a markdown section so they travel with
// the pull request / approval. Anchored comments quote the paragraph they
// refer to; free comments are listed on their own. (Inline GitHub review
// comments are intentionally out of scope.) Returns '' when there are none.
function commentsSection(comments) {
  if (!comments || !comments.length) return '';
  const lines = ['', '## Reviewer comments', ''];
  for (const c of comments) {
    const where = c.file_path ? `\`${c.file_path}\`` : 'General';
    lines.push(`- **${where}**`);
    if (c.anchor_text) {
      lines.push(`  > ${String(c.anchor_text).split('\n').join('\n  > ')}`);
    }
    lines.push(`  ${c.body}`);
  }
  return lines.join('\n');
}

// Compose the review PR's body so the reviewer's comments travel with it.
function buildPrBody(session, comments) {
  return [`Review edits imported from PR #${session.pr_number}.`, commentsSection(comments)]
    .filter(Boolean).join('\n');
}

// The original developer PR's URL — the "current PR" until/unless a
// merge/close fallback opens a new one (functional-spec.md §2.1, §6).
function originalPrUrl(session) {
  return `https://github.com/${session.owner}/${session.repo}/pull/${session.pr_number}`;
}

// The branch the reviewer's edits currently live on. It starts as the original
// PR's head branch and moves to the fallback branch once a merge/close opens a
// new PR (functional-spec.md §2.1). Reads and the "settled" check track this
// branch rather than head_branch, which may have been deleted when the original
// PR merged.
function currentBranchOf(session) {
  return session.submitted_branch ?? session.head_branch;
}

function createReviewRouter({ db, github }) {
  const router = express.Router();
  const { requireSession, requireNotRevoked } = createSessionMiddleware(db);

  // Short-lived cache of a PR's reviewable file set. A reviewer opens many files
  // in a sitting and each open re-validates membership; without this every open
  // re-paginates the PR's file list. TTL is brief so a changed file set is picked
  // up quickly.
  const prFilesCache = new Map(); // `${owner}/${repo}#${pr}` -> { files, at }
  const PR_FILES_TTL_MS = 15000;
  async function reviewableFiles(session) {
    const key = `${session.owner}/${session.repo}#${session.pr_number}`;
    const hit = prFilesCache.get(key);
    if (hit && Date.now() - hit.at < PR_FILES_TTL_MS) return hit.files;
    const files = await github.getPRFiles(session.owner, session.repo, session.pr_number);
    prFilesCache.set(key, { files, at: Date.now() });
    return files;
  }

  // Serve the partner UI
  router.get('/:token', (req, res) => {
    const { token } = req.params;
    const session = db.prepare('SELECT status FROM sessions WHERE token = ?').get(token);
    if (!session) return res.status(404).send('Link not found.');
    res.sendFile(path.join(__dirname, '../../public/review.html'));
  });

  // Session metadata + file list
  router.get('/api/:token', requireNotRevoked, async (req, res) => {
    const { session } = req;
    try {
      const prFiles = await reviewableFiles(session);
      const edits = db.prepare('SELECT file_path, dirty FROM file_edits WHERE session_id = ?').all(session.id);
      const editedPaths = new Set(edits.map(r => r.file_path));
      const dirtyPaths = new Set(edits.filter(r => r.dirty).map(r => r.file_path));
      const visitedPaths = new Set(
        db.prepare('SELECT file_path FROM file_visits WHERE session_id = ?')
          .all(session.id)
          .map(r => r.file_path)
      );
      const files = prFiles.map(f => ({
        path: f.filename,
        status: f.status,
        edited: editedPaths.has(f.filename),
        dirty: dirtyPaths.has(f.filename),
        visited: visitedPaths.has(f.filename),
      }));

      // "Settled": the reviewer's last action (approve or commit-submit) still
      // reflects the current state of the target branch — nothing to act on
      // again yet. Best-effort: a blip leaves it unsettled (button stays clickable)
      // rather than getting stuck disabled.
      let settled = false;
      try {
        const liveHeadSha = await github.getCurrentHeadSha(session.owner, session.repo, currentBranchOf(session));
        settled = !!session.last_action_sha && liveHeadSha === session.last_action_sha;
      } catch {}

      res.json({
        pr_number: session.pr_number,
        pr_title: session.pr_title,
        owner: session.owner,
        repo: session.repo,
        status: session.status,
        submitted_branch: session.submitted_branch,
        submitted_pr_number: session.submitted_pr_number,
        submitted_pr_url: session.submitted_pr_url,
        current_pr_number: session.submitted_pr_number ?? session.pr_number,
        current_pr_url: session.submitted_pr_url ?? originalPrUrl(session),
        approved_at: session.approved_at,
        settled,
        files,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get file content, change-aware: surfaces what moved upstream since the
  // reviewer last looked at this file (two-way diff). Three-way reconciliation
  // for files the reviewer has also edited is layered on in a later phase.
  router.get('/api/:token/files/*', requireNotRevoked, async (req, res) => {
    const { session } = req;
    const filePath = req.params[0];

    // A reviewer may only read files that are part of this session's review set.
    let reviewable;
    try {
      reviewable = await reviewableFiles(session);
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
      liveHeadSha = await github.getCurrentHeadSha(session.owner, session.repo, currentBranchOf(session));
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

  // Build the body for a no-edit GitHub approval review, carrying the
  // reviewer's comments along (mirrors buildPrBody's comment formatting).
  function buildApprovalBody(session) {
    const comments = db.prepare(
      'SELECT file_path, anchor_text, body FROM comments WHERE session_id = ? ORDER BY created_at'
    ).all(session.id);
    return ['Approved via review tool.', commentsSection(comments)].filter(Boolean).join('\n');
  }

  // Submit — with no pending edits, post a GitHub approval on the original PR
  // (D1). With pending edits, commit them to the current review branch/PR,
  // creating either as needed per the re-submission matrix (D2/D5). The
  // session is never locked: it stays 'active' through any number of submits
  // (D4), and a committed round resets the dirty baselines (D3).
  router.post('/api/:token/submit', requireSession, async (req, res) => {
    const { session } = req;

    const dirtyFiles = db.prepare(
      'SELECT file_path, content, original_content FROM file_edits WHERE session_id = ? AND dirty = 1'
    ).all(session.id);

    // ── APPROVE path (D1): no pending edits → approve the ORIGINAL PR ──
    if (dirtyFiles.length === 0) {
      try {
        const review = await github.approvePullRequest(
          session.owner, session.repo, session.pr_number,
          buildApprovalBody(session)
        );
        // Pin the "settled" reference to the target branch's head right now, so
        // the button stays disabled only until the target branch actually moves.
        // The approval already succeeded above; a blip here must not turn that
        // into a reported failure — fall back to null ("settled" unknown/false).
        let settledSha = null;
        try {
          settledSha = await withRetry(() =>
            github.getCurrentHeadSha(session.owner, session.repo, currentBranchOf(session)));
        } catch {}
        db.prepare('UPDATE sessions SET approved_at = ?, last_action_sha = ? WHERE id = ?')
          .run(Date.now(), settledSha, session.id);
        return res.json({ ok: true, action: 'approved', review_url: review.html_url });
      } catch (err) {
        return res.status(500).json({ error: err.message }); // session unchanged
      }
    }

    // ── SUBMIT-CHANGES path: target the CURRENT PR (the original PR until a
    // merge/close fallback opens a new one), per the re-submission matrix
    // (functional-spec.md §2.1). We never maintain a separate review branch
    // while the current PR stays open — every submit is a plain commit onto
    // its own branch's live head. A new branch + PR appears only as a
    // fallback once that PR is found merged or closed.
    const currentPrNumber = session.submitted_pr_number ?? session.pr_number;
    const currentBranch = session.submitted_branch ?? session.head_branch;

    const { merged, state } = await withRetry(() =>
      github.getPRState(session.owner, session.repo, currentPrNumber));
    let isOpen = state === 'open' && !merged;

    // An "open" PR can still have lost its head branch — deleted in the
    // meantime, or eventual consistency right after a merge (GitHub closes a PR
    // when its head branch is deleted, but that can lag). We can't commit onto a
    // branch that no longer exists, so confirm it's there; if it's gone, take
    // the same new-branch/new-PR fallback as a merged/closed PR. branchExists
    // returns false on a definitive 404 and only throws on a transient error
    // (which withRetry retries, then surfaces as a 500 leaving the session
    // active), so we never mistake a blip for a deleted branch.
    if (isOpen && !(await withRetry(() =>
        github.branchExists(session.owner, session.repo, currentBranch)))) {
      isOpen = false;
    }

    let createdBranchThisCall = null;
    try {
      let committedBranch;
      let commitBaseSha;
      let fallbackBase = null;

      if (isOpen) {
        // Open current PR (including the very first submit, against the
        // original PR): commit straight onto its own branch's live head.
        committedBranch = currentBranch;
        commitBaseSha = await withRetry(() =>
          github.getCurrentHeadSha(session.owner, session.repo, currentBranch));
      } else {
        // Merged or closed: fall back to a new branch off the current PR's
        // own base/target branch, then a new PR onto that base.
        const pr = await withRetry(() =>
          github.getPR(session.owner, session.repo, currentPrNumber));
        fallbackBase = pr.base.ref;
        commitBaseSha = await withRetry(() =>
          github.getCurrentHeadSha(session.owner, session.repo, fallbackBase));
        committedBranch = await github.createBranch(
          session.owner, session.repo,
          `review/pr${session.pr_number}-${session.token.slice(0, 8)}`, commitBaseSha);
        createdBranchThisCall = committedBranch; // only THIS gets cleaned up on failure
      }

      const newCommitSha = await github.commitChanges(
        session.owner, session.repo, committedBranch, commitBaseSha,
        dirtyFiles.map(f => ({
          filePath: f.file_path,
          content: reconstructMinimalContent(f.original_content, f.content),
        })));

      let prNumber = currentPrNumber;
      let prUrl = session.submitted_pr_url ?? originalPrUrl(session);

      if (!isOpen) {
        const comments = db.prepare(
          'SELECT file_path, anchor_text, body FROM comments WHERE session_id = ? ORDER BY created_at'
        ).all(session.id);
        const pr = await github.createPullRequest(
          session.owner, session.repo, committedBranch, fallbackBase,
          `Review: ${session.pr_title}`, buildPrBody(session, comments));
        createdBranchThisCall = null; // PR now owns the branch
        prNumber = pr.number; prUrl = pr.html_url;

        // Persist the new current PR/branch (overwrite — they are "current",
        // not one-shot). Left null while the original PR stays current.
        db.prepare(`UPDATE sessions
           SET submitted_branch = ?, submitted_pr_number = ?, submitted_pr_url = ?
           WHERE id = ?`).run(committedBranch, prNumber, prUrl, session.id);
      }

      // The commit always lands on the current branch — the open current PR's
      // own branch, or the fallback branch we just opened and made current
      // above. Reads track that same branch (currentBranchOf), so the new
      // baseline is exactly this commit. No extra read of head_branch, which
      // may have been deleted when the original PR merged.
      const targetHeadSha = newCommitSha;

      db.prepare('UPDATE sessions SET last_action_sha = ? WHERE id = ?')
        .run(targetHeadSha, session.id);

      // D3 — advance baselines so the next round starts clean.
      const advance = db.prepare(`UPDATE file_edits
         SET dirty = 0, original_content = content, base_sha = ?
         WHERE session_id = ? AND file_path = ?`);
      for (const f of dirtyFiles) advance.run(targetHeadSha, session.id, f.file_path);

      // status stays 'active' (D4) — never set 'submitted'.
      res.json({ ok: true, action: 'submitted', pr_number: prNumber, pr_url: prUrl, branch: committedBranch });
    } catch (err) {
      if (createdBranchThisCall) {
        try { await github.deleteBranch(session.owner, session.repo, createdBranchThisCall); } catch {}
      }
      res.status(500).json({ error: err.message }); // session stays active
    }
  });

  // --- Comments (anchored to a paragraph, or free) ---

  // List the session's comments. Readable on any non-revoked session so they
  // remain visible across any number of submit rounds.
  router.get('/api/:token/comments', requireNotRevoked, (req, res) => {
    const rows = db.prepare(
      `SELECT ${COMMENT_COLS} FROM comments WHERE session_id = ? ORDER BY created_at`
    ).all(req.session.id);
    res.json(rows);
  });

  // Create a comment. Anchored comments carry a file_path + paragraph_index +
  // anchor_text; a free comment may omit the anchor (and file_path).
  router.post('/api/:token/comments', requireSession, (req, res) => {
    const { file_path, anchor_text, paragraph_index, body } = req.body;
    if (typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'body is required' });
    }
    const info = db.prepare(`
      INSERT INTO comments (session_id, file_path, anchor_text, paragraph_index, body, resolved, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(
      req.session.id,
      typeof file_path === 'string' ? file_path : null,
      typeof anchor_text === 'string' ? anchor_text : null,
      Number.isInteger(paragraph_index) ? paragraph_index : null,
      body,
      Date.now()
    );
    const row = db.prepare(
      `SELECT ${COMMENT_COLS} FROM comments WHERE id = ?`
    ).get(info.lastInsertRowid);
    res.json(row);
  });

  // Resolve / unresolve a comment, scoped to this session.
  router.patch('/api/:token/comments/:id', requireSession, (req, res) => {
    const { resolved } = req.body;
    const result = db.prepare(
      'UPDATE comments SET resolved = ? WHERE id = ? AND session_id = ?'
    ).run(resolved ? 1 : 0, req.params.id, req.session.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Comment not found' });
    res.json({ ok: true });
  });

  // Delete a comment, scoped to this session.
  router.delete('/api/:token/comments/:id', requireSession, (req, res) => {
    const result = db.prepare(
      'DELETE FROM comments WHERE id = ? AND session_id = ?'
    ).run(req.params.id, req.session.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Comment not found' });
    res.json({ ok: true });
  });

  return router;
}

module.exports = createReviewRouter;
