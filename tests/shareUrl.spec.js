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

  await page.selectOption('#mandelbrotPaletteType', '1');
  await page.click('#showJulia');
  await page.click('#mandelbrotGridOverlay');
  await page.click('#shareBtn');

  await expect(page.locator('#shareBtn')).toHaveText('Copied!');

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  const url = new URL(clipboardText);
  expect(url.searchParams.get('mpalette')).toBe('1');
  expect(url.searchParams.get('julia')).toBe('1');
  expect(url.searchParams.get('mgrid')).toBe('1');
  // center/scale/iter were never touched, so they stay off the URL entirely.
  expect(url.searchParams.get('x')).toBeNull();
  expect(url.searchParams.get('scale')).toBeNull();
  expect(url.searchParams.get('miter')).toBeNull();
});

test('the address bar URL updates live as settings change, omitting untouched fields', async ({ page }) => {
  const initialUrl = page.url();

  await page.selectOption('#mandelbrotPaletteType', '1');
  await expect.poll(() => page.url()).not.toBe(initialUrl);

  const url = new URL(page.url());
  expect(url.searchParams.get('mpalette')).toBe('1');
  expect(url.searchParams.get('x')).toBeNull();
});

test('Reset clears every parameter back to a bare URL', async ({ page }) => {
  await page.selectOption('#mandelbrotPaletteType', '1');
  await page.click('#showJulia');
  await page.click('#mandelbrotGridOverlay');
  await expect.poll(() => new URL(page.url()).searchParams.get('mpalette')).toBe('1');

  await page.click('#resetBtn');
  await expect.poll(() => new URL(page.url()).search).toBe('');
});

test('Reset still clears the URL when the renderer is gone (e.g. WebGPU device lost)', async ({ page }) => {
  await page.selectOption('#mandelbrotPaletteType', '1');
  await page.click('#showJulia');
  await expect.poll(() => new URL(page.url()).searchParams.get('mpalette')).toBe('1');

  // Simulate the post-device-lost/no-adapter state: app alive, no renderer.
  await page.evaluate(() => { window.app.mandelbrotPanel.renderer = undefined; });

  await page.click('#resetBtn');
  await expect.poll(() => new URL(page.url()).search).toBe('');
  await expect(page.locator('#mandelbrotPaletteType')).toHaveValue('4');
  await expect(page.locator('#showJulia')).not.toBeChecked();
});

test('opening a share URL overrides both defaults and localStorage', async ({ page }) => {
  await page.selectOption('#mandelbrotPaletteType', '2');
  await expect.poll(async () => {
    const raw = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
    return raw ? JSON.parse(raw).mandelbrotPanel.paletteType : null;
  }).toBe(2);

  // No `v=` param: this is a legacy (pre-v2) share URL, where `julia=1` meant
  // an exclusive full-screen Julia render — see share.js's SCHEMA_VERSION
  // migration. It should map onto showJulia=1/showMandelbrot=0.
  await page.goto('/index.html?x=-1.25&y=0.1&scale=0.5&iter=512&julia=1&jx=-0.7&jy=0.25&palette=3&progressive=0&smooth=1&grid=1&centerMark=0&juliaMark=0');

  const gpuError = page.locator('#gpuError');
  await expect(gpuError).toBeHidden();

  await expect(page.locator('#mandelbrotPaletteType')).toHaveValue('3');
  await expect(page.locator('#showJulia')).toBeChecked();
  await expect(page.locator('#showMandelbrot')).not.toBeChecked();
  await expect(page.locator('#mandelbrotSmoothColoring')).toBeChecked();
  await expect(page.locator('#mandelbrotGridOverlay')).toBeChecked();
  await expect(page.locator('#mandelbrotIterLabel')).toHaveText('512');
});

test('a share URL with only some params leaves the rest at their defaults', async ({ page }) => {
  await page.goto('/index.html?x=-0.17662744107034933&y=1.0765741326067357&scale=0.14087522978004308');

  const gpuError = page.locator('#gpuError');
  await expect(gpuError).toBeHidden();

  const state = await page.evaluate(() => ({
    maxIter: window.app.mandelbrotPanel.maxIter,
    juliaSeed: { x: window.app.juliaSeed.x, y: window.app.juliaSeed.y },
    paletteType: window.app.mandelbrotPanel.paletteType,
  }));
  expect(state.maxIter).toBe(256);
  expect(state.juliaSeed).toEqual({ x: -0.8, y: 0.156 });
  expect(state.paletteType).toBe(4);

  // The live address-bar update shouldn't fabricate params for untouched fields either.
  await expect.poll(() => new URL(page.url()).searchParams.get('mx')).not.toBeNull();
  const url = new URL(page.url());
  expect(url.searchParams.get('miter')).toBeNull();
  expect(url.searchParams.get('sx')).toBeNull();
  expect(url.searchParams.get('mpalette')).toBeNull();
});

test('a param present but empty (e.g. ?iter=) is treated as absent, not zero', async ({ page }) => {
  await page.goto('/index.html?iter=&x=-1.25&y=0.1');

  const gpuError = page.locator('#gpuError');
  await expect(gpuError).toBeHidden();

  const maxIter = await page.evaluate(() => window.app.mandelbrotPanel.maxIter);
  expect(maxIter).toBe(256);
});

const DEFAULTS = {
  maxIter: 256, showMandelbrot: 1, showJulia: 0, paletteType: 4, progressiveMode: 0, smoothColoring: 0,
  gridOverlay: 0, centerMarker: 0, juliaMarker: 0,
  mandelbrotPanelCenter: { x: -0.5, y: 0 }, juliaSeed: { x: -0.8, y: 0.156 }, mandelbrotPanelScale: 3,
};

