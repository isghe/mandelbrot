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

test('Copy URL puts a URL with only the changed settings on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.selectOption('#paletteType', '1');
  await page.click('#juliaMode');
  await page.click('#gridOverlay');
  await page.click('#shareBtn');

  await expect(page.locator('#shareBtn')).toHaveText('Copied!');

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  const url = new URL(clipboardText);
  expect(url.searchParams.get('palette')).toBe('1');
  expect(url.searchParams.get('julia')).toBe('1');
  expect(url.searchParams.get('grid')).toBe('1');
  // center/scale/iter were never touched, so they stay off the URL entirely.
  expect(url.searchParams.get('x')).toBeNull();
  expect(url.searchParams.get('scale')).toBeNull();
  expect(url.searchParams.get('iter')).toBeNull();
});

test('the address bar URL updates live as settings change, omitting untouched fields', async ({ page }) => {
  const initialUrl = page.url();

  await page.selectOption('#paletteType', '1');
  await expect.poll(() => page.url()).not.toBe(initialUrl);

  const url = new URL(page.url());
  expect(url.searchParams.get('palette')).toBe('1');
  expect(url.searchParams.get('x')).toBeNull();
});

test('Reset clears every parameter back to a bare URL', async ({ page }) => {
  await page.selectOption('#paletteType', '1');
  await page.click('#juliaMode');
  await page.click('#gridOverlay');
  await expect.poll(() => new URL(page.url()).searchParams.get('palette')).toBe('1');

  await page.click('#resetBtn');
  await expect.poll(() => new URL(page.url()).search).toBe('');
});

test('opening a share URL overrides both defaults and localStorage', async ({ page }) => {
  await page.selectOption('#paletteType', '2');
  await expect.poll(async () => {
    const raw = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
    return raw ? JSON.parse(raw).paletteType : null;
  }).toBe(2);

  await page.goto('/index.html?x=-1.25&y=0.1&scale=0.5&iter=512&julia=1&jx=-0.7&jy=0.25&palette=3&progressive=0&smooth=1&grid=1&centerMark=0&juliaMark=0');

  const gpuError = page.locator('#gpuError');
  await expect(gpuError).toBeHidden();

  await expect(page.locator('#paletteType')).toHaveValue('3');
  await expect(page.locator('#juliaMode')).toBeChecked();
  await expect(page.locator('#smoothColoring')).toBeChecked();
  await expect(page.locator('#gridOverlay')).toBeChecked();
  await expect(page.locator('#iterLabel')).toHaveText('512');
});

test('opening a share URL persists the shared settings to localStorage', async ({ page }) => {
  await page.goto('/index.html?x=-1.25&y=0.1&scale=0.5&iter=512&julia=1&jx=-0.7&jy=0.25&palette=3&progressive=0&smooth=1&grid=1&centerMark=0&juliaMark=0');

  await expect.poll(async () => {
    const raw = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
    return raw ? JSON.parse(raw).paletteType : null;
  }).toBe(3);

  const raw = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
  const data = JSON.parse(raw);
  expect(data.center).toEqual({ x: -1.25, y: 0.1 });
  expect(data.scale).toBe(0.5);
  expect(data.maxIter).toBe(512);
});
