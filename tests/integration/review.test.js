const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../helpers/server');
const { createFakeGithub } = require('../helpers/fakeGithub');

// Build a fake configured with one open PR plus a session row already pointing
// at it, returning everything a review-flow test needs.
async function setup({ files, contents, status = 'active', headShas, commitShouldFail, submitShouldFail, prShouldFail, headShaFailTimes } = {}) {
  files = files || [
    { filename: 'docs/intro.md', status: 'modified' },
    { filename: 'README.md', status: 'added' },
  ];
  contents = contents || { 'docs/intro.md': '# Intro\nhello\n', 'README.md': '# Readme\n' };
  const github = createFakeGithub({
    prs: {
      'acme/docs#1': { state: 'open', title: 'Docs', head: { ref: 'feature', sha: 'sha-1' }, files, contents },
    },
    headShas,
    commitShouldFail,
    submitShouldFail,
    prShouldFail,
    headShaFailTimes,
  });
  const ctx = await startTestServer({ github });
  const session = ctx.seedSession({ owner: 'acme', repo: 'docs', pr_number: 1, head_branch: 'feature', head_sha: 'sha-1', status });
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

// REQ-9 — Submission opens a PR and closes the session.

test('R9.1 submitting with edits opens one branch, one commit, and one PR; session is submitted', async () => {
  active = await setup();
  const { ctx, github, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 200);
  assert.equal(github.calls.createBranch.length, 1, 'one new branch was created');
  assert.equal(github.calls.commitChanges.length, 1, 'one commit was written');
  assert.equal(github.calls.createPullRequest.length, 1, 'one PR was opened');

  // The reviewer never writes to the PR's own branch.
  const newBranch = github.calls.createBranch[0].branchName;
  assert.notEqual(newBranch, 'feature', 'a fresh branch, not the PR head branch');
  assert.equal(github.calls.commitChanges[0].branch, newBranch, 'commit lands on the new branch');
  const pr = github.calls.createPullRequest[0];
  assert.equal(pr.head, newBranch, 'PR head is the new branch');
  assert.equal(pr.base, 'feature', 'PR targets the original PR head branch');

  assert.equal(res.json.pr_number, pr.number);
  assert.equal(res.json.pr_url, pr.html_url);

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'submitted', 'session is locked as submitted');

  // The opened PR is persisted on the session row (survives reload).
  const row = ctx.db.prepare('SELECT submitted_pr_number, submitted_branch FROM sessions WHERE id = ?').get(session.id);
  assert.equal(row.submitted_pr_number, pr.number, 'the PR is recorded on the session');
  assert.equal(row.submitted_branch, newBranch, 'the branch is recorded on the session');
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
});

test('R9.3 submitting with no edits closes the session cleanly with no branch or PR', async () => {
  active = await setup();
  const { ctx, github, session } = active;

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 200, 'submission succeeds with no edits');
  assert.equal(res.json.submitted, false, 'nothing was submitted');
  assert.equal(github.calls.createBranch.length, 0, 'no branch created');
  assert.equal(github.calls.commitChanges.length, 0, 'nothing is committed');
  assert.equal(github.calls.createPullRequest.length, 0, 'no PR opened');

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'submitted', 'session is closed as submitted');
});

// REQ-11 — Submission never overwrites newer work on the branch.

test('R11.1 if the branch advanced, submission succeeds off the live head SHA', async () => {
  active = await setup({ headShas: { 'acme/docs@feature': 'sha-2-newer' } });
  const { ctx, github, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 200, 'submission is not refused on an advanced branch');
  // Branch off and commit against the live head, never the stale session SHA.
  assert.equal(github.calls.createBranch[0].fromSha, 'sha-2-newer', 'new branch starts from the live head');
  assert.equal(github.calls.commitChanges[0].headSha, 'sha-2-newer', 'commit parents the live head');

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'submitted', 'session closes as submitted');
});

test('R11.2 if the commit to GitHub fails, the session stays open and the branch is cleaned up', async () => {
  active = await setup({ commitShouldFail: true });
  const { ctx, github, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 500, 'a commit failure surfaces as an error');

  // The branch was created before the commit failed, so it is removed again.
  assert.equal(github.calls.createBranch.length, 1);
  assert.equal(github.calls.deleteBranch.length, 1, 'the half-created branch is cleaned up');
  assert.equal(github.calls.deleteBranch[0].branch, github.calls.createBranch[0].branchName);

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'active', 'session is not left half-submitted');
});

test('R11.4b if opening the PR fails, the branch (with its commit) is cleaned up', async () => {
  active = await setup({ prShouldFail: true });
  const { ctx, github, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 500, 'a PR-creation failure surfaces as an error');
  assert.equal(github.calls.commitChanges.length, 1, 'the commit happened');
  assert.equal(github.calls.deleteBranch.length, 1, 'the orphaned branch is cleaned up');

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'active', 'session is not left half-submitted');
});

test('R11.3 if opening the PR fails, the session stays open', async () => {
  active = await setup({ submitShouldFail: true });
  const { ctx, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 500, 'a PR-creation failure surfaces as an error');

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
  assert.equal(github.calls.createPullRequest.length, 1, 'the PR is opened once the read succeeds');

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'submitted', 'session closes as submitted');
});

// REQ-12 — A submitted session is read-only.

test('R12.1 editing a submitted session is refused', async () => {
  active = await setup({ status: 'submitted' });
  const { ctx, session } = active;
  const res = await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: 'x', originalContent: 'y' } });
  assert.equal(res.status, 403);
});

test('R12.2 re-submitting an already-submitted session is refused', async () => {
  active = await setup({ status: 'submitted' });
  const { ctx, session } = active;
  const res = await ctx.request('POST', `/review/api/${session.token}/submit`);
  assert.equal(res.status, 403);
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

test('R17.4 comments stay readable after submit, but new ones are refused', async () => {
  active = await setup({ status: 'submitted' });
  const { ctx, session } = active;
  ctx.db.prepare('INSERT INTO comments (session_id, body, resolved, created_at) VALUES (?,?,0,?)').run(session.id, 'earlier note', Date.now());

  const list = await ctx.request('GET', `/review/api/${session.token}/comments`);
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 1, 'existing comments remain visible after submit');

  const post = await ctx.request('POST', `/review/api/${session.token}/comments`, { body: { body: 'too late' } });
  assert.equal(post.status, 403, 'cannot add a comment to a submitted session');
});
