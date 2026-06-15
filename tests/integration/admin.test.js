const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../helpers/server');
const { createFakeGithub } = require('../helpers/fakeGithub');

// A standard open PR with reviewable markdown.
function openPrConfig() {
  return {
    prs: {
      'acme/docs#1': {
        state: 'open',
        title: 'Add onboarding docs',
        head: { ref: 'feature', sha: 'sha-1' },
        files: [
          { filename: 'docs/intro.md', status: 'modified' },
          { filename: 'README.md', status: 'added' },
        ],
        contents: { 'docs/intro.md': '# Intro\nhello\n', 'README.md': '# Readme\n' },
      },
    },
  };
}

let ctx;
afterEach(async () => { if (ctx) await ctx.close(); ctx = null; });

function tokenFromLink(link) { return link.split('/').pop(); }

// REQ-1 — Only an authenticated admin can manage sessions.

test('R1.1 with the correct secret, an admin can reach the management endpoints', async () => {
  ctx = await startTestServer({ github: createFakeGithub(openPrConfig()) });
  const res = await ctx.admin('GET', '/admin/sessions');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json));
});

test('R1.2 with a wrong or missing secret, every management action is refused', async () => {
  ctx = await startTestServer({ github: createFakeGithub(openPrConfig()) });
  const bad = { headers: { 'x-admin-secret': 'nope' } };

  assert.equal((await ctx.request('GET', '/admin/sessions')).status, 401, 'missing secret');
  assert.equal((await ctx.request('GET', '/admin/sessions', bad)).status, 401, 'wrong secret');
  assert.equal((await ctx.request('POST', '/admin/sessions', { ...bad, body: { pr_url: 'https://github.com/acme/docs/pull/1' } })).status, 401);
  assert.equal((await ctx.request('POST', '/admin/sessions/some-id/revoke', bad)).status, 401);
});

// REQ-2 — An admin can open a review session from a pull request.

test('R2.1 creating a session from an open PR yields a working review link and an active session', async () => {
  ctx = await startTestServer({ github: createFakeGithub(openPrConfig()) });
  const res = await ctx.admin('POST', '/admin/sessions', { body: { pr_url: 'https://github.com/acme/docs/pull/1' } });
  assert.equal(res.status, 200);
  assert.match(res.json.review_link, /\/review\/[0-9a-f]+$/);

  // The link actually opens an active session.
  const token = tokenFromLink(res.json.review_link);
  const meta = await ctx.request('GET', `/review/api/${token}`);
  assert.equal(meta.status, 200);
  assert.equal(meta.json.status, 'active');
  assert.equal(meta.json.pr_number, 1);
});

test('R2.2 a closed or merged PR is refused', async () => {
  const cfg = openPrConfig();
  cfg.prs['acme/docs#1'].state = 'closed';
  ctx = await startTestServer({ github: createFakeGithub(cfg) });
  const res = await ctx.admin('POST', '/admin/sessions', { body: { pr_url: 'https://github.com/acme/docs/pull/1' } });
  assert.equal(res.status, 400);
});

test('R2.3 a PR with no markdown files is refused', async () => {
  const cfg = openPrConfig();
  cfg.prs['acme/docs#1'].files = [
    { filename: 'src/app.js', status: 'modified' },
    { filename: 'logo.png', status: 'added' },
  ];
  ctx = await startTestServer({ github: createFakeGithub(cfg) });
  const res = await ctx.admin('POST', '/admin/sessions', { body: { pr_url: 'https://github.com/acme/docs/pull/1' } });
  assert.equal(res.status, 400);
});

test('R2.4 a non-PR-URL reference is refused before any external call', async () => {
  const gh = createFakeGithub(openPrConfig());
  ctx = await startTestServer({ github: gh });
  const res = await ctx.admin('POST', '/admin/sessions', { body: { pr_url: 'not a url' } });
  assert.equal(res.status, 400);
  assert.equal(gh.calls.getPR.length, 0, 'no GitHub call was made for an invalid reference');
});

// REQ-4 — An admin can oversee all sessions.

test('R4.1 the listing shows status, edit count, and a link that actually opens the session', async () => {
  ctx = await startTestServer({ github: createFakeGithub(openPrConfig()) });
  const created = await ctx.admin('POST', '/admin/sessions', { body: { pr_url: 'https://github.com/acme/docs/pull/1' } });
  const token = tokenFromLink(created.json.review_link);

  // Reviewer edits one file so there's an edit to count.
  await ctx.request('PUT', `/review/api/${token}/files/${encodeURIComponent('docs/intro.md')}`,
    { body: { content: '# Intro\nedited\n', originalContent: '# Intro\nhello\n' } });

  const list = await ctx.admin('GET', '/admin/sessions');
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 1);
  const row = list.json[0];

  assert.equal(row.status, 'active', 'status is shown');
  assert.equal(row.edits_count, 1, 'edited-file count is shown');
  assert.ok(row.token, 'a token is exposed so the link can be built');

  // The link the admin would render actually opens that session.
  const meta = await ctx.request('GET', `/review/api/${row.token}`);
  assert.equal(meta.status, 200);
  assert.equal(meta.json.pr_number, row.pr_number);
});

// REQ-5 — An admin can revoke a link.

test('R5.1 revoking an active session immediately cuts off the reviewer', async () => {
  ctx = await startTestServer({ github: createFakeGithub(openPrConfig()) });
  const created = await ctx.admin('POST', '/admin/sessions', { body: { pr_url: 'https://github.com/acme/docs/pull/1' } });
  const token = tokenFromLink(created.json.review_link);
  const id = created.json.session_id;

  assert.equal((await ctx.request('GET', `/review/api/${token}`)).status, 200, 'reviewer has access before revoke');

  const revoke = await ctx.admin('POST', `/admin/sessions/${id}/revoke`);
  assert.equal(revoke.status, 200);

  assert.equal((await ctx.request('GET', `/review/api/${token}`)).status, 403, 'access is cut off after revoke');
});

test('R5.2 revoking a non-active session has no effect and reports as much', async () => {
  ctx = await startTestServer({ github: createFakeGithub(openPrConfig()) });
  const s = ctx.seedSession({ status: 'revoked' });
  const res = await ctx.admin('POST', `/admin/sessions/${s.id}/revoke`);
  assert.equal(res.status, 404, 'already-inactive session reports no change');

  const missing = await ctx.admin('POST', '/admin/sessions/does-not-exist/revoke');
  assert.equal(missing.status, 404);
});
