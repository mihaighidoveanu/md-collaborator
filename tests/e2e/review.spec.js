const { test, expect } = require('@playwright/test');

// Browser-only behaviors from the test spec. These need the editor + mermaid
// CDNs to load, so run with: npx playwright install chromium && npm run test:e2e

// REQ-7 — A reviewer's edits are saved and durable.
test('R7.1 an edit is saved automatically and is still there after a page reload', async ({ page }) => {
  await page.goto('/review/tok-plain');
  // First file auto-opens.
  await expect(page.locator('.toastui-editor-defaultUI')).toBeVisible();

  const editor = page.locator('.toastui-editor-ww-container .ProseMirror');
  await editor.click();
  await page.keyboard.press('End');
  await editor.pressSequentially(' EDITED-MARKER');

  // Wait for autosave debounce (1500ms) plus a margin.
  await page.waitForTimeout(2500);

  await page.reload();
  await expect(page.locator('.toastui-editor-defaultUI')).toBeVisible();
  await expect(page.locator('.toastui-editor-ww-container .ProseMirror')).toContainText('EDITED-MARKER');
});

// REQ-8 — Progress guard.
test('R8.2 approving while some files are still unopened warns the reviewer first', async ({ page }) => {
  await page.goto('/review/tok-plain');
  await expect(page.locator('.toastui-editor-defaultUI')).toBeVisible();

  // Only the first file auto-opened; the second is unvisited. Approve should warn.
  await page.locator('#approve-btn').click();

  const modal = page.locator('#confirm-modal');
  await expect(modal).toBeVisible();
  await expect(page.locator('#confirm-modal-list')).toContainText('docs/extra.md');
});

// REQ-14 — Diagrams render for the reviewer.
test('R14.1 a mermaid block shows the rendered diagram, not raw code', async ({ page }) => {
  await page.goto('/review/tok-mermaid');
  await expect(page.locator('.toastui-editor-defaultUI')).toBeVisible();

  const rendered = page.locator('.mermaid-rendered svg');
  await expect(rendered).toBeVisible({ timeout: 10000 });
  // The raw "graph TD" source is not shown as plain text to the reviewer.
  await expect(page.locator('.mermaid-rendered')).not.toContainText('graph TD');
});
