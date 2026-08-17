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
// The screenshot captures the whole composited page, so fixed decorative
// chrome (repo link, motto) overlapping a sampled row would leak into the
// pixels; hide it for the duration of the capture. Keyed on the markup's
// data-chrome attribute, not on specific elements, so the chrome can change
// freely without touching this suite.
async function screenshotSansChrome(page, options) {
  const setChromeVisibility = (visibility) => page.evaluate((v) => {
    for (const el of document.querySelectorAll('[data-chrome="decorative"]')) {
      el.style.visibility = v;
    }
  }, visibility);
  await setChromeVisibility('hidden');
  try {
    return await page.screenshot(options);
  } finally {
    await setChromeVisibility('');
  }
}

// Only ever reads a single column (the panel's horizontal midpoint) at a
// handful of y offsets, so the capture itself is clipped to that 1px-wide
// column instead of the whole panel — same pixels read, a fraction of the
// area for the compositor/PNG encoder to do under software-rendered WebGPU.
async function sampleColumn(page, rect, ys) {
  const clip = { x: rect.x + Math.floor(rect.width / 2), y: rect.y, width: 1, height: rect.height };
  const png = await screenshotSansChrome(page, { clip });
  return page.evaluate(async ({ dataUrl, ys, height }) => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, 1, height);
    const { data } = ctx.getImageData(0, 0, 1, height);
    return ys.map((y) => {
      const i = Math.floor(y) * 4;
      return `${data[i]},${data[i + 1]},${data[i + 2]}`;
    });
  }, {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    ys,
    height: Math.round(rect.height),
  });
}

// Several tests here already run 15-30s on an idle machine (multi-band
// drains, each animation frame paying a software-rasterized blit under
// SwiftShader) — too close to the default 30s budget to survive any real
// host contention.
test.describe.configure({ timeout: 90_000 });

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

