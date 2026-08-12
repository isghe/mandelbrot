import { domPoint, view } from './geometry.js';
import { split64 } from './precision.js';

// Packs render state into the 16-float layout of the WGSL `Params` uniform
// (see renderer.js's uniformBuffer comment for the byte layout/padding).
export function buildUniformData({
  center, scale, juliaSeed, displayIter, canvasWidth, canvasHeight, juliaMode, smoothColoring, bandCount,
}) {
  const [cx_hi, cx_lo] = split64(center.x);
  const [cy_hi, cy_lo] = split64(center.y);
  const [sx_hi, sx_lo] = split64(juliaSeed.x);
  const [sy_hi, sy_lo] = split64(juliaSeed.y);

  return new Float32Array([
    scale,
    cx_hi, cx_lo,
    cy_hi, cy_lo,
    sx_hi, sx_lo,
    sy_hi, sy_lo,
    displayIter,
    canvasWidth,
    canvasHeight,
    juliaMode,
    smoothColoring,
    bandCount,
    0 // padding to 64 B (16 floats), see renderer.js's uniformBuffer comment
  ]);
}

// Indices into buildUniformData's array (see its layout above) that a
// non-Julia panel's fragment shader never reads — juliaSeed only feeds the
// Julia iteration formula. Skipping them below means clicking a new Julia
// seed doesn't force a pointless re-render of the Mandelbrot panel, whose
// image is unaffected by it.
const JULIA_MODE_INDEX = 12;
const JULIA_SEED_INDICES = [5, 6, 7, 8]; // sx_hi, sx_lo, sy_hi, sy_lo

// True when `next` (the uniform data + paletteType about to be rendered)
// would produce a pixel-identical frame to `prev` (the frame this panel most
// recently started) — the two together fully determine one panel's pixels
// (paletteType isn't in the uniform array; it drives the palette texture
// written separately by MandelbrotApp.applyPalette). A null/undefined
// `prev` (nothing rendered yet) or a NaN anywhere in the compared uniform
// data never compares equal, so both cases conservatively fall through to a
// real render.
export function sameRenderSignature(prev, next) {
  if (!prev || !next) return false;
  if (prev.paletteType !== next.paletteType) return false;
  if (prev.data.length !== next.data.length) return false;
  const juliaMode = next.data[JULIA_MODE_INDEX];
  for (let i = 0; i < next.data.length; i++) {
    if (juliaMode === 0 && JULIA_SEED_INDICES.includes(i)) continue;
    if (prev.data[i] !== next.data[i]) return false;
  }
  return true;
}

// Per-canvas render/interaction state: one Mandelbrot canvas today, a second
// independent Julia canvas later. `juliaSeed` (the Julia-family constant, not
// a canvas's own view) stays app-global on MandelbrotApp; everything else
// that characterizes a single canvas's frame (view, quality, look) lives here.
export class FractalPanel {
  // Single source of truth for both panels' defaults, so Mandelbrot and
  // Julia can't drift out of sync via a duplicated literal — see
  // MandelbrotApp's three-tier state model.
  static DEFAULT_SCALE = 3.0;
  static DEFAULT_MAX_ITER = 256;
  static DEFAULT_PALETTE_TYPE = 4;
  static DEFAULT_SMOOTH_COLORING = 0;
  static DEFAULT_PROGRESSIVE_MODE = 0;
  static DEFAULT_GRID_OVERLAY = 0;
  static DEFAULT_CENTER_MARKER = 0;

  center = new DOMPointReadOnly(-0.5, 0.0);
  scale = FractalPanel.DEFAULT_SCALE;

  // Frame quality/look — independent per panel (see MandelbrotApp's
  // three-tier state model). `palette256`/`bandCount` are derived from
  // `paletteType`, computed and written by MandelbrotApp (this class doesn't
  // depend on palette.js). `bandCount` isn't part of any saved state (not in
  // VIEW_KEYS, not in the share/localStorage schema) — it's always
  // recomputed from `paletteType` by applyPalette.
  maxIter = FractalPanel.DEFAULT_MAX_ITER;
  paletteType = FractalPanel.DEFAULT_PALETTE_TYPE;
  palette256 = null;
  bandCount = 0;
  smoothColoring = FractalPanel.DEFAULT_SMOOTH_COLORING;
  progressiveMode = FractalPanel.DEFAULT_PROGRESSIVE_MODE;
  progressiveIter = 1;
  gridOverlay = FractalPanel.DEFAULT_GRID_OVERLAY;
  centerMarker = FractalPanel.DEFAULT_CENTER_MARKER;

