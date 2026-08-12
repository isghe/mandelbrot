import { test, expect } from '@playwright/test';

// Coverage for spreading one frame's bands across several animation frames.
// A frame at high maxIter is seconds of GPU work; submitting all of its bands
// in one animation frame is what froze the UI until the whole thing drained.
// renderOnce() now hands over at most FRAME_BAND_BUDGET bands per frame,
// shared across the visible panels, and blits the offscreen target each time
// so the partial result is actually on screen.

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
  await page.uncheck('#showJulia');
});

test('a frame with more bands than the per-frame budget takes several animation frames to land', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { FRAME_BAND_BUDGET } = await import('/src/renderer.js');
    const model = window.app.modelNamed("mandelbrot");
    const panel = model.panel;

    // maxIter 2048 puts the band count well above the budget, while the
    // default (fully zoomed out) view keeps the real GPU cost low: almost
    // every pixel escapes within a few iterations, so SwiftShader still
    // gets through it quickly. Band count comes from the worst case, which
    // is the point — that's what the budget is spending.
    window.app.setMaxIter(model, 2048);
    panel.invalidateRender();
    window.app.scheduleRender();

    // Sample how many bands are still pending at the end of each animation
    // frame, until the frame has fully landed.
    const pendingPerFrame = [];
    await new Promise((resolve) => {
      const check = () => {
        pendingPerFrame.push(panel.renderer.pendingBands);
        if (panel.lastTileBandCount > 0 && panel.renderer.pendingBands === 0) { resolve(); return; }
        if (pendingPerFrame.length > 600) { resolve(); return; } // safety net, never reached when healthy
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });

    return { budget: FRAME_BAND_BUDGET, bandCount: panel.lastTileBandCount, pendingPerFrame };
  });

  expect(result.bandCount).toBeGreaterThan(result.budget);

  // The frame is not submitted in one go: at least one animation frame ended
  // with bands still outstanding.
  const framesWithWorkLeft = result.pendingPerFrame.filter((n) => n > 0).length;
  expect(framesWithWorkLeft).toBeGreaterThan(0);

  // …and it drains monotonically, no band count going back up (which would
  // mean the frame was being restarted instead of continued).
  const drained = result.pendingPerFrame.filter((n) => n > 0);
  for (let i = 1; i < drained.length; i++) {
    expect(drained[i]).toBeLessThan(drained[i - 1]);
  }

  // It does finish, rather than stalling with bands left over.
  expect(result.pendingPerFrame.at(-1)).toBe(0);
});

test("a panel's progressive ramp waits for its current frame instead of restarting it every frame", async ({ page }) => {
  // Without the gate, progressiveIter would step on every animation frame,
  // so every frame would start a fresh render job and abandon it a band or
  // two in: the top of the canvas would be redrawn forever at ever-higher
  // iteration counts and the bottom would never be drawn at all. The ramp
  // must therefore never step while bands are still pending.
  const result = await page.evaluate(async () => {
    const model = window.app.modelNamed("mandelbrot");
    const panel = model.panel;

    window.app.setMaxIter(model, 2048);
    panel.progressiveMode = 1;
    // Start the ramp already high enough that each of its steps is a frame of
    // more bands than one animation frame's budget — the regime where the
    // gate matters. Climbing there from progressiveIter = 1 would be ~45
    // cheap steps of nothing to observe, and slow under SwiftShader.
    panel.progressiveIter = 1500;
    panel.invalidateRender();
    window.app.scheduleRender();

    // Each sample pairs "bands still pending" with the ramp position, read at
    // the same point in the frame; a step recorded while the previous sample
    // still had bands pending is exactly the bug.
    let violations = 0;
    let framesWithWorkLeft = 0;
    let prev = { pending: 0, iter: panel.progressiveIter };
    await new Promise((resolve) => {
      let frames = 0;
      const check = () => {
        const now = { pending: panel.renderer.pendingBands, iter: panel.progressiveIter };
        if (prev.pending > 0) {
          framesWithWorkLeft++;
          if (now.iter !== prev.iter) violations++;
        }
        prev = now;
        if (panel.lastDisplayIter >= 2048 && now.pending === 0) { resolve(); return; }
        if (++frames > 300) { resolve(); return; } // safety net, never reached when healthy
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    return { violations, framesWithWorkLeft, reachedCap: panel.lastDisplayIter };
  });

  // Non-vacuous: the ramp really did run while bands were outstanding.
  expect(result.framesWithWorkLeft).toBeGreaterThan(0);
  expect(result.violations).toBe(0);
  // And gating the ramp doesn't stall it — it still reaches maxIter.
  expect(result.reachedCap).toBe(2048);
});