test('a recolour that lands mid-drain of a same-view refinement is atomic, not torn', async ({ page }) => {
  // The other half of the clear rule, and the reason it isn't simply "clear on
  // every new frame": the progressive ramp starts a fresh frame at every step,
  // so blanking the panel for anything but a view change would make the whole
  // reveal strobe. A change of palette is the same view in different colours,
  // exactly like a ramp step is the same view at a finer iteration count.
  //
  // What a half-landed recolour looks like changed when the shader split into
  // an iterate pass and a colorize pass. It used to tear: the bands that had
  // landed carried the new palette baked in, the ones still queued carried the
  // old one, so the panel showed both at once until the frame finished. Now the
  // palette is applied when the target is put on screen, not when a band is
  // computed, so it reaches every pixel at once — a recolour is a single
  // present() over the whole target, whatever mix of old and fresh escape data
  // is sitting in it.
  //
  // A recolour queues no band of its own (see FractalPanel.needsRecolorOnly),
  // so to actually observe a torn-vs-atomic difference this needs a genuine
  // compute-changing refinement in flight when the recolour lands: a higher
  // maxIter, mid-drain, over a first frame that already fully landed. The view
  // stays flat (every pixel escapes at iteration 1, whatever maxIter is) so
  // the refinement's freshly drawn rows and the first frame's still-standing
  // rows hold bit-identical escape data — the only thing that could still make
  // them read as different colours is landing under two different palettes.
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

  const partial = await page.evaluate(async (maxIter) => {
    const model = window.app.modelNamed("mandelbrot");
    const panel = model.panel;
    const advanceFrame = panel.renderer.advanceFrame;
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

    // A same-view compute refinement, frozen before any of its bands land:
    // a higher maxIter is a genuine change to what the iterate pass produces
    // (index 9 of the uniform array, not a colour index), so this starts a
    // real beginFrame — same view, so clear=false and the first frame's
    // pixels stay exactly where they are underneath it.
    panel.renderer.advanceFrame = () => 0;
    window.app.setMaxIter(model, maxIter * 2);
    window.app.scheduleRender();
    await nextFrame();

    // Let exactly one animation frame's worth of the refinement land, then
    // freeze again — some rows now hold the refinement's escape data, the
    // rest still hold the first frame's.
    panel.renderer.advanceFrame = advanceFrame;
    window.app.scheduleRender();
    await nextFrame();
    panel.renderer.advanceFrame = () => 0;

    // Recolour while the refinement is still mid-drain. Compute-wise nothing
    // has changed since the refinement's own beginFrame, so this takes the
    // recolor-only path (FractalPanel.needsRecolorOnly): no new job, the
    // refinement's job keeps draining untouched, and the very next present()
    // (below, still within this frozen state) shows the whole target — both
    // the refinement's rows and the first frame's — through the new palette.
    //
    // Palette 0 is a gradient, so an escape at iteration 1 lands at t≈0 on its
    // first colour — a dark purple, distinct from palette 5's white. Palette 6
    // would not do: it is banded on the same colour list whose entry 1 is also
    // white, and the comparison below would be vacuous.
    window.app.applyPalette(model, 0);
    window.app.scheduleRender();
    await nextFrame();

    window.__origAdvanceFrame = advanceFrame;
    return { total: panel.lastTileBandCount, pending: panel.renderer.pendingBands };
  }, maxIter);

  // The premise: the refinement really was started and really is still
  // draining when the recolour above lands.
  expect(partial.pending).toBeGreaterThan(0);
  expect(partial.total - partial.pending).toBeGreaterThan(0);

  const [partialTop, partialBottom] = await sampleColumn(page, rect, [near.top, near.bottom]);
  // The colours really did change…
  expect(partialTop).not.toBe(beforeTop);
  // …the rows the refinement hasn't reached yet did not go black, which is
  // what a ramp step relies on…
  expect(partialBottom).not.toBe(BLACK);
  // …and they carry the new palette too, rather than the frame tearing
  // between two palettes down the boundary of what the refinement has
  // reached so far.
  expect(partialBottom).toBe(partialTop);

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

test('a clear the budget deferred is still owed when the next frame only recolours', async ({ page }) => {
  // The clear rides on band 0's loadOp, so a frame that gets none of the
  // per-frame budget — which happens when the other panel is draining and the
  // budget is down to a single band — hasn't wiped anything yet. If a frame
  // that only recolours the same view then replaces it, that frame correctly
  // asks for no clear of its own, and the wipe owed for the earlier move would
  // be lost: the panel would keep showing the view it moved off underneath.
  //
  // Freezing the drain is how the "got none of the budget" state is reached
  // deterministically here, rather than by contriving two busy panels and a
  // collapsed budget.
  const maxIter = await maxIterForTargetBands(page);
  const rect = await page.evaluate(async (maxIter) => {
    const model = window.app.modelNamed("mandelbrot");
    const panel = model.panel;
    window.app.setMaxIter(model, maxIter);
    window.app.applyPalette(model, 5);

    panel.center = new DOMPointReadOnly(4, 4); // flat white: escapes at iteration 1
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

  const partial = await page.evaluate(async () => {
    const model = window.app.modelNamed("mandelbrot");
    const panel = model.panel;
    const advanceFrame = panel.renderer.advanceFrame;
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

    // Nothing lands from here on: the frames below are started but get no bands.
    panel.renderer.advanceFrame = () => 0;

    // Move the view. This frame asks for a clear and doesn't get to perform it.
    panel.center = new DOMPointReadOnly(-4, 4); // elsewhere, still all-escaping
    window.app.scheduleRender();
    await nextFrame();
    const startedWithMove = panel.renderer.pendingBands;

    // Recolour without moving. On its own this frame is right to ask for no
    // clear — the view it was handed hasn't changed since the frame above.
    window.app.applyPalette(model, 0);
    window.app.scheduleRender();
    await nextFrame();

    // Let exactly one animation frame's worth of bands land, then stop again.
    panel.renderer.advanceFrame = advanceFrame;
    window.app.scheduleRender();
    await nextFrame();
    panel.renderer.advanceFrame = () => 0;
    window.__origAdvanceFrame = advanceFrame;

    return { startedWithMove, total: panel.lastTileBandCount, pending: panel.renderer.pendingBands };
  });

  // The premise: the moved frame really was started and really got nothing.
  expect(partial.startedWithMove).toBeGreaterThan(0);
  expect(partial.pending).toBeGreaterThan(0);
  expect(partial.total - partial.pending).toBeGreaterThan(0);

  const [partialTop, partialBottom] = await sampleColumn(page, rect, [near.top, near.bottom]);
  // The rows that landed show the new colours…
  expect(partialTop).not.toBe(beforeTop);
  // …and the rest was wiped, rather than still showing the view moved off.
  expect(partialBottom).toBe(BLACK);

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

test('a palette change after the frame has landed queues no band at all', async ({ page }) => {
  // The point of the iterate/colorize split: once a frame has fully landed,
  // a palette change needs no iteration redone — FractalPanel.needsRecolorOnly
  // routes it through renderer.js's recolor() instead of beginFrame, so no
  // band is ever queued for it. lastTileBandCount, set only by beginFrame, is
  // the tell — it must stay exactly what the original frame set it to.
  //
  // The screenshot inequality is asserted *before* trusting pendingBands and
  // lastTileBandCount at all: a mock or a mistaken read of stale state could
  // otherwise report "no bands queued" for a palette change that silently
  // did nothing, and the rest of this test would pass for the wrong reason.
  const maxIter = await maxIterForTargetBands(page);
  const setup = await page.evaluate(async (maxIter) => {
    const model = window.app.modelNamed("mandelbrot");
    const panel = model.panel;
    window.app.setMaxIter(model, maxIter);
    window.app.applyPalette(model, 5); // white, banded — see the recolour test above

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
    return {
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      bandCountBefore: panel.lastTileBandCount,
    };
  }, maxIter);

  const { rect, bandCountBefore } = setup;
  expect(bandCountBefore).toBeGreaterThan(0);

  const mid = Math.round(rect.height / 2);
  const before = (await sampleColumn(page, rect, [mid]))[0];
  expect(before).not.toBe(BLACK);

  const after = await page.evaluate(async () => {
    const model = window.app.modelNamed("mandelbrot");
    const panel = model.panel;
    window.app.applyPalette(model, 0); // same geometry, a different gradient
    window.app.scheduleRender();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      pendingBands: panel.renderer.pendingBands,
      lastTileBandCount: panel.lastTileBandCount,
    };
  });

  // The colours really did change…
  const [afterMid] = await sampleColumn(page, rect, [mid]);
  expect(afterMid).not.toBe(before);
  // …with no band ever queued for it: pendingBands never left 0, and
  // lastTileBandCount is still exactly what the original beginFrame set.
  expect(after.pendingBands).toBe(0);
  expect(after.lastTileBandCount).toBe(bandCountBefore);
});
