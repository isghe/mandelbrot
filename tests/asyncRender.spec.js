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
// Band count these tests aim for: well above the initial per-frame budget of
// 4, so a frame is guaranteed to span several animation frames, and no higher
// than it needs to be — each animation frame of a drain costs one blit, and
// under SwiftShader that blit is software-rasterized and far from free.
const TARGET_BANDS = 20;

// A cleared row, as sampleColumn reports it.
const BLACK = '0,0,0';

// The maxIter that produces roughly TARGET_BANDS bands, derived from
// BAND_WORK_BUDGET instead of hardcoded. That constant is tuned against real
// hardware and has already moved once; these tests are about how a frame is
// spread over animation frames, not about any particular band size, so they
// should follow it rather than silently drift into being vacuous (too few
// bands) or slow (too many).
async function maxIterForTargetBands(page) {
  return page.evaluate(async (targetBands) => {
    const { BAND_WORK_BUDGET } = await import('/src/renderer.js');
    const canvas = window.app.modelNamed("mandelbrot").panel.canvas;
    const rows = Math.max(1, Math.floor(canvas.height / targetBands));
    return Math.max(1, Math.min(8192, Math.floor(BAND_WORK_BUDGET / (canvas.width * rows))));
  }, TARGET_BANDS);
}

// Reads a few pixels down the middle of the panel out of a real compositor
// screenshot. Not a canvas readback: reading a WebGPU canvas's backing store
// directly (createImageBitmap/drawImage) was observed to yield all-transparent
// pixels under headless SwiftShader, whereas Playwright's screenshot captures
// the actually-composited frame. Decoding happens back in the page, using the
// browser's own PNG decoder rather than a dependency for this one check.
async function sampleColumn(page, rect, ys) {
  const png = await page.screenshot({ clip: rect });
  return page.evaluate(async ({ dataUrl, ys, width, height }) => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    const x = Math.floor(width / 2);
    return ys.map((y) => {
      const i = (Math.floor(y) * width + x) * 4;
      return `${data[i]},${data[i + 1]},${data[i + 2]}`;
    });
  }, {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    ys,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
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
  await page.waitForFunction(() => window.app.modelNamed("mandelbrot").panel.renderer != null);
  await page.uncheck('#showJulia');
});

test('a frame with more bands than one animation frame can carry lands over several', async ({ page }) => {
  const maxIter = await maxIterForTargetBands(page);
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
  }, maxIter);

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
  const maxIter = await maxIterForTargetBands(page);
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
  }, maxIter);

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
  const maxIter = await maxIterForTargetBands(page);
  const result = await page.evaluate(async (maxIter) => {
    const model = window.app.modelNamed("mandelbrot");
    const panel = model.panel;

    panel.center = new DOMPointReadOnly(4, 4);
    window.app.setMaxIter(model, maxIter);
    panel.progressiveMode = 1;
    // Start the ramp near its cap, so each of the handful of steps left is a
    // frame of more bands than one animation frame carries. Climbing there
    // from progressiveIter = 1 would be dozens of cheap steps with nothing to
    // observe. Expressed as a fraction of maxIter because maxIter itself is
    // derived from the band budget (see maxIterForTargetBands).
    panel.progressiveIter = Math.round(maxIter * 0.7);
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
  }, maxIter);

  // Non-vacuous: the ramp really did run while bands were outstanding.
  expect(result.framesWithWorkLeft).toBeGreaterThan(0);
  expect(result.violations).toBe(0);
  // And gating the ramp doesn't stall it — it still reaches maxIter.
  expect(result.reachedCap).toBe(maxIter);
});

