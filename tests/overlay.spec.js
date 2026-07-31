import { test, expect } from '@playwright/test';

// Mirrors history.spec.js's FRACTAL_CLIP: excludes the #ui panel so
// screenshot diffs only reflect the rendered fractal + overlay.
const FRACTAL_CLIP = { x: 250, y: 0, width: 1030, height: 720 };
const VIEWPORT = { width: 1280, height: 720 };

async function fractalShot(page) {
  return page.screenshot({ clip: FRACTAL_CLIP });
}

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

  await expect(page.locator('#gridOverlay')).not.toBeChecked();
  await expect(page.locator('#centerMarker')).not.toBeChecked();
  await expect(page.locator('#juliaMarker')).not.toBeChecked();
});

test('the overlay backing store matches the viewport, scaled by devicePixelRatio', async ({ page }) => {
  const dims = await page.evaluate(() => {
    const c = document.getElementById('overlay');
    return { w: c.width, h: c.height, dpr: window.devicePixelRatio || 1 };
  });
  expect(dims.w).toBe(Math.round(VIEWPORT.width * dims.dpr));
  expect(dims.h).toBe(Math.round(VIEWPORT.height * dims.dpr));
});

test('enabling the grid draws non-transparent pixels on the overlay canvas', async ({ page }) => {
  const before = await page.evaluate(() => {
    const c = document.getElementById('overlay');
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++;
    return opaque;
  });
  expect(before).toBe(0);

  await page.check('#gridOverlay');
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => {
    const c = document.getElementById('overlay');
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++;
    return opaque;
  });
  expect(after).toBeGreaterThan(0);
});

test('grid checkbox toggles visible pixels and round-trips to baseline', async ({ page }) => {
  const baseline = await fractalShot(page);

  await page.check('#gridOverlay');
  await page.waitForTimeout(200);
  expect((await fractalShot(page)).equals(baseline)).toBe(false);

  await page.uncheck('#gridOverlay');
  await page.waitForTimeout(200);
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
});

test('center marker checkbox toggles visible pixels and round-trips to baseline', async ({ page }) => {
  const baseline = await fractalShot(page);

  await page.check('#centerMarker');
  await page.waitForTimeout(200);
  expect((await fractalShot(page)).equals(baseline)).toBe(false);

  await page.uncheck('#centerMarker');
  await page.waitForTimeout(200);
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
});

test('Julia marker checkbox toggles visible pixels outside Julia mode too', async ({ page }) => {
  await expect(page.locator('#juliaMode')).not.toBeChecked();
  const baseline = await fractalShot(page);

  await page.check('#juliaMarker');
  await page.waitForTimeout(200);
  expect((await fractalShot(page)).equals(baseline)).toBe(false);

  await page.uncheck('#juliaMarker');
  await page.waitForTimeout(200);
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
});

test('toggling overlay checkboxes does not enable Back/Forward', async ({ page }) => {
  const backBtn = page.locator('#backBtn');

  await page.check('#gridOverlay');
  await page.check('#centerMarker');
  await page.check('#juliaMarker');
  await page.uncheck('#gridOverlay');
  await page.waitForTimeout(200);

  await expect(backBtn).toBeDisabled();
});

test('the grid overlay redraws to match a new view after pan/zoom', async ({ page }) => {
  await page.check('#gridOverlay');
  await page.waitForTimeout(200);
  const box = await page.locator('#gfx').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const beforePan = await fractalShot(page);

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 150, cy + 80, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  expect((await fractalShot(page)).equals(beforePan)).toBe(false);
});
