const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectReviewableFiles } = require('../../server/lib/files');

// REQ-3 — A session exposes exactly the PR's reviewable markdown.

test('R3.1 non-markdown files in the PR are not part of the session', () => {
  const prFiles = [
    { filename: 'docs/guide.md', status: 'modified' },
    { filename: 'src/app.js', status: 'modified' },
    { filename: 'README.md', status: 'added' },
    { filename: 'image.png', status: 'added' },
    { filename: 'notes.txt', status: 'modified' },
  ];
  const result = selectReviewableFiles(prFiles).map(f => f.filename);
  assert.deepEqual(result, ['docs/guide.md', 'README.md']);
});

test('R3.2 markdown files deleted by the PR are excluded', () => {
  const prFiles = [
    { filename: 'keep.md', status: 'modified' },
    { filename: 'gone.md', status: 'removed' },
    { filename: 'added.md', status: 'added' },
  ];
  const result = selectReviewableFiles(prFiles).map(f => f.filename);
  assert.deepEqual(result, ['keep.md', 'added.md']);
  assert.ok(!result.includes('gone.md'), 'a markdown file the PR removes cannot be reviewed');
});

test('R3.3 every markdown file appears even on a large PR; none are silently dropped', () => {
  // Simulate a large PR's full (already-aggregated) file list, interleaved with noise.
  const prFiles = [];
  for (let i = 0; i < 250; i++) {
    prFiles.push({ filename: `docs/file-${i}.md`, status: 'modified' });
    prFiles.push({ filename: `assets/img-${i}.png`, status: 'added' });
  }
  const result = selectReviewableFiles(prFiles);
  assert.equal(result.length, 250, 'all markdown files are preserved');
  for (let i = 0; i < 250; i++) {
    assert.ok(result.some(f => f.filename === `docs/file-${i}.md`), `file-${i}.md present`);
  }
});
