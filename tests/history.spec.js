import { test, expect } from '@playwright/test';
import { fractalShot } from './fractalShot.js';

// Several tests here already run 15-25s on an idle machine (multiple
// fractalShot() calls, each a stability loop of full-panel screenshots under
// software-rendered WebGPU) — too close to the default 30s budget to survive
// any real host contention.
test.describe.configure({ timeout: 90_000 });

const VIEWPORT = { width: 1280, height: 720 };

// Dispatches a burst of native `wheel` events directly in-page, spaced close
// together like a real trackpad/mouse gesture. Driving this through
// Playwright's page.mouse.wheel() has significant CDP/software-rendering
// overhead per call under SwiftShader, which can exceed the app's debounce
// window and produce a false flood; in-page dispatch avoids that.
async function wheelBurst(page, { count, gapMs, x, y }) {
  await page.evaluate(({ count, gapMs, x, y }) => {
    return new Promise((resolve) => {
      let i = 0;
      const target = document.elementFromPoint(x, y);
      const fire = () => {
        target.dispatchEvent(new WheelEvent('wheel', {
          deltaY: -20, clientX: x, clientY: y, bubbles: true, cancelable: true,
        }));
        i++;
        if (i < count) setTimeout(fire, gapMs);
        else resolve();
      };
      fire();
    });
  }, { count, gapMs, x, y });
}

test.beforeEach(async ({ page }) => {
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.setViewportSize(VIEWPORT);
  await page.goto('/index.html');

  // If WebGPU failed to initialize, the app shows a centered #gpuError box
  // (see mandelbrot.js's top-level catch) instead of throwing — and since it
  // sits right at the canvas center, it silently swallows every pointer/wheel
  // event the tests below send there. Fail fast with the real reason instead
  // of a confusing "button never enabled" downstream failure.
  const gpuError = page.locator('#gpuError');
  if (await gpuError.isVisible()) {
    const message = await page.locator('#gpuErrorMessage').textContent();
    throw new Error(
      `WebGPU failed to initialize: ${message}\nConsole errors:\n${consoleErrors.join('\n')}`
    );
  }

  await expect(page.locator('#backBtn')).toBeDisabled();
});

test('Back/Forward are disabled with an empty history', async ({ page }) => {
  await expect(page.locator('#backBtn')).toBeDisabled();
  await expect(page.locator('#forwardBtn')).toBeDisabled();
});

test('pan can be undone and redone', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  const forwardBtn = page.locator('#forwardBtn');
  // fractalShot()'s clip spans past the split-screen divider into the Julia
  // panel; hide it so the comparison only ever sees Mandelbrot's own pixels.
  await page.uncheck('#showJulia');
  const box = await page.locator('#mandelbrotGfx').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const baseline = await fractalShot(page);

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 150, cy + 80, { steps: 10 });
  await page.mouse.up();

  await expect(backBtn).toBeEnabled();
  await expect(forwardBtn).toBeDisabled();
  const afterPan = await fractalShot(page);
  expect(afterPan.equals(baseline)).toBe(false);

  await backBtn.click();
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
  await expect(backBtn).toBeDisabled();

  await forwardBtn.click();
  expect((await fractalShot(page)).equals(afterPan)).toBe(true);
});

