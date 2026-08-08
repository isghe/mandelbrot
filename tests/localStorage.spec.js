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

// `field` is a dot path (e.g. "mandelbrotPanel.paletteType") since v5 nests
// most per-panel settings under mandelbrotPanel{}/juliaPanel{} — see share.js.
async function waitForPersisted(page, field, value) {
  const parts = field.split('.');
  await expect.poll(async () => {
    const raw = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
    if (!raw) return null;
    let obj = JSON.parse(raw);
    for (const part of parts) obj = obj?.[part];
    return obj ?? null;
  }).toBe(value);
}

test('changing a setting persists it to localStorage', async ({ page }) => {
  await page.selectOption('#mandelbrotPaletteType', '1');
  await waitForPersisted(page, 'mandelbrotPanel.paletteType', 1);

  const raw = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
  expect(JSON.parse(raw).mandelbrotPanel.paletteType).toBe(1);
});

test('reloading the page restores persisted settings', async ({ page }) => {
  await page.selectOption('#mandelbrotPaletteType', '1');
  await page.click('#mandelbrotGridOverlay');
  await waitForPersisted(page, 'mandelbrotPanel.paletteType', 1);
  await waitForPersisted(page, 'mandelbrotPanel.gridOverlay', 1);

  await page.reload();
  const gpuError = page.locator('#gpuError');
  await expect(gpuError).toBeHidden();

  await expect(page.locator('#mandelbrotPaletteType')).toHaveValue('1');
  await expect(page.locator('#mandelbrotGridOverlay')).toBeChecked();
});

// Coverage for schema v5 (Mossa 4): the Julia panel's own maxIter/paletteType
// are now nested under juliaPanel{} in localStorage, independent of the
// Mandelbrot panel's — a reload must not mix the two panels' values up.
test('the Mandelbrot and Julia panels persist independent palette/iterations across reload', async ({ page }) => {
  await page.selectOption('#mandelbrotPaletteType', '1');
  await page.selectOption('#juliaPaletteType', '2');
  await waitForPersisted(page, 'mandelbrotPanel.paletteType', 1);
  await waitForPersisted(page, 'juliaPanel.paletteType', 2);

  await page.reload();
  const gpuError = page.locator('#gpuError');
  await expect(gpuError).toBeHidden();

  await expect(page.locator('#mandelbrotPaletteType')).toHaveValue('1');
  await expect(page.locator('#juliaPaletteType')).toHaveValue('2');
});

test('reloading the page restores the Julia panel\'s own dragged/zoomed position, not just juliaSeed', async ({ page }) => {
  const initial = await page.evaluate(() => ({
    center: { x: window.app.modelNamed("julia").panel.center.x, y: window.app.modelNamed("julia").panel.center.y },
    scale: window.app.modelNamed("julia").panel.scale,
  }));

  await page.mouse.move(900, 350); // over the Julia (right) panel
  await page.mouse.wheel(0, -400);
  await page.mouse.move(1000, 450);
  await page.mouse.down();
  await page.mouse.move(850, 300);
  await page.mouse.up();
  await page.waitForTimeout(200);

  const before = await page.evaluate(() => ({
    center: { x: window.app.modelNamed("julia").panel.center.x, y: window.app.modelNamed("julia").panel.center.y },
    scale: window.app.modelNamed("julia").panel.scale,
  }));
  // Confirm the drag/zoom actually registered — otherwise this test would
  // pass trivially even if the mouse actions produced no effect at all
  // (e.g. because they landed outside the Julia panel).
  expect(before).not.toEqual(initial);

  // Wait for the *drag's* debounced save specifically, not just
  // juliaPanelScale (already reached its final value from the wheel-zoom,
  // which lands before the drag) — otherwise the reload below can race
  // ahead of the drag's own later settings save and only see pre-drag
  // persisted state.
  await expect.poll(async () => {
    const raw = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
    return raw ? JSON.parse(raw).juliaPanel?.center?.x : null;
  }).toBe(before.center.x);
  await page.reload();
  const gpuError = page.locator('#gpuError');
  await expect(gpuError).toBeHidden();
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => ({
    center: { x: window.app.modelNamed("julia").panel.center.x, y: window.app.modelNamed("julia").panel.center.y },
    scale: window.app.modelNamed("julia").panel.scale,
  }));
  expect(after).toEqual(before);
});

test('Reset returns to the original defaults, not the persisted state', async ({ page }) => {
  await page.selectOption('#mandelbrotPaletteType', '1');
  await waitForPersisted(page, 'mandelbrotPanel.paletteType', 1);
  await page.reload();
  await expect(page.locator('#mandelbrotPaletteType')).toHaveValue('1');

  await page.click('#resetBtn');
  await expect(page.locator('#mandelbrotPaletteType')).toHaveValue('4');
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
