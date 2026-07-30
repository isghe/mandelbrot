import { test, expect } from '@playwright/test';

// The #ui panel overlays the full-viewport #gfx canvas, so an element
// screenshot of the canvas still includes overlaid panel pixels (e.g. the
// Back/Forward disabled styling). Clip to a region right of the panel to
// compare only the rendered fractal.
const FRACTAL_CLIP = { x: 250, y: 0, width: 1030, height: 720 };
const VIEWPORT = { width: 1280, height: 720 };

async function fractalShot(page) {
  return page.screenshot({ clip: FRACTAL_CLIP });
}

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
  const box = await page.locator('#gfx').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const baseline = await fractalShot(page);

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 150, cy + 80, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  await expect(backBtn).toBeEnabled();
  await expect(forwardBtn).toBeDisabled();
  const afterPan = await fractalShot(page);
  expect(afterPan.equals(baseline)).toBe(false);

  await backBtn.click();
  await page.waitForTimeout(200);
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
  await expect(backBtn).toBeDisabled();

  await forwardBtn.click();
  await page.waitForTimeout(200);
  expect((await fractalShot(page)).equals(afterPan)).toBe(true);
});

test('wheel-zoom, palette, and Julia mode changes undo in order', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  const box = await page.locator('#gfx').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const baseline = await fractalShot(page);

  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(400); // let the wheel debounce flush
  const afterZoom = await fractalShot(page);
  expect(afterZoom.equals(baseline)).toBe(false);

  await page.selectOption('#paletteType', '1'); // Fire
  await page.waitForTimeout(200);
  const afterPalette = await fractalShot(page);
  expect(afterPalette.equals(afterZoom)).toBe(false);

  await page.check('#juliaMode');
  await page.waitForTimeout(200);
  const afterJulia = await fractalShot(page);
  expect(afterJulia.equals(afterPalette)).toBe(false);

  await backBtn.click(); // undo Julia
  await page.waitForTimeout(200);
  await expect(page.locator('#juliaMode')).not.toBeChecked();
  expect((await fractalShot(page)).equals(afterPalette)).toBe(true);

  await backBtn.click(); // undo palette
  await page.waitForTimeout(200);
  await expect(page.locator('#paletteType')).toHaveValue('4'); // Apple II
  expect((await fractalShot(page)).equals(afterZoom)).toBe(true);

  await backBtn.click(); // undo zoom
  await page.waitForTimeout(200);
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
  await expect(backBtn).toBeDisabled();
});

test('a burst of wheel events coalesces into a single history entry', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  const box = await page.locator('#gfx').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const baseline = await fractalShot(page);
  await wheelBurst(page, { count: 20, gapMs: 20, x: cx, y: cy }); // 20 ticks, well inside the debounce window
  await page.waitForTimeout(400);

  await expect(backBtn).toBeEnabled();
  await backBtn.click();
  await page.waitForTimeout(200);
  // If the whole burst had produced one entry, a single Back restores the
  // exact baseline; if it had flooded the stack, Back would only undo one tick.
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
  await expect(backBtn).toBeDisabled();
});

test('wheel followed by pan preserves undo order', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  const box = await page.locator('#gfx').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const preWheel = await fractalShot(page);
  await wheelBurst(page, { count: 5, gapMs: 20, x: cx, y: cy });
  await page.waitForTimeout(400); // flush before starting the pan
  const prePan = await fractalShot(page);

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy + 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  await backBtn.click(); // undo pan
  await page.waitForTimeout(200);
  expect((await fractalShot(page)).equals(prePan)).toBe(true);

  await backBtn.click(); // undo wheel
  await page.waitForTimeout(200);
  expect((await fractalShot(page)).equals(preWheel)).toBe(true);
});

test('Back mid-debounce flushes the pending wheel entry immediately', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  const box = await page.locator('#gfx').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const baseline = await fractalShot(page);
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -50);
  await page.waitForTimeout(30); // well within the debounce window, not yet flushed

  await expect(backBtn).toBeEnabled(); // enabled immediately, before the debounce commits
  await backBtn.click();
  await page.waitForTimeout(200);
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
});

test('keyboard steps on a slider are undoable', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  const baseline = await fractalShot(page);

  await page.locator('#zoomSlider').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);

  await expect(backBtn).toBeEnabled();
  expect((await fractalShot(page)).equals(baseline)).toBe(false);

  await backBtn.click();
  await page.waitForTimeout(200);
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
  await expect(backBtn).toBeDisabled();
});

test('progressive mode and smooth coloring toggles are undoable', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  const progressiveChk = page.locator('#progressiveMode');
  const smoothChk = page.locator('#smoothColoring');

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
  const baseline = await fractalShot(page);

  const box = await page.locator('#zoomSlider').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); // starts a pointer-drag session (sets pendingZoomSnapshot on the first `input`)
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 5 });
  await page.waitForTimeout(100);
  // Confirm the drag actually registered (i.e. `pendingZoomSnapshot` really
  // got set) before Reset — otherwise this test would pass trivially even if
  // the drag produced no `input` event at all.
  expect((await fractalShot(page)).equals(baseline)).toBe(false);
  // Use the DOM .click() directly, not Playwright's synthetic mouse click,
  // so it doesn't interfere with the real mouse button still held down above.
  await page.evaluate(() => document.getElementById('resetBtn').click());
  await page.waitForTimeout(200);
  await page.mouse.up(); // fires `change` now, after Reset already discarded the pending snapshot

  await page.waitForTimeout(300);
  await expect(backBtn).toBeDisabled();
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
});

test('Reset clears history and discards pending sessions without spurious entries', async ({ page }) => {
  const backBtn = page.locator('#backBtn');
  const forwardBtn = page.locator('#forwardBtn');
  const box = await page.locator('#gfx').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const baseline = await fractalShot(page);

  // A pending (un-flushed) wheel session should be discarded by Reset, not pushed.
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -50);
  await page.waitForTimeout(30);
  await page.locator('#resetBtn').click();
  await page.waitForTimeout(200);

  await expect(backBtn).toBeDisabled();
  await expect(forwardBtn).toBeDisabled();
  expect((await fractalShot(page)).equals(baseline)).toBe(true);
});
