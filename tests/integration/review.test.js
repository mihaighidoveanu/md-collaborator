const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../helpers/server');
const { createFakeGithub } = require('../helpers/fakeGithub');

// Build a fake configured with one open PR plus a session row already pointing
// at it, returning everything a review-flow test needs.
async function setup({
  files, contents, status = 'active', headShas, commitShouldFail, submitShouldFail,
  prShouldFail, approveShouldFail, headShaFailTimes, existingBranches, extraPrs, submitted,
} = {}) {
  files = files || [
    { filename: 'docs/intro.md', status: 'modified' },
    { filename: 'README.md', status: 'added' },
  ];
  contents = contents || { 'docs/intro.md': '# Intro\nhello\n', 'README.md': '# Readme\n' };
  const github = createFakeGithub({
    prs: {
      'acme/docs#1': { state: 'open', title: 'Docs', head: { ref: 'feature', sha: 'sha-1' }, base: { ref: 'main' }, files, contents },
      ...(extraPrs || {}),
    },
    headShas,
    commitShouldFail,
    submitShouldFail,
    prShouldFail,
    approveShouldFail,
    headShaFailTimes,
    existingBranches,
  });
  const ctx = await startTestServer({ github });
  const session = ctx.seedSession({
    owner: 'acme', repo: 'docs', pr_number: 1, head_branch: 'feature', head_sha: 'sha-1', status,
    ...(submitted || {}),
  });
  return { ctx, github, session };
}

let active;
afterEach(async () => { if (active) await active.ctx.close(); active = null; });

const filePath = (p) => encodeURIComponent(p);

// REQ-6 — A reviewer can read the files under review.

test('R6.1 with a valid link, the reviewer sees the file list and each file\'s content', async () => {
  active = await setup();
  const { ctx, session } = active;

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.status, 200);
  assert.deepEqual(meta.json.files.map(f => f.path).sort(), ['README.md', 'docs/intro.md']);

  const file = await ctx.request('GET', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`);
  assert.equal(file.status, 200);
  assert.equal(file.json.content, '# Intro\nhello\n');
});

test('R6.2 a reviewer who edited a file sees their own latest version, not the stale original', async () => {
  active = await setup();
  const { ctx, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited by reviewer\n', originalContent: '# Intro\nhello\n' } });

  const file = await ctx.request('GET', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`);
  assert.equal(file.json.content, '# Intro\nedited by reviewer\n');
  assert.equal(file.json.source, 'edit');
});

test('R6.3 a request for a file outside the session\'s file set is refused', async () => {
  active = await setup();
  const { ctx, session } = active;

  const res = await ctx.request('GET', `/review/api/${session.token}/files/${filePath('secrets/private.md')}`);
  assert.equal(res.status, 404, 'a file not in the review set is refused');
});

// REQ-3 (integration) — none of a large PR's markdown is silently dropped.

test('R3.3 every markdown file of a large PR appears in the session', async () => {
  const files = [];
  const contents = {};
  for (let i = 0; i < 120; i++) {
    files.push({ filename: `docs/file-${i}.md`, status: 'modified' });
    contents[`docs/file-${i}.md`] = `# File ${i}\n`;
    files.push({ filename: `assets/img-${i}.png`, status: 'added' });
  }
  active = await setup({ files, contents });
  const { ctx, session } = active;
  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.files.length, 120);
});

// REQ-7 — A reviewer's edits are saved and durable.

test('R7.2 the pre-edit baseline is remembered from the first save onward', async () => {
  // The baseline determines diff reconstruction. We prove it is fixed at the
  // first save by observing the committed line-ending style: the first save
  // supplies a CRLF original; a later save supplies an LF original. If the
  // baseline were overwritten, the commit would come out LF.
  active = await setup({ contents: { 'docs/intro.md': 'a\r\nb\r\n' } });
  const { ctx, github, session } = active;
  const p = filePath('docs/intro.md');

  await ctx.request('PUT', `/review/api/${session.token}/files/${p}`,
    { body: { content: 'a\r\nB\r\n', originalContent: 'a\r\nb\r\n' } });
  await ctx.request('PUT', `/review/api/${session.token}/files/${p}`,
    { body: { content: 'a\nB\n', originalContent: 'a\nb\n' } }); // later save, LF baseline

  const submit = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(submit.status, 200);

  const committed = github.calls.commitChanges[0].editedFiles.find(f => f.filePath === 'docs/intro.md');
  assert.ok(committed.content.includes('\r\n'), 'baseline from the first save (CRLF) is preserved');
});

