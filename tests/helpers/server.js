// Boot the real app on an ephemeral port with an in-memory database and an
// injected fake GitHub, then talk to it over HTTP — the same surface a real
// client uses. Tests assert observable HTTP behavior, so route internals can
// change freely.
const createApp = require('../../server/app');
const createDb = require('../../server/db');

const ADMIN_SECRET = 'test-admin-secret';

async function startTestServer({ github } = {}) {
  process.env.ADMIN_SECRET = ADMIN_SECRET;
  const db = createDb(':memory:');
  const app = createApp({ db, github });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request(method, path, { body, headers } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, ok: res.ok, json, text };
  }

  const admin = (method, path, opts = {}) =>
    request(method, path, { ...opts, headers: { 'x-admin-secret': ADMIN_SECRET, ...(opts.headers || {}) } });

  // Seed a session directly in the db (for tests that need a given state).
  function seedSession(overrides = {}) {
    const crypto = require('crypto');
    const s = {
      id: overrides.id || crypto.randomUUID(),
      token: overrides.token || crypto.randomBytes(16).toString('hex'),
      owner: overrides.owner || 'acme',
      repo: overrides.repo || 'docs',
      pr_number: overrides.pr_number || 1,
      pr_title: overrides.pr_title || 'A PR',
      head_branch: overrides.head_branch || 'feature',
      head_sha: overrides.head_sha || 'sha-1',
      status: overrides.status || 'active',
      created_at: overrides.created_at || Date.now(),
    };
    db.prepare(`INSERT INTO sessions (id, token, owner, repo, pr_number, pr_title, head_branch, head_sha, status, created_at)
      VALUES (@id,@token,@owner,@repo,@pr_number,@pr_title,@head_branch,@head_sha,@status,@created_at)`).run(s);
    return s;
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }

  return { app, db, server, baseUrl, request, admin, seedSession, close, ADMIN_SECRET };
}

module.exports = { startTestServer, ADMIN_SECRET };
