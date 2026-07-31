import { test, expect } from '@playwright/test';

const VIEWPORT = { width: 1280, height: 720 };
const SETTINGS_KEY = 'isghe-mandelbrot-settings';

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

async function waitForPersisted(page, field, value) {
  await expect.poll(async () => {
    const raw = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
    return raw ? JSON.parse(raw)[field] : null;
  }).toBe(value);
}

test('changing a setting persists it to localStorage', async ({ page }) => {
  await page.selectOption('#paletteType', '1');
  await waitForPersisted(page, 'paletteType', 1);

  const raw = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
  expect(JSON.parse(raw).paletteType).toBe(1);
});

test('reloading the page restores persisted settings', async ({ page }) => {
  await page.selectOption('#paletteType', '1');
  await page.click('#juliaMode');
  await waitForPersisted(page, 'paletteType', 1);
  await waitForPersisted(page, 'juliaMode', 1);

  await page.reload();
  const gpuError = page.locator('#gpuError');
  await expect(gpuError).toBeHidden();

  await expect(page.locator('#paletteType')).toHaveValue('1');
  await expect(page.locator('#juliaMode')).toBeChecked();
});

test('Reset returns to the original defaults, not the persisted state', async ({ page }) => {
  await page.selectOption('#paletteType', '1');
  await waitForPersisted(page, 'paletteType', 1);
  await page.reload();
  await expect(page.locator('#paletteType')).toHaveValue('1');

  await page.click('#resetBtn');
  await expect(page.locator('#paletteType')).toHaveValue('4');
});

test('a corrupted localStorage entry does not break startup', async ({ page }) => {
  await page.evaluate((key) => localStorage.setItem(key, '{not valid json'), SETTINGS_KEY);

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.reload();
  const gpuError = page.locator('#gpuError');
  await expect(gpuError).toBeHidden();
  expect(pageErrors).toEqual([]);
});