// REQ-8 — Progress tracking.

test('R8.1 opening a file marks it as reviewed', async () => {
  active = await setup();
  const { ctx, session } = active;

  let meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.files.find(f => f.path === 'docs/intro.md').visited, false);

  await ctx.request('GET', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`);

  meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.files.find(f => f.path === 'docs/intro.md').visited, true);
});

// REQ-15 — Change awareness: the reviewer sees what moved upstream since last look.

test('R15.1 a file whose upstream is unchanged opens as a plain view, without re-fetching', async () => {
  active = await setup();
  const { ctx, github, session } = active;
  const p = filePath('docs/intro.md');

  const first = await ctx.request('GET', `/review/api/${session.token}/files/${p}`);
  assert.equal(first.json.view, 'plain');
  const fetchesAfterFirst = github.calls.getFileContent.length;

  const second = await ctx.request('GET', `/review/api/${session.token}/files/${p}`);
  assert.equal(second.json.view, 'plain', 'still plain when nothing moved');
  assert.equal(second.json.content, '# Intro\nhello\n', 'serves the cached content');
  // The branch head has not moved, so the cached content is served without
  // another GitHub content fetch (head-SHA fast path).
  assert.equal(github.calls.getFileContent.length, fetchesAfterFirst, 'no redundant content fetch');
});

test('R15.2 after the reviewer has seen a file, an upstream change opens a two-way diff', async () => {
  active = await setup();
  const { ctx, github, session } = active;
  const p = filePath('docs/intro.md');

  // First look establishes the "seen" watermark.
  const first = await ctx.request('GET', `/review/api/${session.token}/files/${p}`);
  assert.equal(first.json.view, 'plain');

  // A new commit lands upstream: head advances and the file content changes.
  github.pushCommit('acme', 'docs', 'feature', 'sha-2-newer', { 'docs/intro.md': '# Intro\nhello, updated\n' });

  const changed = await ctx.request('GET', `/review/api/${session.token}/files/${p}`);
  assert.equal(changed.json.view, 'two_way', 'a moved file opens as a diff');
  assert.equal(changed.json.seen, '# Intro\nhello\n', 'the diff baseline is what was last seen');
  assert.equal(changed.json.upstream, '# Intro\nhello, updated\n', 'the diff target is the new upstream');
  assert.ok(
    Array.isArray(changed.json.diff) && changed.json.diff.some(r => r.type === 'add' && /updated/.test(r.text)),
    'the diff carries the new line'
  );

  // Re-opening with no further change settles back to plain (watermark advanced).
  const settled = await ctx.request('GET', `/review/api/${session.token}/files/${p}`);
  assert.equal(settled.json.view, 'plain', 'watermark advanced to the new upstream');
});

// REQ-16 — Three-way reconciliation: edited file + drifted upstream.

test('R16.1 an edited file whose upstream drifted opens a three-way view with the clash flagged', async () => {
  active = await setup({ contents: { 'docs/intro.md': '# Title\nline a\nline b\n', 'README.md': '# Readme\n' } });
  const { ctx, github, session } = active;
  const p = filePath('docs/intro.md');

  // The reviewer edits line a.
  await ctx.request('PUT', `/review/api/${session.token}/files/${p}`,
    { body: { content: '# Title\nline a MINE\nline b\n', originalContent: '# Title\nline a\nline b\n' } });

  // The author pushes a different edit to the same line upstream.
  github.pushCommit('acme', 'docs', 'feature', 'sha-2-newer', { 'docs/intro.md': '# Title\nline a UPSTREAM\nline b\n' });

  const res = await ctx.request('GET', `/review/api/${session.token}/files/${p}`);
  assert.equal(res.json.view, 'three_way');
  assert.equal(res.json.base, '# Title\nline a\nline b\n', 'the baseline the reviewer started from');
  assert.equal(res.json.upstream, '# Title\nline a UPSTREAM\nline b\n', 'the current upstream');
  assert.equal(res.json.mine, '# Title\nline a MINE\nline b\n', 'the reviewer\'s unsent edit');

  const conflictRow = res.json.diff.find(r => r.conflict);
  assert.ok(conflictRow, 'the line both sides changed is flagged as a conflict');
  assert.equal(conflictRow.base, 'line a');
  assert.equal(conflictRow.upstream, 'line a UPSTREAM');
  assert.equal(conflictRow.mine, 'line a MINE');
});

test('R16.2 non-overlapping edits open three-way with no conflict', async () => {
  active = await setup({ contents: { 'docs/intro.md': '# Title\nline a\nline b\n', 'README.md': '# Readme\n' } });
  const { ctx, github, session } = active;
  const p = filePath('docs/intro.md');

  // Reviewer changes line a; author changes line b.
  await ctx.request('PUT', `/review/api/${session.token}/files/${p}`,
    { body: { content: '# Title\nline a MINE\nline b\n', originalContent: '# Title\nline a\nline b\n' } });
  github.pushCommit('acme', 'docs', 'feature', 'sha-2-newer', { 'docs/intro.md': '# Title\nline a\nline b UPSTREAM\n' });

  const res = await ctx.request('GET', `/review/api/${session.token}/files/${p}`);
  assert.equal(res.json.view, 'three_way');
  assert.ok(res.json.diff.every(r => !r.conflict), 'no row is a conflict');
  assert.ok(res.json.diff.some(r => r.base === 'line a' && r.mineChanged && !r.upstreamChanged), 'reviewer change on line a');
  assert.ok(res.json.diff.some(r => r.base === 'line b' && r.upstreamChanged && !r.mineChanged), 'author change on line b');
});

test('R16.3 an edited file whose upstream has not moved stays a plain view (no needless fetch)', async () => {
  active = await setup();
  const { ctx, github, session } = active;
  const p = filePath('docs/intro.md');

  await ctx.request('PUT', `/review/api/${session.token}/files/${p}`,
    { body: { content: '# Intro\nmine\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('GET', `/review/api/${session.token}/files/${p}`);
  assert.equal(res.json.view, 'plain', 'no upstream drift, so no reconciliation');
  assert.equal(res.json.content, '# Intro\nmine\n', 'the reviewer sees their edit');
  // base_sha matches the live head, so the edit needs no upstream comparison.
  assert.equal(github.calls.getFileContent.length, 0, 'no content fetch needed');
});

// REQ-9 — Submission: approve when there are no pending edits, or commit (and
// open/reuse a PR) when there are.

test('R9.1 submitting with edits commits directly onto the original PR\'s head branch; the session stays active', async () => {
  active = await setup();
  const { ctx, github, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 200);
  assert.equal(res.json.action, 'submitted');
  assert.equal(github.calls.createBranch.length, 0, 'no new branch — the original PR is still open');
  assert.equal(github.calls.createPullRequest.length, 0, 'no new PR — the original PR is still open');
  assert.equal(github.calls.commitChanges.length, 1, 'one commit was written');
  assert.equal(github.calls.commitChanges[0].branch, 'feature', 'commit lands directly on the PR\'s own head branch');
  assert.equal(github.calls.commitChanges[0].headSha, 'sha-1', 'commit is off the branch\'s live head');

  assert.equal(res.json.pr_number, session.pr_number, 'the original PR is reported as the current PR');
  assert.equal(res.json.pr_url, `https://github.com/acme/docs/pull/${session.pr_number}`);
  assert.equal(res.json.branch, 'feature');

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'active', 'the session is never locked by submitting');

  // No fallback branch/PR was opened, so submitted_* stay null — the current
  // PR is still computed as the original PR.
  const row = ctx.db.prepare('SELECT submitted_pr_number, submitted_branch FROM sessions WHERE id = ?').get(session.id);
  assert.equal(row.submitted_pr_number, null, 'no fallback PR was opened');
  assert.equal(row.submitted_branch, null, 'no fallback branch was opened');

  // The business can keep editing after a submit (D4) — no terminal lock.
  const again = await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited again\n', originalContent: '# Intro\nhello\n' } });
  assert.equal(again.status, 200, 'editing after a submit is still allowed');
});

