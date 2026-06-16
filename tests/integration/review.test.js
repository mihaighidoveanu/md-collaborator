const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../helpers/server');
const { createFakeGithub } = require('../helpers/fakeGithub');

// Build a fake configured with one open PR plus a session row already pointing
// at it, returning everything a review-flow test needs.
async function setup({ files, contents, status = 'active', headShas, commitShouldFail } = {}) {
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

  const approve = await ctx.request('POST', `/review/api/${session.token}/approve`);
  assert.equal(approve.status, 200);

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

// REQ-9 — Approval commits the edits and closes the session.

test('R9.1 approving with edits commits to the branch and locks the session as approved', async () => {
  active = await setup();
  const { ctx, github, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/approve`);
  assert.equal(res.status, 200);
  assert.equal(github.calls.commitChanges.length, 1, 'a commit was written');

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'approved', 'session is locked as approved');
});

test('R9.2 several edited files are delivered as one commit, not many', async () => {
  active = await setup();
  const { ctx, github, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nx\n', originalContent: '# Intro\nhello\n' } });
  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('README.md')}`,
    { body: { content: '# Readme edited\n', originalContent: '# Readme\n' } });

  await ctx.request('POST', `/review/api/${session.token}/approve`);
  assert.equal(github.calls.commitChanges.length, 1, 'exactly one commit');
  assert.equal(github.calls.commitChanges[0].editedFiles.length, 2, 'both files in that one commit');
});

test('R9.3 approving with no edits still closes the session cleanly and commits nothing', async () => {
  active = await setup();
  const { ctx, github, session } = active;

  const res = await ctx.request('POST', `/review/api/${session.token}/approve`);
  assert.equal(res.status, 200, 'approval succeeds with no edits');
  assert.equal(github.calls.commitChanges.length, 0, 'nothing is committed');

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'approved', 'session is closed as approved');
});

// REQ-11 — Approval never overwrites newer work on the branch.

test('R11.1 if the branch advanced, approval is refused and the session stays open', async () => {
  active = await setup({ headShas: { 'acme/docs@feature': 'sha-2-newer' } });
  const { ctx, github, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/approve`);
  assert.equal(res.status, 409, 'approval refused on an advanced branch');
  assert.equal(github.calls.commitChanges.length, 0, 'no commit was attempted');

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'active', 'session stays open');
});

test('R11.2 if the commit to GitHub fails, the session stays open', async () => {
  active = await setup({ commitShouldFail: true });
  const { ctx, session } = active;

  await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const res = await ctx.request('POST', `/review/api/${session.token}/approve`);
  assert.equal(res.status, 500, 'a commit failure surfaces as an error');

  const meta = await ctx.request('GET', `/review/api/${session.token}`);
  assert.equal(meta.json.status, 'active', 'session is not left half-approved');
});

// REQ-12 — An approved session is read-only.

test('R12.1 editing an approved session is refused', async () => {
  active = await setup({ status: 'approved' });
  const { ctx, session } = active;
  const res = await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`,
    { body: { content: 'x', originalContent: 'y' } });
  assert.equal(res.status, 403);
});

test('R12.2 re-approving an already-approved session is refused', async () => {
  active = await setup({ status: 'approved' });
  const { ctx, session } = active;
  const res = await ctx.request('POST', `/review/api/${session.token}/approve`);
  assert.equal(res.status, 403);
});

// REQ-13 — A revoked link grants no access.

test('R13.1 a revoked link cannot read, edit, or approve', async () => {
  active = await setup({ status: 'revoked' });
  const { ctx, session } = active;

  assert.equal((await ctx.request('GET', `/review/api/${session.token}`)).status, 403, 'cannot read');
  assert.equal((await ctx.request('GET', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`)).status, 403, 'cannot read file');
  assert.equal((await ctx.request('PUT', `/review/api/${session.token}/files/${filePath('docs/intro.md')}`, { body: { content: 'x', originalContent: 'y' } })).status, 403, 'cannot edit');
  assert.equal((await ctx.request('POST', `/review/api/${session.token}/approve`)).status, 403, 'cannot approve');
});
