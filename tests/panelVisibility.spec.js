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

test('by default, both panels are shown, split-screen', async ({ page }) => {
  await expect(page.locator('#mandelbrotGfx')).toBeVisible();
  await expect(page.locator('#juliaGfx')).toBeVisible();
  const mandelbrotBox = await page.locator('#mandelbrotGfx').boundingBox();
  const juliaBox = await page.locator('#juliaGfx').boundingBox();
  expect(mandelbrotBox.width).toBe(VIEWPORT.width / 2);
  expect(juliaBox.width).toBe(VIEWPORT.width / 2);
  expect(juliaBox.x).toBe(mandelbrotBox.width);
  await expect(page.locator('#noVizMessage')).toBeHidden();
});

test('unchecking Julia leaves only the Mandelbrot panel, full-screen', async ({ page }) => {
  await page.uncheck('#showJulia');
  await expect(page.locator('#juliaGfx')).toBeHidden();
  const box = await page.locator('#mandelbrotGfx').boundingBox();
  expect(box.width).toBe(VIEWPORT.width);
});

test('unchecking then re-checking Julia restores the 50/50 split', async ({ page }) => {
  await page.uncheck('#showJulia');
  await page.check('#showJulia');
  await expect(page.locator('#juliaGfx')).toBeVisible();

  const mandelbrotBox = await page.locator('#mandelbrotGfx').boundingBox();
  const juliaBox = await page.locator('#juliaGfx').boundingBox();
  expect(mandelbrotBox.width).toBe(VIEWPORT.width / 2);
  expect(juliaBox.width).toBe(VIEWPORT.width / 2);
  expect(juliaBox.x).toBe(mandelbrotBox.width);
});

test('unchecking Mandelbrot with Julia checked shows only the Julia panel, full-screen', async ({ page }) => {
  await page.check('#showJulia');
  await page.uncheck('#showMandelbrot');

  await expect(page.locator('#mandelbrotGfx')).toBeHidden();
  await expect(page.locator('#juliaGfx')).toBeVisible();
  const box = await page.locator('#juliaGfx').boundingBox();
  expect(box.width).toBe(VIEWPORT.width);
  await expect(page.locator('#noVizMessage')).toBeHidden();
});

test('the settings panel shows only the section for each currently-visible canvas', async ({ page }) => {
  await expect(page.locator('#uiMandelbrot')).toBeVisible();
  await expect(page.locator('#uiJulia')).toBeVisible();

  await page.uncheck('#showMandelbrot');
  await expect(page.locator('#uiMandelbrot')).toBeHidden();
  await expect(page.locator('#uiJulia')).toBeVisible();

  await page.uncheck('#showJulia');
  await expect(page.locator('#uiMandelbrot')).toBeHidden();
  await expect(page.locator('#uiJulia')).toBeHidden();

  await page.check('#showMandelbrot');
  await expect(page.locator('#uiMandelbrot')).toBeVisible();
  await expect(page.locator('#uiJulia')).toBeHidden();
});

test('unchecking both panels shows the "No visualization mode selected" placeholder', async ({ page }) => {
  await page.uncheck('#showMandelbrot');
  await page.uncheck('#showJulia');
  await expect(page.locator('#mandelbrotGfx')).toBeHidden();
  await expect(page.locator('#juliaGfx')).toBeHidden();
  await expect(page.locator('#noVizMessage')).toBeVisible();
  await expect(page.locator('#noVizMessage')).toHaveText('No visualization mode selected');

  // Re-checking either panel dismisses it.
  await page.check('#showMandelbrot');
  await expect(page.locator('#noVizMessage')).toBeHidden();
});

test('clicking on the Mandelbrot panel updates the Julia panel, but clicking on the Julia panel does not change juliaSeed', async ({ page }) => {
  const before = await page.evaluate(() => ({ x: window.app.juliaSeed.x, y: window.app.juliaSeed.y }));

  // Click away from the #ui panel, on the Mandelbrot half.
  await page.mouse.click(550, 600);
  await page.waitForTimeout(200);
  const afterMandelbrotClick = await page.evaluate(() => ({ x: window.app.juliaSeed.x, y: window.app.juliaSeed.y }));
  expect(afterMandelbrotClick).not.toEqual(before);

  // Click on the Julia half: juliaSeed must stay unchanged.
  await page.mouse.click(900, 350);
  await page.waitForTimeout(200);
  const afterJuliaClick = await page.evaluate(() => ({ x: window.app.juliaSeed.x, y: window.app.juliaSeed.y }));
  expect(afterJuliaClick).toEqual(afterMandelbrotClick);
});