test('R9.2 several edited files are delivered as one commit, not many', async () => {
  active = await setup();
  const { ctx, github, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nx\n', originalContent: '# Intro\nhello\n' } });
  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('README.md')}`,
    { body: { content: '# Readme edited\n', originalContent: '# Readme\n' } });

  await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(github.calls.commitChanges.length, 1, 'exactly one commit');
  assert.equal(github.calls.commitChanges[0].editedFiles.length, 2, 'both files in that one commit');
  assert.equal(github.calls.createBranch.length, 0, 'no branch needed for an open PR');
  assert.equal(github.calls.createPullRequest.length, 0, 'no PR needed for an open PR');
});

test('R9.3 submitting with no pending edits approves the original PR, opening no branch or PR', async () => {
  active = await setup();
  const { ctx, github, session } = active;

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 200, 'submission succeeds with no edits');
  assert.equal(res.json.action, 'approved', 'no pending edits approves rather than commits');
  assert.equal(github.calls.approvePullRequest.length, 1, 'one approval was posted');
  assert.equal(github.calls.approvePullRequest[0].number, session.pr_number, 'approval targets the original PR');
  assert.equal(github.calls.createBranch.length, 0, 'no branch created');
  assert.equal(github.calls.commitChanges.length, 0, 'nothing is committed');
  assert.equal(github.calls.createPullRequest.length, 0, 'no PR opened');

  const row = ctx.db.prepare('SELECT approved_at FROM sessions WHERE id = ?').get(session.id);
  assert.ok(row.approved_at, 'approved_at is recorded');

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'active', 'the session is never locked');
  assert.equal(meta.json.settled, true, 'nothing has moved upstream since the approval');

  // The business can subsequently edit and submit changes after an approval.
  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited after approval\n', originalContent: '# Intro\nhello\n' } });
  const res2 = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res2.json.action, 'submitted', 'a later edit can still be submitted');
});

// REQ-11 — Submission never overwrites newer work on the branch.

test('R11.1 if the branch advanced, submission succeeds off the live head SHA', async () => {
  active = await setup({ headShas: { 'acme/docs@feature': 'sha-2-newer' } });
  const { ctx, github, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 200, 'submission is not refused on an advanced branch');
  // Commit straight onto the PR's own branch, off the live head, never the
  // stale session SHA — no branch is created for an open current PR.
  assert.equal(github.calls.createBranch.length, 0, 'no branch is created for an open current PR');
  assert.equal(github.calls.commitChanges[0].branch, 'feature');
  assert.equal(github.calls.commitChanges[0].headSha, 'sha-2-newer', 'commit parents the live head');

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'active', 'the session stays active after submitting');
});

test('R11.2 if the commit to GitHub fails, the session stays open and no branch needs cleanup', async () => {
  active = await setup({ commitShouldFail: true });
  const { ctx, github, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 500, 'a commit failure surfaces as an error');

  // No branch was created (the commit targets the open original PR's own
  // branch directly), so there is nothing to clean up.
  assert.equal(github.calls.createBranch.length, 0);
  assert.equal(github.calls.deleteBranch.length, 0, 'no branch was created in this call');

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'active', 'session is not left half-submitted');
});

// R11.3 / R11.4b now exercise the merge/close FALLBACK exclusively — a new
// branch + PR is only ever created once the current PR is no longer open.

test('R11.3 if the fallback branch creation fails, the session stays open', async () => {
  active = await setup({ submitShouldFail: true });
  const { ctx, github, session } = active;
  github.mergePr('acme', 'docs', session.pr_number, { deleteBranch: false });

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 500, 'a branch-creation failure surfaces as an error');
  assert.equal(github.calls.commitChanges.length, 0, 'nothing was committed');
  assert.equal(github.calls.deleteBranch.length, 0, 'no branch exists yet to clean up');

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'active', 'session is not left half-submitted');
});

test('R11.4b if opening the fallback PR fails, the newly created branch (with its commit) is cleaned up', async () => {
  active = await setup({ prShouldFail: true });
  const { ctx, github, session } = active;
  github.mergePr('acme', 'docs', session.pr_number, { deleteBranch: false });

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 500, 'a PR-creation failure surfaces as an error');
  assert.equal(github.calls.createBranch.length, 1, 'a fallback branch was created');
  assert.equal(github.calls.commitChanges.length, 1, 'the commit happened');
  assert.equal(github.calls.deleteBranch.length, 1, 'the orphaned branch is cleaned up');
  assert.equal(github.calls.deleteBranch[0].branch, github.calls.createBranch[0].branchName);

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'active', 'session is not left half-submitted');
});

test('R11.4 a transient blip resolving the live head is retried, and submission still succeeds', async () => {
  active = await setup({ headShaFailTimes: 2 });
  const { ctx, github, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 200, 'submission recovers after the read blip clears');
  assert.ok(github.calls.getCurrentHeadSha.length >= 3, 'the read was retried past the failures');
  assert.equal(github.calls.commitChanges.length, 1, 'the commit succeeds once the read recovers');
  assert.equal(github.calls.createPullRequest.length, 0, 'no PR is opened against an open current PR');

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'active', 'the session stays active after submitting');
});

// REQ-18 — Re-submission reuses the CURRENT PR — the original developer PR
// while it stays open, or its merge/close fallback successor — per the
// matrix in functional-spec.md §2.1, instead of spawning a new pair every
// time.

test('R18.1 re-submitting while the original PR stays open keeps committing straight onto its head branch', async () => {
  active = await setup();
  const { ctx, github, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nfirst round\n', originalContent: '# Intro\nhello\n' } });
  const first = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(first.status, 200);

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nsecond round\n', originalContent: '# Intro\nhello\n' } });
  const second = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(second.status, 200);

  assert.equal(github.calls.createBranch.length, 0, 'never a new branch while the original PR is open');
  assert.equal(github.calls.createPullRequest.length, 0, 'never a new PR while the original PR is open');
  assert.equal(github.calls.commitChanges.length, 2, 'two separate commits, both onto the PR\'s own branch');
  assert.equal(github.calls.commitChanges[0].branch, 'feature');
  assert.equal(github.calls.commitChanges[1].branch, 'feature');
  assert.equal(first.json.pr_number, session.pr_number, 'the original PR stays current');
  assert.equal(second.json.pr_number, session.pr_number, 'the original PR stays current');
});

test('R18.2 re-submit after the original PR merges opens a fallback branch off its own base branch and a new PR', async () => {
  active = await setup({ headShas: { 'acme/docs@main': 'sha-main' } });
  const { ctx, github, session } = active;
  github.mergePr('acme', 'docs', session.pr_number, { deleteBranch: false });

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nfallback round\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 200);
  assert.equal(github.calls.createBranch.length, 1, 'a fallback branch is created');
  assert.equal(github.calls.createBranch[0].fromSha, 'sha-main', 'branched off the original PR\'s own base branch live head');
  const newBranch = github.calls.createBranch[0].branchName;
  assert.notEqual(newBranch, 'feature', 'not the (now-merged) PR head branch');

  assert.equal(github.calls.commitChanges.length, 1);
  assert.equal(github.calls.commitChanges[0].branch, newBranch, 'commit lands on the fallback branch');

  assert.equal(github.calls.createPullRequest.length, 1, 'a new PR is opened since the original merged');
  assert.equal(github.calls.createPullRequest[0].head, newBranch);
  assert.equal(github.calls.createPullRequest[0].base, 'main', 'the new PR targets the original PR\'s own base branch');

  const newPrNumber = github.calls.createPullRequest[0].number;
  assert.equal(res.json.pr_number, newPrNumber);

  const row = ctx.db.prepare('SELECT submitted_pr_number, submitted_branch FROM sessions WHERE id = ?').get(session.id);
  assert.equal(row.submitted_pr_number, newPrNumber, 'the new PR becomes the current PR');
  assert.equal(row.submitted_branch, newBranch, 'the new branch is recorded as current');

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'active');
});

test('R18.3 once the fallback PR is open, a further re-submit reuses it (no second fallback)', async () => {
  active = await setup({ headShas: { 'acme/docs@main': 'sha-main' } });
  const { ctx, github, session } = active;
  github.mergePr('acme', 'docs', session.pr_number, { deleteBranch: false });

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nfallback round\n', originalContent: '# Intro\nhello\n' } });
  await ctx.request('POST', `/review/api/${session.token}/submit`); // opens the fallback branch + PR

  const newBranch = github.calls.createBranch[0].branchName;
  const newPrNumber = github.calls.createPullRequest[0].number;

  // A further edit while the fallback PR is still open.
  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nsecond fallback round\n', originalContent: '# Intro\nhello\n' } });
  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);

  assert.equal(res.status, 200);
  assert.equal(github.calls.createBranch.length, 1, 'no second fallback branch is created');
  assert.equal(github.calls.createPullRequest.length, 1, 'no second fallback PR is opened');
  assert.equal(github.calls.commitChanges.length, 2, 'a second commit lands on the same fallback branch');
  assert.equal(github.calls.commitChanges[1].branch, newBranch, 'commit lands on the existing fallback branch');
  assert.equal(res.json.pr_number, newPrNumber, 'the existing fallback PR is reused');
});

test('R18.4 the fallback succeeds and tracks the new branch even after the original head branch is deleted on merge', async () => {
  active = await setup({ headShas: { 'acme/docs@main': 'sha-main' } });
  const { ctx, github, session } = active;
  // The original PR merges AND GitHub deletes its head branch ("feature" is gone).
  github.mergePr('acme', 'docs', session.pr_number, { deleteBranch: true });

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nfallback round\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 200, 'the fallback does not blow up reading the now-deleted head branch');

  const newBranch = github.calls.createBranch[0].branchName;
  const newCommitSha = github.calls.commitChanges[0].sha;
  assert.equal(github.calls.createBranch[0].fromSha, 'sha-main', 'branched off the base it merged into');

  // The baseline advances to the fallback commit (on the new branch), not to a
  // stale read of the deleted head branch.
  const row = ctx.db.prepare('SELECT base_sha, dirty FROM file_edits WHERE session_id = ? AND file_path = ?')
    .get(session.id, 'docs/intro.md');
  assert.equal(row.dirty, 0, 'the committed file is clean again');
  assert.equal(row.base_sha, newCommitSha, 'baseline tracks the new branch, not the deleted head branch');

  // Reopening reads the new current branch and shows the committed edit as plain.
  const view = await ctx.request('GET', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`);
  assert.equal(view.json.view, 'plain', 'no phantom drift against the gone branch');
  assert.equal(view.json.content, '# Intro\nfallback round\n');

  // "settled" reads the new branch too, so a meta fetch does not error out.
  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'active');
  assert.equal(meta.json.settled, true, 'settled pins to the new branch head, which has not moved');
});

