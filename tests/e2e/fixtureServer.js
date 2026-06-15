// A deterministic app instance for end-to-end browser tests: the real app,
// wired to an in-memory database and a fake GitHub, seeded with known sessions
// at fixed tokens so the specs can navigate straight to them.
//
// Run standalone (used by playwright.config.js as the webServer):
//   PORT=4599 node tests/e2e/fixtureServer.js
const createApp = require('../../server/app');
const createDb = require('../../server/db');
const { createFakeGithub } = require('../helpers/fakeGithub');

const MERMAID_DOC = [
  '# Architecture',
  '',
  'A diagram follows:',
  '',
  '```mermaid',
  'graph TD;',
  '  A[Client] --> B[Server];',
  '  B --> C[(Database)];',
  '```',
  '',
].join('\n');

function buildFixture() {
  process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'e2e-admin-secret';
  const db = createDb(':memory:');
  const github = createFakeGithub({
    prs: {
      'acme/docs#1': {
        state: 'open', title: 'E2E docs', head: { ref: 'feature', sha: 'sha-1' },
        files: [
          { filename: 'docs/intro.md', status: 'modified' },
          { filename: 'docs/extra.md', status: 'added' },
        ],
        contents: { 'docs/intro.md': '# Intro\n\nHello world.\n', 'docs/extra.md': '# Extra\n\nMore.\n' },
      },
      'acme/docs#2': {
        state: 'open', title: 'E2E diagram', head: { ref: 'diagram', sha: 'sha-2' },
        files: [{ filename: 'docs/arch.md', status: 'modified' }],
        contents: { 'docs/arch.md': MERMAID_DOC },
      },
    },
  });
  const app = createApp({ db, github });

  function seed(s) {
    db.prepare(`INSERT INTO sessions (id, token, owner, repo, pr_number, pr_title, head_branch, head_sha, status, created_at)
      VALUES (@id,@token,@owner,@repo,@pr_number,@pr_title,@head_branch,@head_sha,'active',@created_at)`).run({ created_at: Date.now(), ...s });
  }
  // Fixed tokens the specs navigate to.
  seed({ id: 'e2e-plain', token: 'tok-plain', owner: 'acme', repo: 'docs', pr_number: 1, pr_title: 'E2E docs', head_branch: 'feature', head_sha: 'sha-1' });
  seed({ id: 'e2e-mermaid', token: 'tok-mermaid', owner: 'acme', repo: 'docs', pr_number: 2, pr_title: 'E2E diagram', head_branch: 'diagram', head_sha: 'sha-2' });

  return { app, db, github };
}

module.exports = { buildFixture };

if (require.main === module) {
  const { app } = buildFixture();
  const port = process.env.PORT || 4599;
  app.listen(port, () => console.log(`e2e fixture server on ${port}`));
}
