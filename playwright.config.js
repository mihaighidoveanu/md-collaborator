const { defineConfig, devices } = require('@playwright/test');

const PORT = process.env.E2E_PORT || 4599;

// End-to-end browser tests. These exercise behaviors that only exist in the
// browser (autosave + reload, the approval-warning modal, mermaid rendering).
//
// They require a browser and network access to the editor/mermaid CDNs:
//   npx playwright install chromium
//   npm run test:e2e
//
// Behind a TLS-inspecting proxy? Chrome for Testing trusts whatever CA roots
// are in the OS's NSS database, same as a real Chrome install — run
// tests/e2e/trust-ca.sh once per fresh container to import this sandbox's
// egress-gateway CA there.
module.exports = defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.js/,
  timeout: 30000,
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node tests/e2e/fixtureServer.js`,
    env: { PORT: String(PORT), ADMIN_SECRET: 'e2e-admin-secret' },
    url: `http://127.0.0.1:${PORT}/admin.html`,
    reuseExistingServer: !process.env.CI,
  },
});
