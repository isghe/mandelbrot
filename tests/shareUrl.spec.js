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

test('a share URL with only some params leaves the rest at their defaults', async ({ page }) => {
  await page.goto('/index.html?x=-0.17662744107034933&y=1.0765741326067357&scale=0.14087522978004308');

  const gpuError = page.locator('#gpuError');
  await expect(gpuError).toBeHidden();

  const state = await page.evaluate(() => ({
    maxIter: window.app.maxIter,
    juliaC: { x: window.app.juliaC.x, y: window.app.juliaC.y },
    paletteType: window.app.paletteType,
  }));
  expect(state.maxIter).toBe(256);
  expect(state.juliaC).toEqual({ x: -0.8, y: 0.156 });
  expect(state.paletteType).toBe(4);

  // The live address-bar update shouldn't fabricate params for untouched fields either.
  await page.waitForTimeout(600);
  const url = new URL(page.url());
  expect(url.searchParams.get('iter')).toBeNull();
  expect(url.searchParams.get('jx')).toBeNull();
  expect(url.searchParams.get('palette')).toBeNull();
});

const DEFAULTS = {
  maxIter: 256, juliaMode: 0, paletteType: 4, progressiveMode: 0, smoothColoring: 0,
  gridOverlay: 0, centerMarker: 0, juliaMarker: 0,
  center: { x: -0.5, y: 0 }, juliaC: { x: -0.8, y: 0.156 }, scale: 3,
};

const SINGLE_PARAM_CASES = [
  ['iter=999', 'maxIter', 999],
  ['julia=1', 'juliaMode', 1],
  ['palette=2', 'paletteType', 2],
  ['progressive=1', 'progressiveMode', 1],
  ['smooth=1', 'smoothColoring', 1],
  ['grid=1', 'gridOverlay', 1],
  ['centerMark=1', 'centerMarker', 1],
  ['juliaMark=1', 'juliaMarker', 1],
  ['scale=1.5', 'scale', 1.5],
];

for (const [qs, field, expected] of SINGLE_PARAM_CASES) {
  test(`a share URL with only "${qs}" sets just that field, others stay default`, async ({ page }) => {
    await page.goto(`/index.html?${qs}`);
    const gpuError = page.locator('#gpuError');
    await expect(gpuError).toBeHidden();

    const state = await page.evaluate(() => ({
      maxIter: window.app.maxIter,
      juliaMode: window.app.juliaMode,
      paletteType: window.app.paletteType,
      progressiveMode: window.app.progressiveMode,
      smoothColoring: window.app.smoothColoring,
      gridOverlay: window.app.gridOverlay,
      centerMarker: window.app.centerMarker,
      juliaMarker: window.app.juliaMarker,
      center: { x: window.app.center.x, y: window.app.center.y },
      juliaC: { x: window.app.juliaC.x, y: window.app.juliaC.y },
      scale: window.app.scale,
    }));

    expect(state[field]).toEqual(expected);
    for (const key of Object.keys(DEFAULTS)) {
      if (key === field) continue;
      expect(state[key]).toEqual(DEFAULTS[key]);
    }
  });
}

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