test('R18.5 if the current branch is deleted while the PR still reads open, submit falls back to a new branch + PR', async () => {
  active = await setup({ headShas: { 'acme/docs@main': 'sha-main' } });
  const { ctx, github, session } = active;
  // The PR is still "open" (not merged/closed) but its head branch vanished —
  // deleted in the meantime, or eventual consistency right after a merge.
  github.removeBranch('acme', 'docs', 'feature');

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 200, 'a gone branch falls back instead of erroring');

  // No commit was attempted onto the dead branch; a fresh branch off the base
  // was created and a new PR opened.
  assert.equal(github.calls.createBranch.length, 1, 'a fallback branch is created');
  assert.equal(github.calls.createBranch[0].fromSha, 'sha-main', 'branched off the PR base, not the dead branch');
  const newBranch = github.calls.createBranch[0].branchName;
  assert.equal(github.calls.commitChanges.length, 1, 'exactly one commit, onto the new branch');
  assert.equal(github.calls.commitChanges[0].branch, newBranch);
  assert.notEqual(newBranch, 'feature');
  assert.equal(github.calls.createPullRequest.length, 1, 'a new PR is opened');
  assert.equal(github.calls.createPullRequest[0].base, 'main');

  const row = ctx.db.prepare('SELECT submitted_branch, submitted_pr_number FROM sessions WHERE id = ?').get(session.id);
  assert.equal(row.submitted_branch, newBranch, 'the new branch becomes current');
  assert.equal(row.submitted_pr_number, github.calls.createPullRequest[0].number);

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'active', 'session is never left half-submitted');
});