const SINGLE_PARAM_CASES = [
  ['iter=999', 'maxIter', 999],
  // v2 required: a bare `julia=1` (no `v=`) is the legacy exclusive-Julia
  // shape, which changes showJulia AND showMandelbrot together (covered by
  // its own dedicated test below) — not a single-field case.
  ['v=2&julia=1', 'showJulia', 1],
  ['v=2&mandelbrot=0', 'showMandelbrot', 0],
  ['palette=2', 'paletteType', 2],
  ['progressive=1', 'progressiveMode', 1],
  ['smooth=1', 'smoothColoring', 1],
  ['grid=1', 'gridOverlay', 1],
  ['centerMark=1', 'centerMarker', 1],
  ['juliaMark=1', 'juliaMarker', 1],
  ['scale=1.5', 'mandelbrotPanelScale', 1.5],
  ['x=-1.25&y=0.1', 'mandelbrotPanelCenter', { x: -1.25, y: 0.1 }],
  ['jx=-0.3&jy=0.9', 'juliaSeed', { x: -0.3, y: 0.9 }],
];

for (const [qs, field, expected] of SINGLE_PARAM_CASES) {
  test(`a share URL with only "${qs}" sets just that field, others stay default`, async ({ page }) => {
    await page.goto(`/index.html?${qs}`);
    const gpuError = page.locator('#gpuError');
    await expect(gpuError).toBeHidden();

    const state = await page.evaluate(() => ({
      maxIter: window.app.mandelbrotPanel.maxIter,
      showMandelbrot: window.app.showMandelbrot,
      showJulia: window.app.showJulia,
      paletteType: window.app.mandelbrotPanel.paletteType,
      progressiveMode: window.app.mandelbrotPanel.progressiveMode,
      smoothColoring: window.app.mandelbrotPanel.smoothColoring,
      gridOverlay: window.app.mandelbrotPanel.gridOverlay,
      centerMarker: window.app.mandelbrotPanel.centerMarker,
      juliaMarker: window.app.juliaMarker,
      mandelbrotPanelCenter: { x: window.app.mandelbrotPanel.center.x, y: window.app.mandelbrotPanel.center.y },
      juliaSeed: { x: window.app.juliaSeed.x, y: window.app.juliaSeed.y },
      mandelbrotPanelScale: window.app.mandelbrotPanel.scale,
    }));

    expect(state[field]).toEqual(expected);
    for (const key of Object.keys(DEFAULTS)) {
      if (key === field) continue;
      expect(state[key]).toEqual(DEFAULTS[key]);
    }
  });
}

test('a legacy (pre-v2) share URL with "julia=1" and no "v=" maps to exclusive Julia (showJulia=1, showMandelbrot=0)', async ({ page }) => {
  await page.goto('/index.html?julia=1');
  const gpuError = page.locator('#gpuError');
  await expect(gpuError).toBeHidden();

  const state = await page.evaluate(() => ({
    showJulia: window.app.showJulia,
    showMandelbrot: window.app.showMandelbrot,
  }));
  expect(state).toEqual({ showJulia: 1, showMandelbrot: 0 });
});

test('opening a share URL persists the shared settings to localStorage', async ({ page }) => {
  await page.goto('/index.html?x=-1.25&y=0.1&scale=0.5&iter=512&julia=1&jx=-0.7&jy=0.25&palette=3&progressive=0&smooth=1&grid=1&centerMark=0&juliaMark=0');

  await expect.poll(async () => {
    const raw = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
    return raw ? JSON.parse(raw).mandelbrotPanel.paletteType : null;
  }).toBe(3);

  const raw = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
  const data = JSON.parse(raw);
  expect(data.mandelbrotPanel.center).toEqual({ x: -1.25, y: 0.1 });
  expect(data.mandelbrotPanel.scale).toBe(0.5);
  expect(data.mandelbrotPanel.maxIter).toBe(512);
});

// Every other test in this file that touches mx/my/sx/sy/mscale gets there by
// loading a legacy (pre-v3) URL and checking the app rewrites it — none drive
// a real pan/zoom/click through the browser and check the *fresh* encoding.
// This is that missing case: a genuine user interaction should produce a
// current-schema (v6) URL, not just accept legacy input.
test('a real pan, zoom, and click-to-set-seed stamp v=6, using the unchanged-since-v3 pan/zoom/seed param names (mx/my/mscale/sx/sy) — this test doesn\'t touch the v6-renamed quality/look params', async ({ page }) => {
  const cx = 900, cy = 400; // well clear of the #ui panel (see panelVisibility.spec.js)

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy + 60, { steps: 8 });
  await page.mouse.up();

  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(400); // let the wheel debounce flush

  await page.mouse.click(cx + 40, cy - 30); // plain click (no drag): sets the Julia seed

  // The pan/zoom and the click each schedule their own debounced address-bar
  // update (see scheduleSaveSettings), so mx/my/mscale can already be in the
  // URL before the click's own save flushes sx/sy — poll for the last field
  // to land, not just the first.
  await expect.poll(() => new URL(page.url()).searchParams.get('sx')).not.toBeNull();
  const url = new URL(page.url());
  // SCHEMA_VERSION lives in share.js, not exposed on window.app; bumping it
  // means updating this literal too.
  expect(url.searchParams.get('v')).toBe('6');
  expect(url.searchParams.get('my')).not.toBeNull();
  expect(url.searchParams.get('mscale')).not.toBeNull();
  expect(url.searchParams.get('sx')).not.toBeNull();
  expect(url.searchParams.get('sy')).not.toBeNull();
});
