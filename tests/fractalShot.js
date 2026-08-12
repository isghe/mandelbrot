// Shared by the specs that compare rendered fractal pixels across actions
// (history.spec.js, overlay.spec.js). Both carried identical copies of the
// clip and of the capture helper; the wait below is the reason they were
// merged rather than the copies each growing it separately.

// The #ui panel overlays the full-viewport #mandelbrotGfx canvas, so an
// element screenshot of the canvas still includes overlaid panel pixels (e.g.
// the Back/Forward disabled styling). Clip to a region right of the panel to
// compare only the rendered fractal.
export const FRACTAL_CLIP = { x: 250, y: 0, width: 1030, height: 720 };

// Captures the fractal region once every visible panel has finished handing
// its current frame to the GPU.
//
// A frame's bands are spread over as many animation frames as the adaptive
// per-frame budget needs (see renderer.js), so a capture taken too early gets
// a half-drawn frame and any pixel comparison against it is meaningless. The
// specs used to lean on fixed waitForTimeout() sleeps, which encode a guess
// about how long a render takes — a guess that silently broke the moment
// BAND_WORK_BUDGET was retuned and every frame gained four times the bands.
// Waiting on the app's own state instead is both correct and faster, since it
// returns as soon as the work is actually done.
export async function fractalShot(page) {
  await page.waitForFunction(() => !window.app.rafPending
    && window.app.panels.every(({ panel }) => !panel.renderer || panel.renderer.pendingBands === 0));
  return page.screenshot({ clip: FRACTAL_CLIP });
}
