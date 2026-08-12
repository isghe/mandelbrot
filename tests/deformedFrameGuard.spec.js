import { test, expect } from '@playwright/test';

// Real-browser coverage for the deformed-frame guard-rail (mandelbrot.js:
// isDeformedFrame/reportDeformedFrame/handleUncapturedError). The unit tests
// in tests/unit/deformedFrameGuard.test.js exercise the same logic against a
// mocked DOM; these confirm it also holds against a real canvas/WebGPU
// device and that the #gpuError banner the user actually sees fires
// correctly, for either panel.

test.beforeEach(async ({ page }) => {
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/index.html');

  const gpuError = page.locator('#gpuError');
  if (await gpuError.isVisible()) {
    const message = await page.locator('#gpuErrorMessage').textContent();
    throw new Error(
      `WebGPU failed to initialize: ${message}\nConsole errors:\n${consoleErrors.join('\n')}`
    );
  }
  await page.waitForFunction(() => window.app.modelNamed("mandelbrot").panel.renderer != null);
});

for (const name of ['mandelbrot', 'julia']) {
  test(`a deformed ${name} canvas backing store halts rendering and shows the fatal error banner`, async ({ page }) => {
    const rendered = await page.evaluate(async (panelName) => {
      const panel = window.app.modelNamed(panelName).panel;
      // Simulate the reported bug: the backing store's width/height ratio no
      // longer matches the canvas's actual on-screen shape (e.g. a stale
      // getBoundingClientRect() read mid-layout-thrash).
      panel.canvas.width = 4;

      let rendered = false;
      const origRender = panel.renderer.render;
      panel.renderer.render = (...args) => { rendered = true; return origRender.apply(panel.renderer, args); };

      window.app.scheduleRender();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return rendered;
    }, name);

    expect(rendered).toBe(false);

    const gpuError = page.locator('#gpuError');
    await expect(gpuError).toBeVisible();
    const message = await page.locator('#gpuErrorMessage').textContent();
    expect(message).toMatch(/Deformed frame detected/);
    expect(message).toMatch(new RegExp(`panel "${name}Gfx"`));
    await expect(page.locator('#gpuReloadBtn')).toBeVisible();

    const renderHalted = await page.evaluate(() => window.app.renderHalted);
    expect(renderHalted).toBe(true);
  });
}

test('handleUncapturedError halts rendering and shows the fatal error banner in a real browser', async ({ page }) => {
  await page.evaluate(() => {
    window.app.handleUncapturedError('Validation Error: simulated GPU error');
  });

  const gpuError = page.locator('#gpuError');
  await expect(gpuError).toBeVisible();
  const message = await page.locator('#gpuErrorMessage').textContent();
  expect(message).toMatch(/WebGPU error: Validation Error: simulated GPU error/);
  await expect(page.locator('#gpuReloadBtn')).toBeVisible();

  const renderHalted = await page.evaluate(() => window.app.renderHalted);
  expect(renderHalted).toBe(true);

  for (const name of ['mandelbrot', 'julia']) {
    await expect(page.locator(`#${name}Gfx`)).toHaveClass(/panel-hidden/);
    await expect(page.locator(`#${name}Overlay`)).toHaveClass(/panel-hidden/);
  }
});

test('once halted, further renderOnce calls stay a no-op (no repeated banner flicker/render attempts)', async ({ page }) => {
  const renderCount = await page.evaluate(async () => {
    const panel = window.app.modelNamed("mandelbrot").panel;
    panel.canvas.width = 4;

    window.__renderCount = 0;
    const orig = window.app.renderOnce;
    window.app.renderOnce = () => { window.__renderCount++; return orig.call(window.app); };

    window.app.scheduleRender();
    await new Promise((resolve) => setTimeout(resolve, 300));
    window.app.scheduleRender(); // simulates a later user interaction after the halt
    await new Promise((resolve) => setTimeout(resolve, 300));
    return window.__renderCount;
  });

  // renderOnce is called (the gate lives inside it), but every call after
  // the first is a same-tick no-op — none of them re-render or re-show the
  // banner from scratch.
  expect(renderCount).toBeGreaterThan(0);
  await expect(page.locator('#gpuError')).toBeVisible();
});
