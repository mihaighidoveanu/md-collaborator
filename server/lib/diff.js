// Pure line-diff helpers for the reviewer UI. Built on the same LCS primitive
// as lib/minimalDiff.js so duplicate-line handling stays consistent across
// the codebase's diffing logic.
const { lcsIndices } = require('./minimalDiff');

// A single trailing newline is a formatting artifact (GitHub's raw content
// has one, the editor's serialized markdown often doesn't) rather than a
// meaningful blank line — left in, it shifts one side's line count by one
// and misaligns the LCS pairing for every line after it.
function splitLines(text) {
  return (text || '').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
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

module.exports = { lineDiff };
