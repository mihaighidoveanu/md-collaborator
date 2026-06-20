const { defineConfig, devices } = require('@playwright/test');
const { X509Certificate, createHash } = require('crypto');
const fs = require('fs');

const PORT = process.env.E2E_PORT || 4599;

// If you're behind a TLS-inspecting proxy, point this at its CA cert (PEM) so
// Chromium trusts that one issuer specifically, rather than disabling
// certificate validation altogether.
const extraCaPath = process.env.E2E_EXTRA_TRUSTED_CA;
const launchArgs = [];
if (extraCaPath) {
  const spki = new X509Certificate(fs.readFileSync(extraCaPath))
    .publicKey.export({ type: 'spki', format: 'der' });
  const hash = createHash('sha256').update(spki).digest('base64');
  launchArgs.push(`--ignore-certificate-errors-spki-list=${hash}`);
}

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
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: launchArgs } } }],
  webServer: {
    command: `node tests/e2e/fixtureServer.js`,
    env: { PORT: String(PORT), ADMIN_SECRET: 'e2e-admin-secret' },
    url: `http://127.0.0.1:${PORT}/admin.html`,
    reuseExistingServer: !process.env.CI,
  },
});
