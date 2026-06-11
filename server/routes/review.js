const express = require('express');
const path = require('path');
const db = require('../db');
const { getPRFiles, getFileContent, commitChanges, getCurrentHeadSha } = require('../github');
const { requireSession, requireActiveOrApproved } = require('../middleware/session');

// Returns pairs of [origIdx, savedIdx] for matching lines (LCS)
function lcsIndices(a, b) {
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return [];
  if (m * n > 10_000_000) return []; // Fall back to raw content for very large files (~3000+ lines)
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  const pairs = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i-1] === b[j-1]) { pairs.unshift([i-1, j-1]); i--; j--; }
    else if (dp[i-1][j] > dp[i][j-1]) i--;  // strict > avoids rightward bias on duplicate lines
    else j--;
  }
  return pairs;
}

// Reconstruct file content preserving original lines where unchanged
function reconstructMinimalContent(originalContent, savedContent) {
  if (!originalContent || originalContent === savedContent) return savedContent;
  // Normalise line endings for comparison; preserve the original's ending style in output
  const originalEnding = originalContent.includes('\r\n') ? '\r\n' : '\n';
  const origLines = originalContent.replace(/\r\n/g, '\n').split('\n');
  const savedLines = savedContent.replace(/\r\n/g, '\n').split('\n');
  const pairs = lcsIndices(origLines, savedLines);
  const result = [];
  let oIdx = 0, sIdx = 0, pIdx = 0;
  while (sIdx < savedLines.length || oIdx < origLines.length) {
    const [po, ps] = pIdx < pairs.length ? pairs[pIdx] : [origLines.length, savedLines.length];
    if (oIdx === po && sIdx === ps && pIdx < pairs.length) {
      result.push(origLines[oIdx]); // Unchanged line: preserve original bytes
      oIdx++; sIdx++; pIdx++;
    } else if (sIdx < ps) {
      result.push(savedLines[sIdx++]); // User-inserted line
    } else {
      oIdx++; // User-deleted line: skip
    }
  }
  return result.join(originalEnding);
}

const router = express.Router();

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
    const prFiles = await getPRFiles(session.owner, session.repo, session.pr_number);
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

  const edit = db.prepare(
    'SELECT content FROM file_edits WHERE session_id = ? AND file_path = ?'
  ).get(session.id, filePath);

  let content, source;
  if (edit) {
    content = edit.content;
    source = 'edit';
  } else {
    try {
      const ghContent = await getFileContent(session.owner, session.repo, filePath, session.head_sha);
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

  if (dirtyFiles.length === 0) {
    return res.status(400).json({ error: 'No changes to approve.' });
  }

  try {
    const currentSha = await getCurrentHeadSha(session.owner, session.repo, session.head_branch);
    if (currentSha !== session.head_sha) {
      return res.status(409).json({
        error: 'The branch has been updated since this review was created. Please ask the developer to create a new review link.',
      });
    }

    await commitChanges(
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
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
