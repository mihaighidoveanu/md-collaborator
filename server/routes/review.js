const express = require('express');
const path = require('path');
const { reconstructMinimalContent } = require('../lib/minimalDiff');
const createSessionMiddleware = require('../middleware/session');

function createReviewRouter({ db, github }) {
  const router = express.Router();
  const { requireSession, requireActiveOrApproved } = createSessionMiddleware(db);

  // Serve the partner UI
  router.get('/:token', (req, res) => {
    const { token } = req.params;
    const session = db.prepare('SELECT status FROM sessions WHERE token = ?').get(token);
    if (!session) return res.status(404).send('Link not found.');
    res.sendFile(path.join(__dirname, '../../public/review.html'));
  });

  // Session metadata + file list
  router.get('/api/:token', requireActiveOrApproved, async (req, res) => {
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

  // Get file content (edited version if available, otherwise from GitHub)
  router.get('/api/:token/files/*', requireActiveOrApproved, async (req, res) => {
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
      'SELECT content FROM file_edits WHERE session_id = ? AND file_path = ?'
    ).get(session.id, filePath);

    let content, source;
    if (edit) {
      content = edit.content;
      source = 'edit';
    } else {
      try {
        const ghContent = await github.getFileContent(session.owner, session.repo, filePath, session.head_sha);
        if (ghContent === null) return res.status(404).json({ error: 'File not found' });
        content = ghContent;
        source = 'github';
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    if (session.status === 'active') {
      db.prepare(`
        INSERT INTO file_visits (session_id, file_path, visited_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id, file_path) DO NOTHING
      `).run(session.id, filePath, Date.now());
    }

    res.json({ content, source });
  });

  // Autosave a file edit
  router.put('/api/:token/files/*', requireSession, (req, res) => {
    const { session } = req;
    const filePath = req.params[0];
    const { content, originalContent } = req.body;

    if (typeof content !== 'string') return res.status(400).json({ error: 'content is required' });

    // original_content is only written once (on first save); subsequent saves preserve it
    const existing = db.prepare('SELECT original_content FROM file_edits WHERE session_id = ? AND file_path = ?').get(session.id, filePath);
    const origToStore = existing?.original_content ?? (typeof originalContent === 'string' ? originalContent : null);

    db.prepare(`
      INSERT INTO file_edits (session_id, file_path, content, original_content, dirty, updated_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(session_id, file_path) DO UPDATE SET content = excluded.content, original_content = COALESCE(original_content, excluded.original_content), dirty = 1, updated_at = excluded.updated_at
    `).run(session.id, filePath, content, origToStore, Date.now());

    res.json({ ok: true });
  });

  // Approve — commit all dirty files and lock session
  router.post('/api/:token/approve', requireSession, async (req, res) => {
    const { session } = req;

    const dirtyFiles = db.prepare(
      'SELECT file_path, content, original_content FROM file_edits WHERE session_id = ? AND dirty = 1'
    ).all(session.id);

    // Approving with no edits still closes the session cleanly, committing nothing.
    if (dirtyFiles.length === 0) {
      db.prepare("UPDATE sessions SET status = 'approved' WHERE id = ?").run(session.id);
      return res.json({ ok: true, committed: false });
    }

    try {
      const currentSha = await github.getCurrentHeadSha(session.owner, session.repo, session.head_branch);
      if (currentSha !== session.head_sha) {
        return res.status(409).json({
          error: 'The branch has been updated since this review was created. Please ask the developer to create a new review link.',
        });
      }

      await github.commitChanges(
        session.owner,
        session.repo,
        session.head_branch,
        session.head_sha,
        dirtyFiles.map(f => ({
          filePath: f.file_path,
          content: reconstructMinimalContent(f.original_content, f.content),
        }))
      );

      db.prepare("UPDATE sessions SET status = 'approved' WHERE id = ?").run(session.id);
      res.json({ ok: true, committed: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createReviewRouter;