  // pivot for centered zoom
  pivot = new DOMPointReadOnly(-0.5, 0.0);
  pivotScreen = new DOMPointReadOnly(0.5, 0.5);

  // pan
  isDragging = false;
  hasDragged = false;
  dragStart = new DOMPointReadOnly(0, 0);
  dragStartClient = new DOMPointReadOnly(0, 0);
  startCenter = new DOMPointReadOnly(0, 0);
  dragStartSnapshot = null;
  // True between a primary-button onPointerDown and its matching
  // onPointerUp/onPointerLeave — lets onPointerUp tell "a real gesture we
  // started" apart from the up/cancel of a button onPointerDown ignored
  // (see there), rather than trusting `hasDragged`, which is stale left over
  // from the last real gesture and would otherwise make an ignored button's
  // release fall through into the "genuine click" branch.
  primaryButtonDown = false;

  // selection area (Ctrl + drag)
  isSelecting = false;
  selectStart = new DOMPointReadOnly(0, 0);

  // Per-canvas render handle from renderer.js's attachCanvas(); the WebGPU
  // device itself is shared app-wide (see MandelbrotApp.deviceLost), so
  // device loss isn't tracked per panel.
  renderer = null;

  // Set by MandelbrotApp.renderOnce()/startRenderIfNeeded() as each frame
  // starts — exposed for e2e observation of "what's currently rendered"
  // (progressive ramp position) and "how many scissored bands the tiling fix
  // split the frame into" (see renderer.js's BAND_WORK_BUDGET). How many of
  // those bands are still to be submitted isn't mirrored here: the renderer
  // handle's own `pendingBands` already reports it, live. Named lastTileBandCount,
  // not lastBandCount, specifically to avoid reading like a variant of
  // `bandCount` above: that one counts a banded palette's color steps, this
  // one counts GPU scissor tiles for TDR mitigation — unrelated concepts
  // that just happen to share the word "band".
  lastDisplayIter = null;
  lastTileBandCount = null;

  // What characterizes the frame this panel most recently started (uniform
  // data + paletteType) — lets startRenderIfNeeded skip a resubmit when the
  // next frame would be pixel-identical (see sameRenderSignature above). Null
  // means "nothing rendered yet" or "known stale" (see invalidateRender), so
  // the next render always goes through.
  //
  // Recorded when a frame *starts*, not when it finishes: its bands may still
  // be draining over later animation frames (renderer.js's advanceFrame).
  // Waiting for completion instead would make every animation frame in
  // between find this signature stale, call beginFrame again, and restart the
  // frame from its first band — so it would never finish at all.
  lastRenderSignature = null;

  // True when `data` (the uniform array about to be submitted) would produce
  // the same pixels as the frame this panel last started.
  isRenderUpToDate(data) {
    return sameRenderSignature(this.lastRenderSignature, { data, paletteType: this.paletteType });
  }

  markRendered(data) {
    this.lastRenderSignature = { data, paletteType: this.paletteType };
  }

  // Forces the next startRenderIfNeeded call through, even if the uniform data ends
  // up identical to last time — for cases where the *presented* image may
  // have changed independent of the render inputs (e.g. a resize/visibility
  // toggle that drops the compositor's last frame for this canvas).
  invalidateRender() {
    this.lastRenderSignature = null;
  }

  constructor(canvas, overlayCanvas) {
    this.canvas = canvas;
    this.resizeCanvas();

    this.overlayCanvas = overlayCanvas;
    this.overlayCtx = this.overlayCanvas.getContext("2d");
    this.resizeOverlayCanvas();
  }

  // Resizes `canvas`'s backing store to match its CSS size at the current
  // device pixel ratio; returns dpr/rect so callers needing more (e.g. the
  // overlay's transform reset) don't recompute them.
  resizeCanvasBackingStore(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return { dpr, rect };
  }

