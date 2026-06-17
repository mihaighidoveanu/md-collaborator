// A fake implementation of the GitHub adapter interface used by the routes.
//
// It is configured with in-memory fixtures and records the calls that have
// side effects (commits), so tests can assert observable outcomes — what got
// committed, how many commits — without any network access. The fake speaks
// the same contract the real adapter exports, so swapping it in
// requires no change to the routes under test.
//
// Note: getPRFiles returns the *reviewable* set (already markdown, non-deleted),
// matching the real adapter's contract. The raw markdown-filtering rule is
// covered separately as a pure unit test against lib/files.js.
const { selectReviewableFiles } = require('../../server/lib/files');

function createFakeGithub(config = {}) {
  const prs = config.prs || {};        // key `${owner}/${repo}#${number}` -> { state, title, head:{ref,sha}, files, contents }
  const calls = {
    getPR: [], getPRFiles: [], getFileContent: [], commitChanges: [], getCurrentHeadSha: [],
    createBranch: [], createPullRequest: [],
  };
  // headShas lets a test simulate the branch advancing after session creation.
  const headShas = config.headShas || {}; // key `${owner}/${repo}@${branch}` -> sha
  const existingBranches = new Set(config.existingBranches || []); // simulate name collisions
  const contentOverrides = {}; // path -> content; test-only, simulates upstream change

  function key(owner, repo, number) { return `${owner}/${repo}#${number}`; }
  function pr(owner, repo, number) {
    const p = prs[key(owner, repo, number)];
    if (!p) { const e = new Error('Not Found'); e.status = 404; throw e; }
    return p;
  }

  return {
    async getPR(owner, repo, number) {
      calls.getPR.push({ owner, repo, number });
      const p = pr(owner, repo, number);
      return { state: p.state, title: p.title, head: p.head };
    },

    async getPRFiles(owner, repo, number) {
      calls.getPRFiles.push({ owner, repo, number });
      // Mirror the real adapter: return only the reviewable (markdown, non-deleted) set.
      return selectReviewableFiles((pr(owner, repo, number).files || []).map(f => ({ filename: f.filename, status: f.status })));
    },

    async getFileContent(owner, repo, filePath /* , ref */) {
      calls.getFileContent.push({ owner, repo, filePath });
      // A test-set override simulates upstream content moving after the session
      // was created (the ref is otherwise ignored by this fake).
      if (Object.prototype.hasOwnProperty.call(contentOverrides, filePath)) {
        return contentOverrides[filePath];
      }
      // contents are looked up across the configured PRs by path; tests keep paths unique enough.
      for (const k of Object.keys(prs)) {
        const c = prs[k].contents || {};
        if (Object.prototype.hasOwnProperty.call(c, filePath)) return c[filePath];
      }
      return null;
    },
    async getCurrentHeadSha(owner, repo, branch) {
      calls.getCurrentHeadSha.push({ owner, repo, branch });
      // Simulate a transient blip: throw on the first N calls, then recover.
      if (config.headShaFailTimes && calls.getCurrentHeadSha.length <= config.headShaFailTimes) {
        throw new Error('transient: could not resolve ref');
      }
      const override = headShas[`${owner}/${repo}@${branch}`];
      if (override !== undefined) return override;
      // Default: branch unchanged — return the sha of whichever PR uses this branch.
      for (const k of Object.keys(prs)) {
        if (prs[k].head && prs[k].head.ref === branch) return prs[k].head.sha;
      }
      return 'unknown-sha';
    },

    async commitChanges(owner, repo, branch, headSha, editedFiles) {
      if (config.commitShouldFail) throw new Error('GitHub commit failed');
      const sha = 'commit-' + (calls.commitChanges.length + 1);
      calls.commitChanges.push({ owner, repo, branch, headSha, editedFiles, sha });
      return sha;
    },

    async createBranch(owner, repo, branchName, fromSha) {
      if (config.submitShouldFail) throw new Error('GitHub branch creation failed');
      let name = branchName;
      let attempt = 1;
      while (existingBranches.has(name) && attempt < 20) {
        attempt += 1;
        name = `${branchName}-${attempt}`;
      }
      existingBranches.add(name);
      calls.createBranch.push({ owner, repo, branchName: name, fromSha });
      return name;
    },

    async createPullRequest(owner, repo, head, base, title, body) {
      if (config.submitShouldFail) throw new Error('GitHub PR creation failed');
      const number = 1000 + calls.createPullRequest.length;
      const html_url = `https://github.com/${owner}/${repo}/pull/${number}`;
      calls.createPullRequest.push({ owner, repo, head, base, title, body, number, html_url });
      return { number, html_url };
    },

    // Test-only accessors
    calls,
    // Test-only: simulate a new upstream commit landing on a branch. Advances
    // the branch head AND changes file content together — the real-world
    // invariant (content cannot change without a new commit), which the route's
    // head-SHA fast path relies on.
    pushCommit(owner, repo, branch, newSha, fileChanges = {}) {
      headShas[`${owner}/${repo}@${branch}`] = newSha;
      for (const [filePath, content] of Object.entries(fileChanges)) {
        contentOverrides[filePath] = content;
      }
    },
  };
}

module.exports = { createFakeGithub };