test('wheel-zoom, palette, and smooth coloring changes undo in order', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  // fractalShot()'s clip spans past the split-screen divider into the Julia
  // panel; hide it so the comparison only ever sees Mandelbrot's own pixels.
  await page.uncheck('#showJulia');
  const box = await page.locator('#mandelbrotGfx').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const baseline = await fractalShot(page);

  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -200);
  await page.waitForFunction(() => !window.app.history.wheelTimer && !window.app.history.pendingWheelSnapshot);
  const afterZoom = await fractalShot(page);
  expect(afterZoom.equals(baseline)).toBe(false);

  await page.selectOption('#mandelbrotPaletteType', '1'); // Fire
  const afterPalette = await fractalShot(page);
  expect(afterPalette.equals(afterZoom)).toBe(false);

  await page.check('#mandelbrotSmoothColoring');
  const afterSmooth = await fractalShot(page);
  expect(afterSmooth.equals(afterPalette)).toBe(false);

  await backBtn.click(); // undo smooth coloring
  await expect(page.locator('#mandelbrotSmoothColoring')).not.toBeChecked();
  expect((await fractalShot(page)).equals(afterPalette)).toBe(true);

  await backBtn.click(); // undo palette
  await expect(page.locator('#mandelbrotPaletteType')).toHaveValue('4'); // Apple II
  expect((await fractalShot(page)).equals(afterZoom)).toBe(true);

  await backBtn.click(); // undo zoom
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
  await expect(backBtn).toBeDisabled();
});

test('a burst of wheel events coalesces into a single history entry', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  // fractalShot()'s clip spans past the split-screen divider into the Julia
  // panel; hide it so the comparison only ever sees Mandelbrot's own pixels.
  await page.uncheck('#showJulia');
  const box = await page.locator('#mandelbrotGfx').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const baseline = await fractalShot(page);
  await wheelBurst(page, { count: 20, gapMs: 20, x: cx, y: cy }); // 20 ticks, well inside the debounce window
  await page.waitForFunction(() => !window.app.history.wheelTimer && !window.app.history.pendingWheelSnapshot);

  await expect(backBtn).toBeEnabled();
  await backBtn.click();
  // If the whole burst had produced one entry, a single Back restores the
  // exact baseline; if it had flooded the stack, Back would only undo one tick.
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
  await expect(backBtn).toBeDisabled();
});

test('wheel followed by pan preserves undo order', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  // fractalShot()'s clip spans past the split-screen divider into the Julia
  // panel; hide it so the comparison only ever sees Mandelbrot's own pixels.
  await page.uncheck('#showJulia');
  const box = await page.locator('#mandelbrotGfx').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const preWheel = await fractalShot(page);
  await wheelBurst(page, { count: 5, gapMs: 20, x: cx, y: cy });
  await page.waitForFunction(() => !window.app.history.wheelTimer && !window.app.history.pendingWheelSnapshot); // flush before starting the pan
  const prePan = await fractalShot(page);

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy + 60, { steps: 8 });
  await page.mouse.up();

  await backBtn.click(); // undo pan
  expect((await fractalShot(page)).equals(prePan)).toBe(true);

  await backBtn.click(); // undo wheel
  expect((await fractalShot(page)).equals(preWheel)).toBe(true);
});

test('Back mid-debounce flushes the pending wheel entry immediately', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  // fractalShot()'s clip spans past the split-screen divider into the Julia
  // panel; hide it so the comparison only ever sees Mandelbrot's own pixels.
  await page.uncheck('#showJulia');
  const box = await page.locator('#mandelbrotGfx').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const baseline = await fractalShot(page);
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -50);
  // armWheel() arms wheelTimer/pendingWheelSnapshot synchronously inside the
  // wheel handler (src/fractalPanel.js onWheel -> src/history.js armWheel),
  // so there's no async gap to wait out here — this asserts the "armed but
  // not yet flushed" state directly instead of racing a guessed sub-debounce
  // delay against it.
  await page.waitForFunction(() => window.app.history.wheelTimer !== null);

  await expect(backBtn).toBeEnabled(); // enabled immediately, before the debounce commits
  await backBtn.click();
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
});

test('keyboard steps on a slider are undoable', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  // fractalShot()'s clip spans past the split-screen divider into the Julia
  // panel; hide it so the comparison only ever sees Mandelbrot's own pixels.
  await page.uncheck('#showJulia');
  const baseline = await fractalShot(page);

  await page.locator('#mandelbrotZoomSlider').focus();
  await page.keyboard.press('ArrowRight');

  await expect(backBtn).toBeEnabled();
  expect((await fractalShot(page)).equals(baseline)).toBe(false);

  await backBtn.click();
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
  await expect(backBtn).toBeDisabled();
});