  resizeCanvas() {
    this.resizeCanvasBackingStore(this.canvas);
  }

  // Keeps the overlay's backing store in sync with the gfx canvas; the
  // transform reset lets overlay draw calls be written in CSS pixels.
  resizeOverlayCanvas() {
    const { dpr, rect } = this.resizeCanvasBackingStore(this.overlayCanvas);
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.overlayCssWidth = rect.width;
    this.overlayCssHeight = rect.height;
  }

  // Screen-normalized [0,1] point -> fractal-space point, anchored at `anchor`.
  toFractal(normPoint, anchor) {
    const aspect = this.canvas.width / this.canvas.height;
    return view.normalizedToFractal(normPoint, anchor, this.scale, aspect);
  }

  setScale(next, scaleBounds) {
    this.scale = Math.min(scaleBounds.max, Math.max(scaleBounds.min, next));
    return this.scale;
  }

  // PAN: pointerdown / pointermove / pointerup. `hooks` carries the
  // app-global side effects a single canvas can't own by itself (a shared
  // selection-box element, view history, render scheduling, and what a
  // genuine click on *this* panel should do — e.g. only the Mandelbrot
  // panel sets juliaSeed from it).
  onPointerDown(e, { selectionBox, snapshotView }) {
    // Only the primary (usually left) mouse button — or a touch/pen contact,
    // which is also reported as button 0 — drives pan/click/select. A
    // right-click must not pan, set the pivot, or (on the Mandelbrot panel)
    // change juliaSeed; leaving it unhandled here also lets the browser's
    // native context menu open as expected.
    if (e.button !== 0) return;
    this.primaryButtonDown = true;
    this.canvas.setPointerCapture(e.pointerId);
    if (e.ctrlKey) {
      this.isSelecting = true;
      this.dragStartSnapshot = snapshotView();
      this.selectStart = new DOMPointReadOnly(e.clientX, e.clientY);
      selectionBox.style.left = this.selectStart.x + "px";
      selectionBox.style.top = this.selectStart.y + "px";
      selectionBox.style.width = "0px";
      selectionBox.style.height = "0px";
      selectionBox.style.display = "block";
      return;
    }
    this.isDragging = true;
    this.hasDragged = false;
    this.dragStartSnapshot = snapshotView();
    const rect = this.canvas.getBoundingClientRect();
    this.dragStart = new DOMPointReadOnly((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    this.dragStartClient = new DOMPointReadOnly(e.clientX, e.clientY);
    this.startCenter = this.center;
  }

  onPointerMove(e, { selectionBox }) {
    if (this.isSelecting) {
      const box = DOMRectReadOnly.fromRect({
        x: Math.min(e.clientX, this.selectStart.x),
        y: Math.min(e.clientY, this.selectStart.y),
        width: Math.abs(e.clientX - this.selectStart.x),
        height: Math.abs(e.clientY - this.selectStart.y),
      });
      selectionBox.style.left = box.x + "px";
      selectionBox.style.top = box.y + "px";
      selectionBox.style.width = box.width + "px";
      selectionBox.style.height = box.height + "px";
      return;
    }
    if (!this.isDragging) return;
    this.hasDragged = true;
    // Cheap CSS-transform preview while dragging: the real WebGPU render
    // (expensive) only runs once, on pointerup, with the final center.
    const dx = e.clientX - this.dragStartClient.x;
    const dy = e.clientY - this.dragStartClient.y;
    const preview = `translate(${dx}px, ${dy}px)`;
    this.canvas.style.transform = preview;
    this.overlayCanvas.style.transform = preview;
    // In dual view, this preview can slide past this panel's own half into
    // the other panel's — drop below the baseline z-index (see style.css)
    // for the duration of the drag so whichever panel is moving always
    // slides *under* the stationary one, not over it.
    this.canvas.style.zIndex = "0";
    this.overlayCanvas.style.zIndex = "0";
  }

  clearDragPreview() {
    this.canvas.style.transform = "";
    this.overlayCanvas.style.transform = "";
    this.canvas.style.zIndex = "";
    this.overlayCanvas.style.zIndex = "";
  }

  onPointerUp(e, {
    selectionBox, scaleBounds, snapshotView, pushHistory,
    resetProgressive, scheduleRender, onGenuineClick, onScaleChange,
  }) {
    // Matches a button onPointerDown ignored (see there) — without this, a
    // right-click's own release would fall through using stale state left
    // over from the last real gesture (see primaryButtonDown's declaration).
    if (!this.primaryButtonDown) return;
    this.primaryButtonDown = false;

    if (this.isSelecting) {
      this.isSelecting = false;
      selectionBox.style.display = "none";

      const rect = this.canvas.getBoundingClientRect();
      const screenSel = DOMRectReadOnly.fromRect({
        x: Math.min(e.clientX, this.selectStart.x) - rect.left,
        y: Math.min(e.clientY, this.selectStart.y) - rect.top,
        width: Math.abs(e.clientX - this.selectStart.x),
        height: Math.abs(e.clientY - this.selectStart.y),
      });

      // ignore selections that are too small (e.g. Ctrl+click without dragging)
      if (screenSel.width < 3 || screenSel.height < 3) return;

      const aspect = this.canvas.width / this.canvas.height;

      const topLeftNorm = new DOMPointReadOnly(screenSel.left / rect.width, screenSel.top / rect.height);
      const bottomRightNorm = new DOMPointReadOnly(screenSel.right / rect.width, screenSel.bottom / rect.height);
      const f1 = this.toFractal(topLeftNorm, this.center);
      const f2 = this.toFractal(bottomRightNorm, this.center);

      this.center = domPoint.mid(f1, f2);

      const selWidth  = Math.abs(f2.x - f1.x);
      const selHeight = Math.abs(f1.y - f2.y);
      this.setScale(Math.max(selHeight, selWidth / aspect), scaleBounds);
      onScaleChange?.(this.scale);

      this.pivot = this.center;
      this.pivotScreen = new DOMPointReadOnly(0.5, 0.5);

      pushHistory(this.dragStartSnapshot);
      resetProgressive();
      scheduleRender();
      return;
    }

    this.isDragging = false;

    // Genuine CLICK (no dragging) → pivot (Y corrected: NDC vs canvas)
    if (!this.hasDragged) {
      const rect = this.canvas.getBoundingClientRect();
      const mouse = new DOMPointReadOnly((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);

      this.pivotScreen = mouse;
      this.pivot = this.toFractal(mouse, this.center);

      pushHistory(snapshotView());
      onGenuineClick?.(this.pivot);
      scheduleRender();
      return;
    }

    // Drag finished: commit the CSS preview into the real center and
    // trigger the one real render this drag gets.
    this.clearDragPreview();
    const rect = this.canvas.getBoundingClientRect();
    const mouse = new DOMPointReadOnly((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    const delta = domPoint.sub(mouse, this.dragStart);
    const aspect = this.canvas.width / this.canvas.height;

    this.center = view.pan(this.startCenter, delta, this.scale, aspect);
    this.pivot = this.center;
    this.pivotScreen = new DOMPointReadOnly(0.5, 0.5);

    if (this.dragStartSnapshot) {
      pushHistory(this.dragStartSnapshot);
      this.dragStartSnapshot = null;
    }
    scheduleRender();
  }

  onPointerLeave({ selectionBox }) {
    if (this.isDragging) this.clearDragPreview();
    this.isDragging = false;
    this.primaryButtonDown = false;
    if (this.isSelecting) {
      this.isSelecting = false;
      selectionBox.style.display = "none";
    }
  }

  // WHEEL → zoom centered on the pivot
  onWheel(e, { scaleBounds, armWheelHistory, resetProgressive, scheduleRender, onScaleChange }) {
    e.preventDefault();
    armWheelHistory();
    const aspect = this.canvas.width / this.canvas.height;
    const zoomFactor = (e.deltaY > 0 ? 1.1 : 0.9);

    this.setScale(this.scale * zoomFactor, scaleBounds);
    onScaleChange?.(this.scale);

    // Keeps the fractal point under pivotScreen fixed at the new scale.
    this.center = view.anchorFor(this.pivot, this.pivotScreen, this.scale, aspect);

    resetProgressive();
    scheduleRender();
  }
}
