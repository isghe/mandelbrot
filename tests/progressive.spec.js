import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/index.html?progressive=1&iter=64');

  const gpuError = page.locator('#gpuError');
  if (await gpuError.isVisible()) {
    const message = await page.locator('#gpuErrorMessage').textContent();
    throw new Error(
      `WebGPU failed to initialize: ${message}\nConsole errors:\n${consoleErrors.join('\n')}`
    );
  }
});

// Regression test for a bug where the progressive-reveal ramp
// (progressiveIter in mandelbrot.js) stopped scheduling frames one step too
// early: scheduleRender() decided whether to continue based on
// progressiveIter *after* renderOnce() had already incremented it for the
// next frame, so the frame that would render at exactly maxIter was skipped
// and the ramp visibly stalled just short of the target iteration count.
test('progressive mode ramp actually renders a frame at maxIter', async ({ page }) => {
  // window.app.lastDisplayIter reflects whichever panel rendered last each
  // frame — with both panels shown by default, that's ambiguous (it'd track
  // Julia's own ramp, not Mandelbrot's, since Julia renders after Mandelbrot
  // each frame). Read Mandelbrot's own field directly instead.
  await expect.poll(async () => {
    return page.evaluate(() => window.app.mandelbrotPanel.lastDisplayIter);
  }, { timeout: 15000 }).toBe(64);
});

// Coverage for the per-panel progressive ramp (Mossa 1): each panel now owns
// its own progressiveIter/maxIter, so a dual-view session with different
// per-panel iteration caps must let each ramp reach its *own* target
// independently rather than sharing a single app-wide ramp.
test('progressive ramps are independent per panel — Julia reaches its own (different) maxIter', async ({ page }) => {
  await page.goto('/index.html?v=5&progressive=1&iter=64&mandelbrot=1&julia=1&jprogressive=1&jiter=32');
  const gpuError = page.locator('#gpuError');
  await expect(gpuError).toBeHidden();

  await expect.poll(async () => {
    return page.evaluate(() => window.app.mandelbrotPanel.lastDisplayIter);
  }, { timeout: 15000 }).toBe(64);
  await expect.poll(async () => {
    return page.evaluate(() => window.app.juliaPanel?.lastDisplayIter);
  }, { timeout: 15000 }).toBe(32);
});

// Regression test for a bug introduced while fixing the above: renderOnce()'s
// early-return guard (deviceLost/no renderer) used -Infinity as its sentinel,
// which is always < maxIter — so with progressive mode on, scheduleRender()
// kept re-arming itself every animation frame forever instead of stopping,
// once the device was lost mid-ramp.
test('device loss stops the progressive re-arm instead of looping every frame', async ({ page }) => {
  // initGPU() itself calls scheduleRender() once, right after its own async
  // WebGPU setup resolves — asserting a render *count* before that startup
  // call has landed races it, and can count that unrelated call as a bogus
  // second progressive re-arm. Wait for it to settle first.
  await page.waitForFunction(() => window.app.mandelbrotPanel.renderer != null);

  const renderCount = await page.evaluate(async () => {
    window.__renderCount = 0;
    const orig = window.app.renderOnce;
    window.app.renderOnce = () => { window.__renderCount++; return orig.call(window.app); };

    window.app.mandelbrotPanel.progressiveMode = true;
    window.app.deviceLost = true;
    window.app.scheduleRender();

    // ~30 animation frames' worth of wall time; a looping bug would keep
    // incrementing __renderCount throughout this window.
    await new Promise((resolve) => setTimeout(resolve, 500));
    return window.__renderCount;
  });

  expect(renderCount).toBe(1);
});