test('R18.6 a transient blip checking the current branch is retried, not mistaken for a deleted branch', async () => {
  // The branch-existence probe blips once; withRetry must recover and treat the
  // branch as present, committing onto the open PR rather than forcing a fallback.
  active = await setup({ branchExistsFailTimes: 1 });
  const { ctx, github, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 200, 'a transient read blip recovers rather than forcing a fallback');
  assert.equal(github.calls.createBranch.length, 0, 'no spurious fallback branch from a blip');
  assert.equal(github.calls.commitChanges[0].branch, 'feature', 'still commits onto the open PR branch');
});

// REQ-19 — "Approve" posts a GitHub review on the original PR (D1).

test('R19.1 a failed approval leaves the session unchanged', async () => {
  active = await setup({ approveShouldFail: true });
  const { ctx, session } = active;

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 500);

  const row = ctx.db.prepare('SELECT approved_at FROM sessions WHERE id = ?').get(session.id);
  assert.equal(row.approved_at, null, 'no approval was recorded');

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'active', 'the session is unaffected by the failed approval');
});

// REQ-20 — A successful commit-submit advances the dirty baseline (D3), and a
// reused-branch commit failure never deletes the branch it did not create (D5).

test('R20.1 after a commit-submit, committed files are no longer dirty and the next no-edit submit approves', async () => {
  active = await setup();
  const { ctx, github, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });
  await ctx.request('POST', `/review/api/${session.token}/submit`);

  const row = ctx.db.prepare('SELECT dirty, original_content, content FROM file_edits WHERE session_id = ? AND file_path = ?')
    .get(session.id, 'docs/intro.md');
  assert.equal(row.dirty, 0, 'the committed file is no longer dirty');
  assert.equal(row.original_content, row.content, 'the baseline advances to the committed content');

  // The next submit with no further edits approves rather than re-committing.
  const res2 = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res2.json.action, 'approved');
  assert.equal(github.calls.commitChanges.length, 1, 'still just the one commit from before');
});

