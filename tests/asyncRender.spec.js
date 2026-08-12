import { test, expect } from '@playwright/test';

// Coverage for spreading one frame's bands across several animation frames.
// A frame at high maxIter is seconds of GPU work; submitting all of its bands
// in one animation frame is what froze the UI until the whole thing drained.
// renderOnce() now hands over a bounded number of bands per frame, shared
// across the visible panels, and blits the offscreen target each time so the
// partial result is actually on screen.
//
// Two things make these tests deterministic despite the budget adapting to
// whatever the machine can do:
//
// - the budget is re-learned per burst (see the second test), so the *first*
//   animation frame of each one always spends exactly
//   INITIAL_FRAME_BAND_BUDGET — a frame of more bands than that is therefore
//   guaranteed to span several animation frames, however fast the hardware;
// - band count comes from the frame's worst case (frameBands), while the real
//   GPU cost comes from the view. Parking the view at center (4,4), where
//   nothing belongs to the set, gives a high band count for pixels that all
//   escape within a couple of iterations — so SwiftShader stays fast.

const VIEWPORT = { width: 1280, height: 720 };
// 19 bands at this viewport, comfortably above the initial budget of 4.
const MAX_ITER = 2048;

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

test('a frame with more bands than one animation frame can carry lands over several', async ({ page }) => {
  const result = await page.evaluate(async (maxIter) => {
    const { INITIAL_FRAME_BAND_BUDGET } = await import('/src/renderer.js');
    const model = window.app.modelNamed("mandelbrot");
    const panel = model.panel;

    panel.center = new DOMPointReadOnly(4, 4); // nothing here belongs to the set
    window.app.setMaxIter(model, maxIter);
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

    return { initial: INITIAL_FRAME_BAND_BUDGET, bandCount: panel.lastTileBandCount, pendingPerFrame };
  }, MAX_ITER);

  // The premise the rest of the test rests on, asserted rather than assumed.
  expect(result.bandCount).toBeGreaterThan(result.initial);

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

test('the band budget is re-learned per burst instead of carried into the next one', async ({ page }) => {
  // Carrying the budget across bursts would let a run of cheap one-frame
  // interactions walk it up toward its ceiling, so the next expensive frame
  // would hand the GPU the whole ceiling's worth at once — the freeze the
  // per-frame budget exists to prevent.
  const result = await page.evaluate(async (maxIter) => {
    const { INITIAL_FRAME_BAND_BUDGET } = await import('/src/renderer.js');
    const model = window.app.modelNamed("mandelbrot");
    const panel = model.panel;

    panel.center = new DOMPointReadOnly(4, 4);
    window.app.setMaxIter(model, maxIter);
    panel.invalidateRender();
    window.app.scheduleRender();

    // This frame's bands drain over several animation frames, so the
    // controller takes measurements and moves the budget off its starting
    // value. The poll runs after the app's own callback each frame, so seeing
    // rafPending false means the app chose not to re-arm: the burst is over
    // and its final callback — the one that resets — has already run.
    const seen = new Set();
    await new Promise((resolve) => {
      let frames = 0;
      const check = () => {
        seen.add(window.app.bandBudget);
        if (panel.renderer.pendingBands === 0 && !window.app.rafPending) { resolve(); return; }
        if (++frames > 600) { resolve(); return; } // safety net, never reached when healthy
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });

    return {
      initial: INITIAL_FRAME_BAND_BUDGET,
      budgetsSeen: [...seen],
      budgetAfterBurst: window.app.bandBudget,
    };
  }, MAX_ITER);

  // Non-vacuous: the controller really did move the budget while the burst ran
  // (up or down — either direction proves it was live).
  expect(result.budgetsSeen.some((b) => b !== result.initial)).toBe(true);
  // And the next burst will start from the initial value regardless.
  expect(result.budgetAfterBurst).toBe(result.initial);
});

test("a panel's progressive ramp waits for its current frame instead of restarting it every frame", async ({ page }) => {
  // Without the gate, progressiveIter would step on every animation frame,
  // so every frame would start a fresh render job and abandon it a band or
  // two in: the top of the canvas would be redrawn forever at ever-higher
  // iteration counts and the bottom would never be drawn at all. The ramp
  // must therefore never step while bands are still pending.
  const result = await page.evaluate(async (maxIter) => {
    const model = window.app.modelNamed("mandelbrot");
    const panel = model.panel;

    panel.center = new DOMPointReadOnly(4, 4);
    window.app.setMaxIter(model, maxIter);
    panel.progressiveMode = 1;
    // Start the ramp high enough that each of its remaining steps is a frame
    // of more bands than one animation frame carries. Climbing there from
    // progressiveIter = 1 would be dozens of cheap steps with nothing to
    // observe.
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
        if (panel.lastDisplayIter >= maxIter && now.pending === 0) { resolve(); return; }
        if (++frames > 600) { resolve(); return; } // safety net, never reached when healthy
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    return { violations, framesWithWorkLeft, reachedCap: panel.lastDisplayIter };
  }, MAX_ITER);

  // Non-vacuous: the ramp really did run while bands were outstanding.
  expect(result.framesWithWorkLeft).toBeGreaterThan(0);
  expect(result.violations).toBe(0);
  // And gating the ramp doesn't stall it — it still reaches maxIter.
  expect(result.reachedCap).toBe(MAX_ITER);
});
