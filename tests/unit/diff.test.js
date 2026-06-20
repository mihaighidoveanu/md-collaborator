const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lineDiff } = require('../../server/lib/diff');

test('lineDiff: unchanged text produces all eq rows', () => {
  const rows = lineDiff('a\nb\nc', 'a\nb\nc');
  assert.deepEqual(rows, [
    { type: 'eq', text: 'a' },
    { type: 'eq', text: 'b' },
    { type: 'eq', text: 'c' },
  ]);
});

test('lineDiff: a single changed line shows as del+add around unchanged context', () => {
  const rows = lineDiff('a\nb\nc', 'a\nB\nc');
  assert.deepEqual(rows, [
    { type: 'eq', text: 'a' },
    { type: 'add', text: 'B' },
    { type: 'del', text: 'b' },
    { type: 'eq', text: 'c' },
  ]);
});

test('lineDiff: pure insertion', () => {
  const rows = lineDiff('a\nc', 'a\nb\nc');
  assert.deepEqual(rows, [
    { type: 'eq', text: 'a' },
    { type: 'add', text: 'b' },
    { type: 'eq', text: 'c' },
  ]);
});

test('lineDiff: pure deletion', () => {
  const rows = lineDiff('a\nb\nc', 'a\nc');
  assert.deepEqual(rows, [
    { type: 'eq', text: 'a' },
    { type: 'del', text: 'b' },
    { type: 'eq', text: 'c' },
  ]);
});

test('lineDiff: duplicate lines are not duplicated or reordered', () => {
  const rows = lineDiff('a\nb\na\nc\na', 'a\nb\na\nCHANGED\na');
  const eqCount = rows.filter(r => r.type === 'eq' && r.text === 'a').length;
  assert.equal(eqCount, 3, 'all three unchanged "a" lines are preserved as eq');
  assert.deepEqual(
    rows.filter(r => r.type !== 'eq'),
    [{ type: 'add', text: 'CHANGED' }, { type: 'del', text: 'c' }]
  );
});

test('lineDiff: a trailing newline on only one side does not misalign the last changed line', () => {
  // GitHub's raw content ends with "\n"; the editor's serialized markdown
  // often doesn't. Without normalizing that, one side has one fewer split
  // line than the other, shifting the LCS pairing for the last line.
  const oldText = 'a\nb\nold last line\n';
  const newText = 'a\nb\nnew last line';
  const rows = lineDiff(oldText, newText);
  assert.deepEqual(rows, [
    { type: 'eq', text: 'a' },
    { type: 'eq', text: 'b' },
    { type: 'add', text: 'new last line' },
    { type: 'del', text: 'old last line' },
  ]);
});