test('after a commit-submit, re-opening the file with no further edits stays plain', async () => {
  const p = filePath('docs/intro.md');

  // The baseline must be recomputed from the branch that actually received
  // the commit, so re-reading must not compare it against stale, unrelated
  // old content and report a fake conflict.

  active = await setup();
  await active.ctx.request('PUT', `/review/api/${active.session.token}/files/${p}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });
  await active.ctx.request('POST', `/review/api/${active.session.token}/submit`);
  const res = await active.ctx.request('GET', `/review/api/${active.session.token}/files/${p}`);
  assert.equal(res.json.view, 'plain', 'first submit: the committed baseline does not look drifted against itself');
  assert.equal(res.json.content, '# Intro\nedited\n');
});

test('after a commit-submit, a later real upstream move is still detected as drift', async () => {
  active = await setup();
  const { ctx, github, session } = active;
  const p = filePath('docs/intro.md');

  await ctx.request('PUT', `/review/api/${session.token}/files/${p}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });
  await ctx.request('POST', `/review/api/${session.token}/submit`);

  // The developer pushes a real change to the original PR branch afterward.
  github.pushCommit('acme', 'docs', 'feature', 'sha-after-submit', { 'docs/intro.md': '# Intro\ndeveloper change\n' });

  const res = await ctx.request('GET', `/review/api/${session.token}/files/${p}`);
  assert.equal(res.json.view, 'three_way', 'a genuine upstream move after the commit is still reconciled, not masked');
  assert.equal(res.json.upstream, '# Intro\ndeveloper change\n');
});

