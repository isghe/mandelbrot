// Shared by the specs that compare rendered fractal pixels across actions
// (history.spec.js, overlay.spec.js). Both carried identical copies of the
// clip and of the capture helper; the wait below is the reason they were
// merged rather than the copies each growing it separately.

// The #ui panel overlays the full-viewport #mandelbrotGfx canvas, so an
// element screenshot of the canvas still includes overlaid panel pixels (e.g.
// the Back/Forward disabled styling). Clip to a region right of the panel to
// compare only the rendered fractal.
export const FRACTAL_CLIP = { x: 250, y: 0, width: 1030, height: 720 };

// Resolves once every visible panel has finished handing its current frame
// to the GPU.
//
// A frame's bands are spread over as many animation frames as the adaptive
// per-frame budget needs (see renderer.js), so reading rendered state too
// early sees a half-drawn frame. The specs used to lean on fixed
// waitForTimeout() sleeps, which encode a guess about how long a render
// takes — a guess that silently broke the moment BAND_WORK_BUDGET was
// retuned and every frame gained four times the bands. Waiting on the app's
// own state instead is both correct and faster, since it returns as soon as
// the work is actually done.
export async function waitForRenderSettled(page) {
  await page.waitForFunction(() => !window.app.rafPending
    && window.app.panels.every(({ panel }) => !panel.renderer || panel.renderer.pendingBands === 0));
}

// How many captures fractalShot() may take while waiting for two in a row to
// agree. Two is the normal case (see there); more than a handful means
// something really is still moving, which is worth failing over.
const STABLE_CAPTURE_ATTEMPTS = 5;

// Captures the fractal region once every visible panel has settled (see
// waitForRenderSettled above), retaking it until two consecutive captures
// agree.
//
// That wait is about the app; this loop is about the compositor. On a real GPU
// (native Windows, see playwright.config.js) the first capture of a freshly
// loaded page reliably differs from every later one, while the app's own state
// is identical and unchanging across all of them — the canvas is composited on
// its own schedule, and the first screenshot can be taken before it lands.
// Since the specs here capture a baseline first and compare later captures
// against it, that one stale frame failed a different subset of them on every
// run. Waiting longer does not help (measured); comparing two captures does.
export async function fractalShot(page) {
  await waitForRenderSettled(page);
  let previous = await page.screenshot({ clip: FRACTAL_CLIP });
  for (let attempt = 1; attempt < STABLE_CAPTURE_ATTEMPTS; attempt++) {
    const next = await page.screenshot({ clip: FRACTAL_CLIP });
    if (next.equals(previous)) return next;
    previous = next;
  }
  throw new Error(
    `The fractal was still changing after ${STABLE_CAPTURE_ATTEMPTS} captures, `
    + 'with the app reporting its render as settled.'
  );
}
