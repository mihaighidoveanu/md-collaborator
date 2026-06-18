const { defineConfig, devices } = require('@playwright/test');

const PORT = process.env.E2E_PORT || 4599;

// End-to-end browser tests. These exercise behaviors that only exist in the
// browser (autosave + reload, the approval-warning modal, mermaid rendering).
//
// They require a browser and network access to the editor/mermaid CDNs:
//   npx playwright install chromium
//   npm run test:e2e
module.exports = defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.js/,
  timeout: 30000,
  // The editor + mermaid load from CDNs; sandboxes that intercept TLS for
  // egress monitoring present a cert Chromium won't trust by default.
  use: { baseURL: `http://127.0.0.1:${PORT}`, ignoreHTTPSErrors: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node tests/e2e/fixtureServer.js`,
    env: { PORT: String(PORT), ADMIN_SECRET: 'e2e-admin-secret' },
    url: `http://127.0.0.1:${PORT}/admin.html`,
    reuseExistingServer: !process.env.CI,
  },
});