// "Settled": the submit button disables ("No pending changes") only once the
// reviewer's last action (approve or commit-submit) still matches the current
// state of the target branch — re-enabling the moment anything moves upstream.

test('a session that has never been acted on is not settled', async () => {
  active = await setup();
  const { ctx, session } = active;

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.settled, false);
});

test('settled after a commit-submit with no further upstream movement', async () => {
  active = await setup();
  const { ctx, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });
  await ctx.request('POST', `/review/api/${session.token}/submit`);

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.settled, true, 'nothing has moved upstream since this commit-submit');
});

test('no longer settled once the target branch moves after a commit-submit', async () => {
  active = await setup();
  const { ctx, github, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });
  await ctx.request('POST', `/review/api/${session.token}/submit`);

  github.pushCommit('acme', 'docs', 'feature', 'sha-after-submit', { 'docs/intro.md': '# Intro\ndeveloper change\n' });

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.settled, false, 'the target branch moved since the last action — there is something new to look at');
});

test('no longer settled once the target branch moves after an approval', async () => {
  active = await setup();
  const { ctx, github, session } = active;

  await ctx.request('POST', `/review/api/${session.token}/submit`); // no pending edits -> approve
  github.pushCommit('acme', 'docs', 'feature', 'sha-after-approve', { 'docs/intro.md': '# Intro\ndeveloper change\n' });

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.settled, false, 'the target branch moved since the approval');
});

