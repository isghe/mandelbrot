import { test, expect } from '@playwright/test';

// Real-browser coverage for the frame-tiling fix in renderer.js: splitting
// each frame into scissored horizontal bands, each its own queue.submit(),
// so no single submit is long enough to trip the GPU driver's TDR watchdog
// at high maxIter. The pure banding math (frameBands) is covered in
// tests/unit/renderer.test.js; these confirm the tiling is actually wired
// up against a real WebGPU device and that no band is left undrawn.

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
  await page.waitForFunction(() => window.app.modelNamed("mandelbrot").panel.renderer != null);
  // Isolate the Mandelbrot canvas at full viewport width, same convention as
  // overlay.spec.js — keeps the band math (canvas.width) predictable.
  await page.uncheck('#showJulia');
});

test('a default-sized frame is split into multiple submits, not one', async ({ page }) => {
  // At the default viewport/maxIter (1280x720, 256), the worst-case work
  // already exceeds BAND_WORK_BUDGET, so this needs no maxIter bump — good,
  // since SwiftShader (software WebGPU) makes a real high-maxIter render slow.
  const { submitCount, bandCount } = await page.evaluate(async () => {
    const panel = window.app.modelNamed("mandelbrot").panel;
    let submitCount = 0;
    const origSubmit = window.app.gpuDevice.queue.submit;
    window.app.gpuDevice.queue.submit = (...args) => { submitCount++; return origSubmit.apply(window.app.gpuDevice.queue, args); };

    window.app.scheduleRender();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    window.app.gpuDevice.queue.submit = origSubmit;
    return { submitCount, bandCount: panel.lastTileBandCount };
  });

  expect(bandCount).toBeGreaterThan(1);
  expect(submitCount).toBe(bandCount);
});

test('every band is actually drawn — no band is left blank by a stray clear', async ({ page }) => {
  const panelInfo = await page.evaluate(async () => {
    const panel = window.app.modelNamed("mandelbrot").panel;
    window.app.scheduleRender();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await window.app.gpuDevice.queue.onSubmittedWorkDone();

    const { frameBands } = await import('/src/renderer.js');
    const bands = frameBands(panel.canvas.width, panel.canvas.height, panel.lastDisplayIter);
    const rect = panel.canvas.getBoundingClientRect();
    return { bands, canvasWidth: panel.canvas.width, canvasHeight: panel.canvas.height, rect };
  });

  expect(panelInfo.bands.length).toBeGreaterThan(1);

  // A real compositor screenshot, not a raw canvas readback: reading a
  // WebGPU canvas's backing store directly (createImageBitmap/drawImage) was
  // observed to yield all-transparent pixels under headless SwiftShader —
  // whereas Playwright's screenshot (used elsewhere in this suite, e.g.
  // history.spec.js/overlay.spec.js) captures the actually-composited frame.
  const png = await page.screenshot({
    clip: { x: panelInfo.rect.x, y: panelInfo.rect.y, width: panelInfo.rect.width, height: panelInfo.rect.height },
  });

  // Decode the PNG back in-page (the browser's own decoder) rather than
  // pulling in a PNG-decoding dependency for this one check.
  const bandsWithContent = await page.evaluate(async ({ dataUrl, bands, canvasWidth, canvasHeight }) => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');
    // The screenshot is in CSS pixels; scale up to the backing-store
    // resolution the bands were computed against.
    ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);
    const { data } = ctx.getImageData(0, 0, canvasWidth, canvasHeight);

    let bandsWithContent = 0;
    for (const band of bands) {
      const distinct = new Set();
      const y = band.y + Math.floor(band.height / 2);
      for (let x = 0; x < canvasWidth; x += 7) {
        const i = (y * canvasWidth + x) * 4;
        distinct.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
        if (distinct.size > 1) break;
      }
      if (distinct.size > 1) bandsWithContent++;
    }
    return bandsWithContent;
  }, {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    bands: panelInfo.bands,
    canvasWidth: panelInfo.canvasWidth,
    canvasHeight: panelInfo.canvasHeight,
  });

  expect(bandsWithContent).toBe(panelInfo.bands.length);
});