test('a partly landed frame is already on screen, with the view it moved off cleared', async ({ page }) => {
  // The user-facing point of the whole mechanism, and the one thing nothing
  // else here would notice: a frame reveals itself top-down rather than the
  // panel sitting on the old frame until every band is in. A blit that only
  // ever showed completed frames would pass every other test in this file.
  //
  // Moving the view also clears what was there, so the rows not yet drawn read
  // as black instead of as a picture of somewhere else (see
  // fractalPanel.js's sameViewGeometry). The companion test below covers the
  // other half of that rule.
  //
  // Both views are deliberately flat single-colour: one where every pixel
  // escapes on the first iteration, one entirely inside the main cardioid
  // where no pixel escapes at all. That makes "which view is this row from"
  // a single pixel comparison, with no dependence on fractal detail.
  //
  // Palette 5 ("Black and White - Red") is the one that keeps those two
  // colours apart. Every other palette leaves `interior` unset and so paints
  // non-escaping points black (see palette.js), which is also where an
  // escape-on-the-first-iteration point lands — both views would come out
  // black and the comparison would be vacuous. Palette 5 is banded, so an
  // escape at iteration 1 indexes colour 1 (white) directly, against its
  // explicit red interior.
  const maxIter = await maxIterForTargetBands(page);
  const rect = await page.evaluate(async (maxIter) => {
    const model = window.app.modelNamed("mandelbrot");
    const panel = model.panel;
    window.app.setMaxIter(model, maxIter);
    window.app.applyPalette(model, 5);

    panel.center = new DOMPointReadOnly(4, 4); // nothing here belongs to the set
    panel.scale = 3;
    panel.invalidateRender();
    window.app.scheduleRender();
    await new Promise((resolve) => {
      let frames = 0;
      const check = () => {
        if (panel.renderer.pendingBands === 0 && !window.app.rafPending) { resolve(); return; }
        if (++frames > 600) { resolve(); return; }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });

    const r = panel.canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, maxIter);

  const near = { top: 10, bottom: Math.round(rect.height) - 10 };
  const [outsideTop, outsideBottom] = await sampleColumn(page, rect, [near.top, near.bottom]);
  expect(outsideTop).toBe(outsideBottom); // the first view really is uniform

  // Switch to the second view and stop the drain after a single animation
  // frame, so what's on screen is a genuinely half-finished frame.
  const landed = await page.evaluate(async () => {
    const panel = window.app.modelNamed("mandelbrot").panel;

    panel.center = new DOMPointReadOnly(0, 0); // deep inside the main cardioid
    panel.scale = 0.01;
    window.app.scheduleRender();
    // One animation frame: the app's own callback was registered first, so by
    // the time this resolves it has begun the frame and submitted its first
    // budget's worth of bands.
    await new Promise((resolve) => requestAnimationFrame(resolve));

    // Freeze the drain where it is. present() keeps running, re-blitting the
    // same half-drawn offscreen target, so the screenshot below is stable.
    window.__origAdvanceFrame = panel.renderer.advanceFrame;
    panel.renderer.advanceFrame = () => 0;

    return { total: panel.lastTileBandCount, pending: panel.renderer.pendingBands };
  });

  // The premise: some of the new frame is in, and some of it isn't.
  expect(landed.pending).toBeGreaterThan(0);
  expect(landed.total - landed.pending).toBeGreaterThan(0);

  const [partialTop, partialBottom] = await sampleColumn(page, rect, [near.top, near.bottom]);
  // Top of the panel already shows the new view…
  expect(partialTop).not.toBe(outsideTop);
  // …and the rows it hasn't reached were cleared rather than left showing the
  // view the panel moved off. Asserting the old view wasn't black to begin
  // with keeps that from passing vacuously.
  expect(outsideBottom).not.toBe(BLACK);
  expect(partialBottom).toBe(BLACK);

  // Let it finish: the whole panel ends up on the new view.
  await page.evaluate(async () => {
    const panel = window.app.modelNamed("mandelbrot").panel;
    panel.renderer.advanceFrame = window.__origAdvanceFrame;
    window.app.scheduleRender();
    await new Promise((resolve) => {
      let frames = 0;
      const check = () => {
        if (panel.renderer.pendingBands === 0 && !window.app.rafPending) { resolve(); return; }
        if (++frames > 600) { resolve(); return; }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  });

  const [finalTop, finalBottom] = await sampleColumn(page, rect, [near.top, near.bottom]);
  expect(finalTop).toBe(partialTop);
  expect(finalBottom).toBe(partialTop);
});

test('a frame that only recolours the same view keeps the old image underneath', async ({ page }) => {
  // The other half of the clear rule, and the reason it isn't simply "clear on
  // every new frame": the progressive ramp starts a fresh frame at every step,
  // so blanking the panel for anything but a view change would make the whole
  // reveal strobe. A change of palette is the same view in different colours,
  // exactly like a ramp step is the same view at a finer iteration count.
  const maxIter = await maxIterForTargetBands(page);
  const rect = await page.evaluate(async (maxIter) => {
    const model = window.app.modelNamed("mandelbrot");
    const panel = model.panel;
    window.app.setMaxIter(model, maxIter);
    window.app.applyPalette(model, 5);

    panel.center = new DOMPointReadOnly(4, 4); // flat: every pixel escapes at once
    panel.scale = 3;
    panel.invalidateRender();
    window.app.scheduleRender();
    await new Promise((resolve) => {
      let frames = 0;
      const check = () => {
        if (panel.renderer.pendingBands === 0 && !window.app.rafPending) { resolve(); return; }
        if (++frames > 600) { resolve(); return; }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });

    const r = panel.canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, maxIter);

  const near = { top: 10, bottom: Math.round(rect.height) - 10 };
  const [beforeTop, beforeBottom] = await sampleColumn(page, rect, [near.top, near.bottom]);
  expect(beforeTop).toBe(beforeBottom);
  expect(beforeTop).not.toBe(BLACK);

  // Recolour without touching the view, then freeze after one animation frame.
  const landed = await page.evaluate(async () => {
    const model = window.app.modelNamed("mandelbrot");
    const panel = model.panel;

    // Palette 0 is a gradient, so an escape at iteration 1 lands at t≈0 on its
    // first colour — a dark purple, distinct from palette 5's white. Palette 6
    // would not do: it is banded on the same colour list whose entry 1 is also
    // white, and the comparison below would be vacuous.
    window.app.applyPalette(model, 0); // same geometry, different colours
    window.app.scheduleRender();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    window.__origAdvanceFrame = panel.renderer.advanceFrame;
    panel.renderer.advanceFrame = () => 0;

    return { total: panel.lastTileBandCount, pending: panel.renderer.pendingBands };
  });

  expect(landed.pending).toBeGreaterThan(0);
  expect(landed.total - landed.pending).toBeGreaterThan(0);

  const [partialTop, partialBottom] = await sampleColumn(page, rect, [near.top, near.bottom]);
  // The recoloured rows really did change…
  expect(partialTop).not.toBe(beforeTop);
  // …and the rows still to come kept the previous colours rather than going
  // black, which is what a ramp step relies on.
  expect(partialBottom).toBe(beforeBottom);

  await page.evaluate(async () => {
    const panel = window.app.modelNamed("mandelbrot").panel;
    panel.renderer.advanceFrame = window.__origAdvanceFrame;
    window.app.scheduleRender();
    await new Promise((resolve) => {
      let frames = 0;
      const check = () => {
        if (panel.renderer.pendingBands === 0 && !window.app.rafPending) { resolve(); return; }
        if (++frames > 600) { resolve(); return; }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  });

  const [finalTop, finalBottom] = await sampleColumn(page, rect, [near.top, near.bottom]);
  expect(finalTop).toBe(partialTop);
  expect(finalBottom).toBe(partialTop);
});