// REQ-13 — A revoked link grants no access.

test('R13.1 a revoked link cannot read, edit, or submit', async () => {
  active = await setup({ status: 'revoked' });
  const { ctx, session } = active;

  assert.equal((await ctx.request('GET', `/review/api/${session.token}`)).status, 403, 'cannot read');
  assert.equal((await ctx.request('GET', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`)).status, 403, 'cannot read file');
  assert.equal((await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`, { body: { content: 'x', originalContent: 'y' } })).status, 403, 'cannot edit');
  assert.equal((await ctx.request('POST', `/review/api/${session.token}/submit`)).status, 403, 'cannot submit');
});

// REQ-17 — A reviewer can leave explanatory comments, anchored or free.

test('R17.1 anchored and free comments are created and listed', async () => {
  active = await setup();
  const { ctx, session } = active;

  const anchored = await ctx.request('POST', `/review/api/${session.token}/comments`,
    { body: { file_path: 'docs/intro.md', paragraph_index: 2, anchor_text: 'hello', body: 'Please clarify this.' } });
  assert.equal(anchored.status, 200);
  assert.equal(anchored.json.anchor_text, 'hello');
  assert.equal(anchored.json.paragraph_index, 2);
  assert.equal(anchored.json.file_path, 'docs/intro.md');
  assert.equal(anchored.json.resolved, 0);

  const free = await ctx.request('POST', `/review/api/${session.token}/comments`, { body: { body: 'General note.' } });
  assert.equal(free.status, 200);
  assert.equal(free.json.file_path, null, 'a free comment has no file');
  assert.equal(free.json.anchor_text, null, 'a free comment has no anchor');

  const list = await ctx.request('GET', `/review/api/${session.token}/comments`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.map(c => c.body), ['Please clarify this.', 'General note.']);
});

test('R17.2 a comment requires a body; it can be resolved and deleted', async () => {
  active = await setup();
  const { ctx, session } = active;

  const blank = await ctx.request('POST', `/review/api/${session.token}/comments`, { body: { body: '   ' } });
  assert.equal(blank.status, 400, 'a blank body is refused');

  const c = await ctx.request('POST', `/review/api/${session.token}/comments`, { body: { body: 'note' } });
  const id = c.json.id;

  assert.equal((await ctx.request('PATCH', `/review/api/${session.token}/comments/${id}`, { body: { resolved: true } })).status, 200);
  let list = await ctx.request('GET', `/review/api/${session.token}/comments`);
  assert.equal(list.json[0].resolved, 1, 'comment is marked resolved');

  assert.equal((await ctx.request('DELETE', `/review/api/${session.token}/comments/${id}`)).status, 200);
  list = await ctx.request('GET', `/review/api/${session.token}/comments`);
  assert.equal(list.json.length, 0, 'comment is gone');
});

test('R17.3 comments are scoped to their session', async () => {
  active = await setup();
  const { ctx, session } = active;
  const other = ctx.seedSession({ owner: 'acme', repo: 'docs', pr_number: 1, head_branch: 'feature', head_sha: 'sha-1' });

  const c = await ctx.request('POST', `/review/api/${session.token}/comments`, { body: { body: 'mine' } });
  const id = c.json.id;

  const otherList = await ctx.request('GET', `/review/api/${other.token}/comments`);
  assert.equal(otherList.json.length, 0, 'not listed under another session');
  assert.equal((await ctx.request('PATCH', `/review/api/${other.token}/comments/${id}`, { body: { resolved: true } })).status, 404, 'cannot resolve another session\'s comment');
  assert.equal((await ctx.request('DELETE', `/review/api/${other.token}/comments/${id}`)).status, 404, 'cannot delete another session\'s comment');
});

