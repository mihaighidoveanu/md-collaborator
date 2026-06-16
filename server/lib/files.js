// Pure selection of the files a review session should expose.
//
// A reviewable file is a markdown file that the PR still contains: files the
// PR *removes* are excluded (you cannot review a file that won't exist on the
// branch), and non-markdown files are not part of a markdown review.
//
// This is a pure function over the PR's file list so the rule can be asserted
// directly, independent of how files are fetched or paginated.
function selectReviewableFiles(prFiles) {
  return (prFiles || []).filter(
    (f) => typeof f.filename === 'string' && f.filename.endsWith('.md') && f.status !== 'removed'
  );
}

module.exports = { selectReviewableFiles };