test('the iterations -1/+1 buttons are undoable, and clamping at ITER.min pushes no spurious history entry', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  const iterLabel = page.locator('#mandelbrotIterLabel');
  const iterMinus = page.locator('#mandelbrotIterMinus');

  await expect(iterLabel).toHaveText('256');

  // Home on a focused range input jumps straight to its min (ITER.min = 1),
  // firing input+change like the arrow-key test above — one real history
  // entry, going from 256 to 1.
  await page.locator('#mandelbrotIterSlider').focus();
  await page.keyboard.press('Home');
  await expect(iterLabel).toHaveText('1');
  await expect(backBtn).toBeEnabled();

  // Already at ITER.min: this click's clamp is a no-op. If onIterStep still
  // pushed history unconditionally, it would add a second entry identical in
  // maxIter to the first, and a single Back below would land on that
  // duplicate (still showing "1") instead of jumping straight back to "256".
  await iterMinus.click();
  await expect(iterLabel).toHaveText('1');

  await backBtn.click();
  await expect(iterLabel).toHaveText('256');
  await expect(backBtn).toBeDisabled();
});

test('progressive mode and smooth coloring toggles are undoable', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  const progressiveChk = page.locator('#mandelbrotProgressiveMode');
  const smoothChk = page.locator('#mandelbrotSmoothColoring');

  // Note: this test checks checkbox state, not screenshots. Progressive mode
  // reveals the fractal over several animation frames (see resetProgressive()/
  // progressiveIter in mandelbrot.js), and every applySnapshot() (i.e. every
  // Back/Forward) restarts that reveal from scratch — its convergence time
  // depends on rendering speed (slower under load with SwiftShader software
  // rendering), which makes exact screenshot comparisons here inherently
  // flaky regardless of how long the test waits. The checkbox state is what
  // this test is actually about, and it updates synchronously.

  await progressiveChk.check();
  await expect(backBtn).toBeEnabled();

  await smoothChk.check();

  await backBtn.click(); // undo smooth coloring
  await expect(smoothChk).not.toBeChecked();
  await expect(progressiveChk).toBeChecked();

  await backBtn.click(); // undo progressive mode
  await expect(progressiveChk).not.toBeChecked();
  await expect(smoothChk).not.toBeChecked();
  await expect(backBtn).toBeDisabled();
});

test('Reset mid-slider-drag discards the pending snapshot without a spurious push', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  // fractalShot()'s clip spans past the split-screen divider into the Julia
  // panel; hide it so the comparison only ever sees Mandelbrot's own pixels.
  await page.uncheck('#showJulia');
  const baseline = await fractalShot(page);

  const box = await page.locator('#mandelbrotZoomSlider').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); // starts a pointer-drag session (sets pendingZoomSnapshot on the first `input`)
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 5 });
  // Confirm the drag actually registered (i.e. `pendingSnapshot.zoom` really
  // got set) before Reset — otherwise this test would pass trivially even if
  // the drag produced no `input` event at all.
  await page.waitForFunction(() => window.app.modelNamed("mandelbrot").pendingSnapshot.zoom !== null);
  expect((await fractalShot(page)).equals(baseline)).toBe(false);
  // Use the DOM .click() directly, not Playwright's synthetic mouse click,
  // so it doesn't interfere with the real mouse button still held down above.
  await page.evaluate(() => document.getElementById('resetBtn').click());
  await page.mouse.up(); // fires `change` now, after Reset already discarded the pending snapshot

  // Reset restores the default split-screen view — hide Julia again before
  // the final comparison, same reason as the initial uncheck above.
  await page.uncheck('#showJulia');
  await expect(backBtn).toBeDisabled();
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
});

