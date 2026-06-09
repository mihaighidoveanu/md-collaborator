const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { getPR } = require('../github');

const router = express.Router();

function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// List all sessions
router.get('/sessions', requireAdmin, (req, res) => {
  const sessions = db.prepare(`
    SELECT id, owner, repo, pr_number, pr_title, head_branch, status, created_at,
      (SELECT COUNT(*) FROM file_edits WHERE session_id = sessions.id AND dirty = 1) AS edits_count
    FROM sessions ORDER BY created_at DESC
  `).all();
  res.json(sessions);
});

// Create a session from a PR URL
router.post('/sessions', requireAdmin, async (req, res) => {
  const { pr_url } = req.body;
  if (!pr_url) return res.status(400).json({ error: 'pr_url is required' });

  // Accept https://github.com/:owner/:repo/pull/:number
  const match = pr_url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return res.status(400).json({ error: 'Invalid PR URL' });

  const [, owner, repo, prNumberStr] = match;
  const prNumber = parseInt(prNumberStr, 10);

  let pr;
  try {
    pr = await getPR(owner, repo, prNumber);
  } catch (err) {
    return res.status(400).json({ error: `Could not fetch PR: ${err.message}` });
  }

  if (pr.state !== 'open') {
    return res.status(400).json({ error: 'PR is not open' });
  }

  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');

  db.prepare(`
    INSERT INTO sessions (id, token, owner, repo, pr_number, pr_title, head_branch, head_sha, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(id, token, owner, repo, prNumber, pr.title, pr.head.ref, pr.head.sha, Date.now());

  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  res.json({
    session_id: id,
    review_link: `${baseUrl}/review/${token}`,
  });
});

// Revoke a session
router.post('/sessions/:id/revoke', requireAdmin, (req, res) => {
  const result = db.prepare(
    "UPDATE sessions SET status = 'revoked' WHERE id = ? AND status = 'active'"
  ).run(req.params.id);

  if (result.changes === 0) return res.status(404).json({ error: 'Session not found or already inactive' });
  res.json({ ok: true });
});

module.exports = router;
