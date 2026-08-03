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
  await expect.poll(async () => {
    return page.evaluate(() => window.app.lastDisplayIter);
  }, { timeout: 15000 }).toBe(64);
});
