import { test, expect } from '@playwright/test';

// Real-browser coverage for pan reprojection: after a drag, the part of the
// image that only moved is copied across in the GPU rather than computed
// again, and only the strips the pan uncovered are rendered. The pure halves
// are unit-tested (panShiftBetween in tests/unit/fractalPanel.test.js,
// exposedRegions in tests/unit/renderer.test.js); these confirm the two are
// wired together against a real WebGPU device — that the saving is real, that
// the reused pixels land in the right place, and that everything which isn't
// a pan still renders in full.

const VIEWPORT = { width: 1280, height: 720 };

// Big enough that the uncovered strips are a modest fraction of the panel
// (so the band count really drops), small enough to leave plenty of overlap
// to check pixel by pixel. Both components non-zero, so the exposed region is
// the L-shape rather than the easy single-strip case.
const DRAG = { x: 120, y: 64 };

// Where the drag starts: right of the #ui panel, comfortably inside the
// canvas so the whole drag stays on it.
const DRAG_FROM = { x: 700, y: 400 };

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
  // One full-width panel, same convention as tiling.spec.js: it keeps the
  // canvas size — and so the band count and the pixel coordinates below —
  // predictable.
  await page.uncheck('#showJulia');

  // Records what each frame was started with, so the assertions can talk
  // about the shift the app actually decided on rather than inferring it from
  // the picture. Progressive mode is off by default, so a pan produces
  // exactly one frame and there is no ramp re-rendering the view afterwards.
  await page.evaluate(() => {
    const panel = window.app.modelNamed("mandelbrot").panel;
    window.__frames = [];
    const beginFrame = panel.renderer.beginFrame;
    panel.renderer.beginFrame = (data, maxIter, options = {}) => {
      const bands = beginFrame(data, maxIter, options);
      window.__frames.push({ shift: options.shift ?? null, clear: !!options.clear, bands });
      return bands;
    };
  });
});

// Resolves once the panel has finished handing its current frame to the GPU —
// same reasoning as fractalShot's wait, which this spec can't reuse because
// its clip is the wrong shape here (see settled()'s callers).
const settled = (page) => page.waitForFunction(() => !window.app.rafPending
  && window.app.modelNamed("mandelbrot").panel.renderer.pendingBands === 0);

// Drags the Mandelbrot panel by `delta` CSS pixels and waits for the frame it
// triggers to land completely.
async function drag(page, delta = DRAG) {
  await page.mouse.move(DRAG_FROM.x, DRAG_FROM.y);
  await page.mouse.down();
  await page.mouse.move(DRAG_FROM.x + delta.x, DRAG_FROM.y + delta.y, { steps: 8 });
  await page.mouse.up();
  await settled(page);
}

const framesSince = (page, mark) => page.evaluate((from) => window.__frames.slice(from), mark);
const frameCount = (page) => page.evaluate(() => window.__frames.length);

// The whole panel, once its frame has landed. Unclipped, unlike fractalShot:
// a translation has to be checked over the panel's own pixel grid, and the
// caller has hidden the one thing painted over it.
async function panelShot(page) {
  await settled(page);
  return page.screenshot();
}

test('a pan renders only what it uncovered, not the whole panel', async ({ page }) => {
  // The frame the drag replaces, as the yardstick: band count depends only on
  // canvas size and maxIter, so the full-frame count is the same before and
  // after the drag and can be measured from the frame already on screen.
  await settled(page);
  const full = await page.evaluate(() => window.app.modelNamed("mandelbrot").panel.lastTileBandCount);
  expect(full).toBeGreaterThan(1); // otherwise there is no saving to measure

  const mark = await frameCount(page);
  await drag(page);
  const frames = await framesSince(page, mark);

  expect(frames.length).toBe(1);
  const [panFrame] = frames;
  // The app decided this was a pure whole-pixel translation…
  expect(panFrame.shift).toEqual({ x: DRAG.x, y: DRAG.y });
  // …and still asked for a clear, because the view genuinely moved. Deciding
  // that the copied-across pixels make the wipe unnecessary is the renderer's
  // job, not the caller's — the pixel test below is what shows it does it.
  expect(panFrame.clear).toBe(true);

  // The uncovered L is 1280*720 - 1160*656 = 160640 of 921600 pixels, ~17%.
  // Asserting "less than half" rather than the exact ratio keeps this about
  // the saving being real, not about a particular banding of it.
  expect(panFrame.bands).toBeLessThan(full / 2);
  expect(panFrame.bands).toBeGreaterThan(0);
});