// Regression test: onPointerDown/onPointerUp never checked which mouse
// button was pressed, so a right-click (button 2) was handled identically
// to a genuine left-click — silently changing juliaSeed and the pivot, and
// leaving the browser's context menu as an unrelated side effect on top.
test('right-clicking on the Mandelbrot panel does not change juliaSeed or pan the view', async ({ page }) => {
  const before = await page.evaluate(() => ({
    juliaSeed: { x: window.app.juliaSeed.x, y: window.app.juliaSeed.y },
    center: { x: window.app.modelNamed("mandelbrot").panel.center.x, y: window.app.modelNamed("mandelbrot").panel.center.y },
  }));

  await page.mouse.click(600, 300, { button: 'right' });
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => ({
    juliaSeed: { x: window.app.juliaSeed.x, y: window.app.juliaSeed.y },
    center: { x: window.app.modelNamed("mandelbrot").panel.center.x, y: window.app.modelNamed("mandelbrot").panel.center.y },
  }));
  expect(after).toEqual(before);
  await expect(page.locator('#backBtn')).toBeDisabled();
});

test('the Julia panel pans/zooms independently of the Mandelbrot panel', async ({ page }) => {
  const mandelbrotScaleBefore = await page.evaluate(() => window.app.modelNamed("mandelbrot").panel.scale);
  const juliaScaleBefore = await page.evaluate(() => window.app.modelNamed("julia").panel.scale);

  await page.mouse.move(900, 350); // over the Julia (right) panel
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(200);

  const mandelbrotScaleAfter = await page.evaluate(() => window.app.modelNamed("mandelbrot").panel.scale);
  const juliaScaleAfter = await page.evaluate(() => window.app.modelNamed("julia").panel.scale);

  expect(mandelbrotScaleAfter).toBe(mandelbrotScaleBefore);
  expect(juliaScaleAfter).not.toBe(juliaScaleBefore);
});

test('toggling panel visibility does not enable Back/Forward (a display preference, not view state)', async ({ page }) => {
  await page.uncheck('#showJulia');
  await page.waitForTimeout(200);
  await expect(page.locator('#backBtn')).toBeDisabled();

  await page.uncheck('#showMandelbrot');
  await page.waitForTimeout(200);
  await expect(page.locator('#backBtn')).toBeDisabled();
});

test('Reset restores the default split-screen view', async ({ page }) => {
  await page.uncheck('#showJulia');
  await page.waitForTimeout(200);

  await page.click('#resetBtn');
  await page.waitForTimeout(200);

  await expect(page.locator('#showMandelbrot')).toBeChecked();
  await expect(page.locator('#showJulia')).toBeChecked();
  await expect(page.locator('#mandelbrotGfx')).toBeVisible();
  await expect(page.locator('#juliaGfx')).toBeVisible();
});

// Regression test: the Julia panel's own pan/zoom is independent of the
// Mandelbrot view history, so Reset used to leave it wherever the user had
// last dragged/zoomed it instead of restoring its initial center/scale.
test('Reset also restores the Julia panel\'s own pan/zoom to its initial state', async ({ page }) => {
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

  const moved = await page.evaluate(() => ({
    center: { x: window.app.modelNamed("julia").panel.center.x, y: window.app.modelNamed("julia").panel.center.y },
    scale: window.app.modelNamed("julia").panel.scale,
  }));
  expect(moved).not.toEqual(initial);

  await page.click('#resetBtn');
  await page.waitForTimeout(200);

  const afterReset = await page.evaluate(() => ({
    center: { x: window.app.modelNamed("julia").panel.center.x, y: window.app.modelNamed("julia").panel.center.y },
    scale: window.app.modelNamed("julia").panel.scale,
  }));
  expect(afterReset).toEqual(initial);
});

// Regression test: loading straight into dual view via a share URL used to
// leave both canvases' backing stores sized for the pre-restore, full-width
// layout (resizeCanvas() ran before the dual-view CSS class was applied),
// stretching the image until the next window resize or panel toggle.
test('loading directly into dual view via a share URL sizes both backing stores to the 50/50 split immediately', async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto('/index.html?v=2&julia=1');

  const gpuError = page.locator('#gpuError');
  await expect(gpuError).toBeHidden();

  const sizes = await page.evaluate(() => ({
    gfxCssWidth: document.getElementById('mandelbrotGfx').getBoundingClientRect().width,
    gfxBackingWidth: document.getElementById('mandelbrotGfx').width,
    juliaCssWidth: document.getElementById('juliaGfx').getBoundingClientRect().width,
    juliaBackingWidth: document.getElementById('juliaGfx').width,
  }));

  const dpr = await page.evaluate(() => window.devicePixelRatio);
  expect(sizes.gfxBackingWidth).toBe(Math.round(sizes.gfxCssWidth * dpr));
  expect(sizes.juliaBackingWidth).toBe(Math.round(sizes.juliaCssWidth * dpr));
  expect(sizes.gfxCssWidth).toBe(VIEWPORT.width / 2);
});
