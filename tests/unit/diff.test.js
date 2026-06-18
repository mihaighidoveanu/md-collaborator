const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lineDiff, threeWay } = require('../../server/lib/diff');

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

test('threeWay: identical on both sides yields no changes and no conflicts', () => {
  const rows = threeWay('a\nb\nc', 'a\nb\nc', 'a\nb\nc');
  assert.ok(rows.every(r => !r.upstreamChanged && !r.mineChanged && !r.conflict));
  assert.deepEqual(rows.map(r => r.base), ['a', 'b', 'c']);
});

test('threeWay: upstream-only change is not a conflict', () => {
  const rows = threeWay('line one\nline two\nline three', 'line one\nline TWO changed\nline three', 'line one\nline two\nline three');
  const row = rows.find(r => r.base === 'line two');
  assert.equal(row.upstream, 'line TWO changed');
  assert.equal(row.mine, 'line two');
  assert.equal(row.upstreamChanged, true);
  assert.equal(row.mineChanged, false);
  assert.equal(row.conflict, false);
});

test('threeWay: mine-only change is not a conflict', () => {
  const rows = threeWay('line one\nline two\nline three', 'line one\nline two\nline three', 'line one\nline TWO mine\nline three');
  const row = rows.find(r => r.base === 'line two');
  assert.equal(row.upstream, 'line two');
  assert.equal(row.mine, 'line TWO mine');
  assert.equal(row.upstreamChanged, false);
  assert.equal(row.mineChanged, true);
  assert.equal(row.conflict, false);
});

test('threeWay: both sides change the same base line differently is a conflict', () => {
  const rows = threeWay('a\nb\nc', 'a\nB-upstream\nc', 'a\nB-mine\nc');
  const row = rows.find(r => r.base === 'b');
  assert.equal(row.upstream, 'B-upstream');
  assert.equal(row.mine, 'B-mine');
  assert.equal(row.upstreamChanged, true);
  assert.equal(row.mineChanged, true);
  assert.equal(row.conflict, true);
});

test('threeWay: both sides change the same base line to the same value is not a conflict', () => {
  const rows = threeWay('a\nb\nc', 'a\nSAME\nc', 'a\nSAME\nc');
  const row = rows.find(r => r.base === 'b');
  assert.equal(row.upstream, 'SAME');
  assert.equal(row.mine, 'SAME');
  assert.equal(row.conflict, false);
});

test('threeWay: one side deletes, the other edits the same line is a conflict', () => {
  const rows = threeWay('a\nb\nc', 'a\nc', 'a\nB-edited\nc');
  const row = rows.find(r => r.base === 'b');
  assert.equal(row.upstream, null);
  assert.equal(row.mine, 'B-edited');
  assert.equal(row.upstreamChanged, true);
  assert.equal(row.mineChanged, true);
  assert.equal(row.conflict, true);
});

test('threeWay: upstream-only insertion is not a conflict', () => {
  const rows = threeWay('a\nb', 'a\nx\nb', 'a\nb');
  const inserted = rows.find(r => r.base === null);
  assert.ok(inserted, 'an inserted row exists');
  assert.equal(inserted.upstream, 'x');
  assert.equal(inserted.mine, null);
  assert.equal(inserted.conflict, false);
  // Inserted row appears between the two unchanged base rows.
  const order = rows.map(r => r.base);
  assert.deepEqual(order, ['a', null, 'b']);
});

test('threeWay: both sides insert different content at the same anchor is a conflict', () => {
  const rows = threeWay('a\nb', 'a\nx\nb', 'a\ny\nb');
  const inserted = rows.find(r => r.base === null);
  assert.equal(inserted.upstream, 'x');
  assert.equal(inserted.mine, 'y');
  assert.equal(inserted.conflict, true);
});

test('threeWay: both sides insert the same content at the same anchor is not a conflict', () => {
  const rows = threeWay('a\nb', 'a\nx\nb', 'a\nx\nb');
  const inserted = rows.find(r => r.base === null);
  assert.equal(inserted.upstream, 'x');
  assert.equal(inserted.mine, 'x');
  assert.equal(inserted.conflict, false);
});

test('threeWay: duplicate lines are aligned without reordering or dropping', () => {
  // Mirrors R10.2's duplicate-line rigor: base has three "a" lines, mine
  // changes only the line right before the last one.
  const rows = threeWay('a\nb\na\nc\na', 'a\nb\na\nc\na', 'a\nb\na\nCHANGED\na');
  assert.deepEqual(rows.map(r => r.base), ['a', 'b', 'a', 'c', 'a']);
  const aRows = rows.filter(r => r.base === 'a');
  assert.equal(aRows.length, 3, 'all three "a" base lines are present exactly once');
  assert.ok(aRows.every(r => !r.upstreamChanged && !r.mineChanged && !r.conflict));
  const changedRow = rows.find(r => r.base === 'c');
  assert.equal(changedRow.mine, 'CHANGED');
  assert.equal(changedRow.upstream, 'c');
  assert.equal(changedRow.conflict, false);
});

test('threeWay: multi-line equal-length replacement pairs index-for-index', () => {
  const rows = threeWay('a\nb\nc\nd', 'a\nX\nY\nd', 'a\nb\nc\nd');
  assert.equal(rows.find(r => r.base === 'b').upstream, 'X');
  assert.equal(rows.find(r => r.base === 'c').upstream, 'Y');
});
