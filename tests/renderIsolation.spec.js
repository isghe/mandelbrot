import { test, expect } from '@playwright/test';

// Coverage for per-panel render skip: a panel whose next frame would be
// pixel-identical to its last one must not be re-submitted to the GPU.
// Before this fix, renderOnce() (mandelbrot.js) unconditionally rendered
// every visible panel on every animation frame, so an idle panel got redrawn
// in lockstep with whichever panel was actually changing (e.g. Julia's
// progressive reveal crawling while Mandelbrot sat idle at a high,
// unchanging maxIter).
//
// beginFrame is the thing counted below: it's the one call that starts a
// panel's frame, so counting it counts exactly the decision under test (does
// this panel get a new frame at all), independent of how many animation
// frames that frame's bands are then spread over.

test.beforeEach(async ({ page }) => {
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.setViewportSize({ width: 1280, height: 720 });
  // Dual view: Mandelbrot parked (not progressive) at a fixed maxIter, Julia
  // progressive with its own (different) maxIter — same convention as
  // progressive.spec.js's "independent ramps" test.
  await page.goto('/index.html?v=5&mandelbrot=1&julia=1&iter=64&jprogressive=1&jiter=32');

  const gpuError = page.locator('#gpuError');
  if (await gpuError.isVisible()) {
    const message = await page.locator('#gpuErrorMessage').textContent();
    throw new Error(
      `WebGPU failed to initialize: ${message}\nConsole errors:\n${consoleErrors.join('\n')}`
    );
  }
  await page.waitForFunction(() => window.app.modelNamed("mandelbrot").panel.renderer != null);
  await page.waitForFunction(() => window.app.modelNamed("julia").panel.renderer != null);
  // Let Mandelbrot's own (non-progressive) render settle before measuring.
  await expect.poll(async () => {
    return page.evaluate(() => window.app.modelNamed("mandelbrot").panel.lastDisplayIter);
  }, { timeout: 15000 }).toBe(64);
});

test("an unchanged panel isn't re-rendered while the other panel's progressive ramp advances", async ({ page }) => {
  const counts = await page.evaluate(async () => {
    const mandelbrotPanel = window.app.modelNamed("mandelbrot").panel;
    const juliaModel = window.app.modelNamed("julia");

    let mandelbrotRenders = 0;
    let juliaRenders = 0;
    const origMandelbrotRender = mandelbrotPanel.renderer.beginFrame;
    mandelbrotPanel.renderer.beginFrame = (...args) => { mandelbrotRenders++; return origMandelbrotRender.apply(mandelbrotPanel.renderer, args); };
    const origJuliaRender = juliaModel.panel.renderer.beginFrame;
    juliaModel.panel.renderer.beginFrame = (...args) => { juliaRenders++; return origJuliaRender.apply(juliaModel.panel.renderer, args); };

    // Re-drive Julia's ramp from scratch so its multi-frame climb to maxIter
    // happens entirely inside the measurement window.
    window.app.resetProgressive(juliaModel.panel);
    window.app.scheduleRender();

    await new Promise((resolve) => {
      const check = () => {
        if (juliaModel.panel.lastDisplayIter >= 32) { resolve(); return; }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });

    mandelbrotPanel.renderer.beginFrame = origMandelbrotRender;
    juliaModel.panel.renderer.beginFrame = origJuliaRender;
    return { mandelbrotRenders, juliaRenders };
  });

  expect(counts.juliaRenders).toBeGreaterThan(1);
  expect(counts.mandelbrotRenders).toBe(0);
});

test('changing a panel\'s own state still triggers its own render', async ({ page }) => {
  const rendered = await page.evaluate(async () => {
    const model = window.app.modelNamed("mandelbrot");
    let renders = 0;
    const origRender = model.panel.renderer.beginFrame;
    model.panel.renderer.beginFrame = (...args) => { renders++; return origRender.apply(model.panel.renderer, args); };

    window.app.setMaxIter(model, 128);
    window.app.resetProgressive(model.panel);
    window.app.scheduleRender();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    model.panel.renderer.beginFrame = origRender;
    return renders;
  });

  expect(rendered).toBeGreaterThan(0);
});