test('the pixels a pan reuses land exactly where they moved to', async ({ page }) => {
  // Everything but the fractal canvas is painted over it and stays put while
  // the image translates, so any of it left in frame reads as "reused pixels
  // that landed in the wrong place" — and it reads that way twice over, since
  // each screenshot is compared against an offset copy of the other. This is
  // the one spec that compares a translation rather than two shots of the
  // same view, so clipping past the chrome (as fractalShot does) isn't
  // enough: the panel, the toggle button and the repo link all have to go.
  await page.evaluate(() => {
    for (const el of document.body.children) {
      if (el.id !== 'mandelbrotGfx') el.style.display = 'none';
    }
  });

  const before = await panelShot(page);
  const mark = await frameCount(page);
  await drag(page);
  const after = await panelShot(page);

  const [panFrame] = await framesSince(page, mark);
  expect(panFrame.shift).toEqual({ x: DRAG.x, y: DRAG.y });
  // The screenshots are in CSS pixels and the shift is in device pixels; the
  // comparison below only lines up if the two are the same thing.
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

  const result = await comparePan(page, before, after, DRAG);

  // The reused region has to be the earlier image, moved — every pixel of it.
  expect(result.overlapMismatches).toBe(0);

  // Not vacuous: a uniformly black panel, two identical screenshots, or a
  // comparison that covered almost nothing would all satisfy the assertion
  // above without proving anything. The panel is the full 1280x720 viewport
  // and the drag takes (120, 64) off it, so the overlap is 1160*656 pixels —
  // 83% of the panel, which is also the saving this whole feature is for.
  expect(result.overlapPixels).toBe(1160 * 656);
  expect(result.beforeIsUniform).toBe(false);
  expect(result.identicalShots).toBe(false);
});

test('anything that is not a translation still renders the whole panel', async ({ page }) => {
  await settled(page);
  const full = await page.evaluate(() => window.app.modelNamed("mandelbrot").panel.lastTileBandCount);

  // A zoom is a scale, not a translation: no pixel of the old frame belongs
  // anywhere in the new one.
  let mark = await frameCount(page);
  await page.mouse.move(DRAG_FROM.x, DRAG_FROM.y);
  await page.mouse.wheel(0, -200);
  await settled(page);
  let frames = await framesSince(page, mark);
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame.shift).toBe(null);
    expect(frame.bands).toBe(full);
  }

  // A quality change leaves the view exactly where it is, but every pixel has
  // to be computed again at the new iteration count — reusing any of them
  // would put two different recipes side by side in one image.
  mark = await frameCount(page);
  await page.click('#mandelbrotIterPlus');
  await settled(page);
  frames = await framesSince(page, mark);
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame.shift).toBe(null);
    // A band's size is set by maxIter, so a frame at a higher one is split
    // into at least as many bands as before — never into the handful a
    // reprojection would produce.
    expect(frame.bands).toBeGreaterThanOrEqual(full);
  }
});

test('undoing a pan is itself a pan, and reuses pixels the same way', async ({ page }) => {
  // Back doesn't go through the drag's whole-pixel snap, so this only works
  // because the centre it restores is the one a snapped pan moved off — the
  // exact inverse translation. It is the guard doing its job, not luck: a
  // centre that landed off the pixel grid would break the sub-pixel tolerance
  // and fall back to a full render.
  await settled(page);
  const full = await page.evaluate(() => window.app.modelNamed("mandelbrot").panel.lastTileBandCount);

  await drag(page);
  const mark = await frameCount(page);
  await page.click('#backBtn');
  await settled(page);

  const frames = await framesSince(page, mark);
  expect(frames.length).toBe(1);
  expect(frames[0].shift).toEqual({ x: -DRAG.x, y: -DRAG.y });
  expect(frames[0].bands).toBeLessThan(full / 2);
});

// Compares the overlapping part of two panel screenshots taken either side of
// a pan: after shifting `before` by `shift`, every pixel that both images
// share must be identical.
//
// Decoding happens back in the page rather than in Node — the suite has no
// PNG decoder as a dependency, and the browser already has one. Same reason
// asyncRender.spec.js's sampleColumn works this way.
async function comparePan(page, before, after, shift) {
  return page.evaluate(async ({ beforeUrl, afterUrl, shift }) => {
    const decode = async (dataUrl) => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = dataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      return canvas.getContext('2d').getImageData(0, 0, img.width, img.height);
    };

    const a = await decode(beforeUrl);
    const b = await decode(afterUrl);
    const { width, height } = a;
    const at = (image, x, y) => {
      const i = (y * width + x) * 4;
      return `${image.data[i]},${image.data[i + 1]},${image.data[i + 2]}`;
    };

    let overlapMismatches = 0;
    let overlapPixels = 0;
    for (let y = Math.max(0, shift.y); y < Math.min(height, height + shift.y); y++) {
      for (let x = Math.max(0, shift.x); x < Math.min(width, width + shift.x); x++) {
        overlapPixels++;
        if (at(b, x, y) !== at(a, x - shift.x, y - shift.y)) overlapMismatches++;
      }
    }

    // A flat image would make the comparison above meaningless.
    const first = at(a, 0, 0);
    let beforeIsUniform = true;
    for (let y = 0; y < height && beforeIsUniform; y += 7) {
      for (let x = 0; x < width; x += 7) {
        if (at(a, x, y) !== first) { beforeIsUniform = false; break; }
      }
    }

    // So would two screenshots that happen to be the same picture — the pan
    // has to have visibly moved something.
    let identicalShots = true;
    for (let y = 0; y < height && identicalShots; y++) {
      for (let x = 0; x < width; x++) {
        if (at(b, x, y) !== at(a, x, y)) { identicalShots = false; break; }
      }
    }

    return { overlapMismatches, overlapPixels, beforeIsUniform, identicalShots };
  }, {
    beforeUrl: `data:image/png;base64,${before.toString('base64')}`,
    afterUrl: `data:image/png;base64,${after.toString('base64')}`,
    shift,
  });
}
