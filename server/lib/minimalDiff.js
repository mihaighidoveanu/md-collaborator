// Reconstruct a file's committed content so the PR diff touches only the lines
// the reviewer actually changed. Unchanged lines are emitted byte-for-byte from
// the original; only inserted/edited lines come from the saved content. This
// keeps the resulting commit minimal and trustworthy.

// Returns pairs of [origIdx, savedIdx] for matching lines (LCS).
function lcsIndices(a, b) {
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return [];
  if (m * n > 10_000_000) return []; // Fall back to raw content for very large files (~3000+ lines)
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const pairs = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { pairs.unshift([i - 1, j - 1]); i--; j--; }
    else if (dp[i - 1][j] > dp[i][j - 1]) i--;  // strict > avoids rightward bias on duplicate lines
    else j--;
  }
  return pairs;
}

// Reconstruct file content preserving original lines where unchanged.
function reconstructMinimalContent(originalContent, savedContent) {
  if (!originalContent || originalContent === savedContent) return savedContent;
  // Normalise line endings for comparison; preserve the original's ending style in output.
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

module.exports = { reconstructMinimalContent, lcsIndices };