test('clicking sets the Julia seed and is undoable, even with the Julia panel hidden', async ({ page }) => {
  const backBtn = page.locator('#backBtn');

  // The Julia seed only affects the rendered fractal when the Julia panel
  // is shown, so hide it explicitly (both panels are shown by default) and
  // show its overlay marker instead, to get a visible signal of the click's
  // effect while the Julia panel stays hidden.
  await page.uncheck('#showJulia');
  await page.check('#juliaMarker');
  const baseline = await fractalShot(page);

  await expect(page.locator('#showJulia')).not.toBeChecked();
  await page.mouse.click(600, 300); // plain click, no drag

  await expect(backBtn).toBeEnabled();
  const afterClick = await fractalShot(page);
  expect(afterClick.equals(baseline)).toBe(false);

  await backBtn.click();
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
  await expect(backBtn).toBeDisabled();
});

// Regression coverage for History A (Mossa 3): the Julia panel's own
// pan/zoom/quality used to be a Tier 2 display preference outside undo
// history; it's now Tier 1, symmetric with the Mandelbrot panel.
test('zooming the Julia panel enables Back/Forward and is undoable', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  await expect(backBtn).toBeDisabled();

  const scaleBefore = await page.evaluate(() => window.app.modelNamed("julia").panel.scale);

  await page.mouse.move(900, 350); // over the Julia (right) panel
  await page.mouse.wheel(0, -200);
  await page.waitForFunction(() => !window.app.history.wheelTimer && !window.app.history.pendingWheelSnapshot);

  await expect(backBtn).toBeEnabled();
  const scaleAfter = await page.evaluate(() => window.app.modelNamed("julia").panel.scale);
  expect(scaleAfter).not.toBe(scaleBefore);

  await backBtn.click();
  const scaleAfterBack = await page.evaluate(() => window.app.modelNamed("julia").panel.scale);
  expect(scaleAfterBack).toBe(scaleBefore);
  await expect(backBtn).toBeDisabled();
});

test('wheel-zoom after panning centers on the new position, not the stale pivot', async ({ page }) => {
  const box = await page.locator('#mandelbrotGfx').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 200, cy + 120, { steps: 10 });
  await page.mouse.up();

  const centerAfterPan = await page.evaluate(() => ({ x: window.app.modelNamed("mandelbrot").panel.center.x, y: window.app.modelNamed("mandelbrot").panel.center.y }));

  // Zoom with the cursor exactly at the screen center: a correctly tracked
  // pivot keeps the center fixed (only scale changes). Before the fix, the
  // pivot was still the pre-pan default/click point, so the center would
  // jump back toward it instead of staying at centerAfterPan.
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -200);
  await page.waitForFunction(() => !window.app.history.wheelTimer && !window.app.history.pendingWheelSnapshot);

  const centerAfterZoom = await page.evaluate(() => ({ x: window.app.modelNamed("mandelbrot").panel.center.x, y: window.app.modelNamed("mandelbrot").panel.center.y }));

  expect(centerAfterZoom.x).toBeCloseTo(centerAfterPan.x, 4);
  expect(centerAfterZoom.y).toBeCloseTo(centerAfterPan.y, 4);
});

test('Reset clears history and discards pending sessions without spurious entries', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  const forwardBtn = page.locator('#forwardBtn');
  // fractalShot()'s clip spans past the split-screen divider into the Julia
  // panel; hide it so the comparison only ever sees Mandelbrot's own pixels.
  await page.uncheck('#showJulia');
  const box = await page.locator('#mandelbrotGfx').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const baseline = await fractalShot(page);

  // A pending (un-flushed) wheel session should be discarded by Reset, not pushed.
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -50);
  // armWheel() arms wheelTimer synchronously inside the wheel handler, so
  // there's no async gap to wait out before Reset — see the identical
  // comment in "Back mid-debounce flushes the pending wheel entry
  // immediately" above.
  await page.waitForFunction(() => window.app.history.wheelTimer !== null);
  await page.locator('#resetBtn').click();
  // Reset restores the default split-screen view — hide Julia again before
  // the final comparison, same reason as the initial uncheck above.
  await page.uncheck('#showJulia');

  await expect(backBtn).toBeDisabled();
  await expect(forwardBtn).toBeDisabled();
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
});
