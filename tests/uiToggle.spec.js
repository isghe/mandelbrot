import { test, expect } from '@playwright/test';

const VIEWPORT = { width: 1280, height: 720 };

test.beforeEach(async ({ page }) => {
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.setViewportSize(VIEWPORT);
  await page.goto('/index.html');

  const gpuError = page.locator('#gpuError');
  if (await gpuError.isVisible()) {
    const message = await page.locator('#gpuErrorMessage').textContent();
    throw new Error(
      `WebGPU failed to initialize: ${message}\nConsole errors:\n${consoleErrors.join('\n')}`
    );
  }
});

test('settings panel is visible by default', async ({ page }) => {
  await expect(page.locator('#ui')).toBeVisible();
});

test('toggle button hides and re-shows the settings panel', async ({ page }) => {
  await page.click('#uiToggleBtn');
  await expect(page.locator('#ui')).toBeHidden();

  await page.click('#uiToggleBtn');
  await expect(page.locator('#ui')).toBeVisible();
});

test('toggle button remains visible and clickable while panel is hidden', async ({ page }) => {
  await page.click('#uiToggleBtn');
  await expect(page.locator('#ui')).toBeHidden();
  await expect(page.locator('#uiToggleBtn')).toBeVisible();
});

test('toggling the panel does not enable Back/Forward', async ({ page }) => {
  await page.click('#uiToggleBtn');
  await page.click('#uiToggleBtn');
  await expect(page.locator('#backBtn')).toBeDisabled();
});

test('H key toggles the settings panel', async ({ page }) => {
  await page.keyboard.press('h');
  await expect(page.locator('#ui')).toBeHidden();
  await page.keyboard.press('h');
  await expect(page.locator('#ui')).toBeVisible();
});

test('H key is ignored while a form control has focus', async ({ page }) => {
  await page.focus('#iterSlider');
  await page.keyboard.press('h');
  await expect(page.locator('#ui')).toBeVisible();
});
