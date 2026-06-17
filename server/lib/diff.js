// Pure line-diff helpers for the reviewer UI. Built on the same LCS primitive
// as lib/minimalDiff.js so duplicate-line handling stays consistent across
// the codebase's diffing logic.
const { lcsIndices } = require('./minimalDiff');

function splitLines(text) {
  return (text || '').replace(/\r\n/g, '\n').split('\n');
}

// Inline two-way line diff. Walks the LCS pairing the same way
// reconstructMinimalContent does, emitting one row per line.
function lineDiff(oldText, newText) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const pairs = lcsIndices(oldLines, newLines);
  const rows = [];
  let oIdx = 0, nIdx = 0, pIdx = 0;
  while (oIdx < oldLines.length || nIdx < newLines.length) {
    const [po, pn] = pIdx < pairs.length ? pairs[pIdx] : [oldLines.length, newLines.length];
    if (oIdx === po && nIdx === pn && pIdx < pairs.length) {
      rows.push({ type: 'eq', text: oldLines[oIdx] });
      oIdx++; nIdx++; pIdx++;
    } else if (nIdx < pn) {
      rows.push({ type: 'add', text: newLines[nIdx++] });
    } else {
      rows.push({ type: 'del', text: oldLines[oIdx++] });
    }
  }
  return rows;
}

// For one side (upstream or mine) against base, compute:
//  - cells[i]: that side's line aligned to base line i, or null if base
//    line i was deleted on this side
//  - trailing.get(k): lines inserted on this side with no base counterpart,
//    to be displayed immediately after base row k (k = -1 means "before
//    the first base row")
// Within a gap between two matched base lines, the shorter of the base/other
// span is paired index-for-index (covers the common "edited N lines in
// place" case exactly); leftover base lines are deletions, leftover other
// lines are insertions anchored at the end of the gap.
function computeSideCells(baseLen, pairs, otherLines) {
  const cells = new Array(baseLen).fill(null);
  const trailing = new Map();

  function pushGap(baseStart, baseEnd, otherStart, otherEnd) {
    const baseSpan = baseEnd - baseStart;
    const otherSpan = otherEnd - otherStart;
    const common = Math.min(baseSpan, otherSpan);
    for (let k = 0; k < common; k++) cells[baseStart + k] = otherLines[otherStart + k];
    if (otherSpan > common) {
      const extra = otherLines.slice(otherStart + common, otherEnd);
      const anchor = baseSpan > 0 ? baseStart + common - 1 : baseStart - 1;
      trailing.set(anchor, (trailing.get(anchor) || []).concat(extra));
    }
  }

  let bPrev = 0, oPrev = 0;
  for (const [b, o] of pairs) {
    if (b > bPrev || o > oPrev) pushGap(bPrev, b, oPrev, o);
    cells[b] = otherLines[o];
    bPrev = b + 1; oPrev = o + 1;
  }
  if (bPrev < baseLen || oPrev < otherLines.length) pushGap(bPrev, baseLen, oPrev, otherLines.length);

  return { cells, trailing };
}

// Three-way line alignment keyed on base. Each base line becomes one row;
// lines inserted on either side with no base counterpart are appended as
// their own rows (base: null) at the point they occur, merged onto the same
// row when both sides insert at the same anchor (so two different insertions
// at the same spot are comparable, and surface as a conflict).
function threeWay(baseText, upstreamText, mineText) {
  const baseLines = splitLines(baseText);
  const upstreamLines = splitLines(upstreamText);
  const mineLines = splitLines(mineText);

  const upstreamPairs = lcsIndices(baseLines, upstreamLines);
  const minePairs = lcsIndices(baseLines, mineLines);

  const { cells: upstreamCells, trailing: upstreamTrailing } =
    computeSideCells(baseLines.length, upstreamPairs, upstreamLines);
  const { cells: mineCells, trailing: mineTrailing } =
    computeSideCells(baseLines.length, minePairs, mineLines);

  const rows = [];

  function makeRow(base, upstream, mine) {
    const upstreamChanged = upstream !== base;
    const mineChanged = mine !== base;
    const conflict = upstreamChanged && mineChanged && upstream !== mine;
    return { base, upstream, mine, upstreamChanged, mineChanged, conflict };
  }

  function emitTrailing(key) {
    const u = upstreamTrailing.get(key) || [];
    const m = mineTrailing.get(key) || [];
    const max = Math.max(u.length, m.length);
    for (let k = 0; k < max; k++) {
      rows.push(makeRow(null, k < u.length ? u[k] : null, k < m.length ? m[k] : null));
    }
  }

  emitTrailing(-1);
  for (let i = 0; i < baseLines.length; i++) {
    rows.push(makeRow(baseLines[i], upstreamCells[i], mineCells[i]));
    emitTrailing(i);
  }

  return rows;
}

module.exports = { lineDiff, threeWay };
