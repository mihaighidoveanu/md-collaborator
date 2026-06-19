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

// REQ-9/REQ-18/REQ-20 — dynamic submit button, persistent review-PR banner,
// and same-PR reuse on re-submission.
test('submit button flips Approve/Submit changes; a commit shows a persistent banner and stays editable; re-submitting reuses the same PR', async ({ page }) => {
  await page.goto('/review/tok-submit');
  await expect(page.locator('.toastui-editor-defaultUI')).toBeVisible();

  const approveBtn = page.locator('#approve-btn');
  await expect(approveBtn).toHaveText('Approve');

  const editor = page.locator('.toastui-editor-ww-container .ProseMirror');
  await editor.click();
  await page.keyboard.press('End');
  await editor.pressSequentially(' first edit');
  await expect(approveBtn).toHaveText('Submit changes');

  await approveBtn.click();
  await expect(page.locator('#confirm-modal')).toBeVisible();
  await expect(page.locator('#confirm-modal-title')).toHaveText('Submit your changes?');
  await page.locator('#confirm-modal-confirm').click();

  await expect(page.locator('#status-banner')).toContainText('sent to the development team');
  const firstLink = page.locator('#status-banner a');
  const firstHref = await firstLink.getAttribute('href');
  // First submit commits directly onto the original PR — no new branch/PR.
  expect(firstHref).toMatch(/\/pull\/4$/);

  // The editor is never locked: the file stays open and editable after a commit.
  await expect(editor).toBeVisible();
  await expect(approveBtn).toHaveText('Approve');

  // A second edit flips the label back, and re-submitting lands on the same PR (B1).
  await editor.click();
  await page.keyboard.press('End');
  await editor.pressSequentially(' second edit');
  await expect(approveBtn).toHaveText('Submit changes');

  await approveBtn.click();
  await page.locator('#confirm-modal-confirm').click();
  await expect(page.locator('#status-banner')).toContainText('sent to the development team');
  await expect(page.locator('#status-banner a')).toHaveAttribute('href', firstHref);
});

// REQ-19 — Approve posts a GitHub review on the original PR.
test('clicking Approve with no pending edits posts a GitHub approval', async ({ page }) => {
  await page.goto('/review/tok-approve');
  await expect(page.locator('.toastui-editor-defaultUI')).toBeVisible();

  const approveBtn = page.locator('#approve-btn');
  await expect(approveBtn).toHaveText('Approve');

  await approveBtn.click();
  await expect(page.locator('#confirm-modal')).toBeVisible();
  await expect(page.locator('#confirm-modal-title')).toHaveText('Approve this review?');
  await page.locator('#confirm-modal-confirm').click();

  await expect(page.locator('#toast')).toContainText('Approval sent to the developers');
  await expect(approveBtn).toHaveText('Approved ✓');
});
