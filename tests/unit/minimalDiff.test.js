const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconstructMinimalContent } = require('../../server/lib/minimalDiff');

// REQ-10 — Committed changes keep the PR diff minimal: only the lines the
// reviewer actually changed differ; untouched lines stay byte-for-byte.

// Count how many lines differ between two equal-length-ish texts (by position
// after alignment we just compare the full line arrays).
function changedLineCount(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let n = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
}

test('R10.1 a single changed line differs from the original only on that line', () => {
  const original = 'line one\nline two\nline three\nline four\n';
  const saved = 'line one\nline TWO changed\nline three\nline four\n';
  const result = reconstructMinimalContent(original, saved);

  assert.equal(result, saved, 'edited content is preserved');
  assert.equal(changedLineCount(original, result), 1, 'exactly one line differs from the original');
});

test('R10.2 files with repeated identical lines are reconstructed without duplicating or reordering', () => {
  const original = 'a\nb\na\nc\na\n';
  const saved = 'a\nb\na\nCHANGED\na\n';
  const result = reconstructMinimalContent(original, saved);

  assert.equal(result, saved);
  const lines = result.split('\n');
  assert.equal(lines.filter(l => l === 'a').length, 3, 'no duplicated/dropped repeated lines');
  assert.equal(changedLineCount(original, result), 1, 'only the changed line differs');
});

test('R10.3 very large files are committed correctly (fallback path) without corruption', () => {
  // Big enough to exceed the LCS size guard and take the raw fallback.
  const N = 4000;
  const origLines = Array.from({ length: N }, (_, i) => `line ${i}`);
  const savedLines = origLines.slice();
  savedLines[1234] = 'line 1234 EDITED';
  const original = origLines.join('\n') + '\n';
  const saved = savedLines.join('\n') + '\n';

  const result = reconstructMinimalContent(original, saved);
  assert.equal(result, saved, 'large file content round-trips intact');
  assert.equal(changedLineCount(original, result), 1, 'only the edited line differs');
});

test('R10 preserves the original line-ending style', () => {
  const original = 'a\r\nb\r\nc\r\n';
  const saved = 'a\nB\nc\n';
  const result = reconstructMinimalContent(original, saved);
  assert.ok(result.includes('\r\n'), 'CRLF original yields CRLF output');
});
