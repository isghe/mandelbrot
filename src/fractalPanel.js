import { view } from './geometry.js';
import { split64 } from './precision.js';

// Packs render state into the 16-float layout of the WGSL `Params` uniform
// (see renderer.js's uniformBuffer comment for the byte layout/padding).
export function buildUniformData({
  center, scale, juliaC, displayIter, canvasWidth, canvasHeight, juliaMode, smoothColoring,
}) {
  const [cx_hi, cx_lo] = split64(center.x);
  const [cy_hi, cy_lo] = split64(center.y);
  const [jx_hi, jx_lo] = split64(juliaC.x);
  const [jy_hi, jy_lo] = split64(juliaC.y);

  return new Float32Array([
    scale,
    cx_hi, cx_lo,
    cy_hi, cy_lo,
    jx_hi, jx_lo,
    jy_hi, jy_lo,
    displayIter,
    canvasWidth,
    canvasHeight,
    juliaMode,
    smoothColoring,
    0, 0 // padding to 64 B (16 floats), see renderer.js's uniformBuffer comment
  ]);
}

// Per-canvas render/interaction state: one Mandelbrot canvas today, a second
// independent Julia canvas later. Shared/app-global state (juliaC, maxIter,
// palette, ...) stays on MandelbrotApp and is passed into panel methods.
export class FractalPanel {
  center = new DOMPointReadOnly(-0.5, 0.0);
  scale = 3.0;

  // pivot for centered zoom
  pivot = new DOMPointReadOnly(-0.5, 0.0);
  pivotScreen = new DOMPointReadOnly(0.5, 0.5);

  // pan
  isDragging = false;
  hasDragged = false;
  dragStart = new DOMPointReadOnly(0, 0);
  dragStartClient = new DOMPointReadOnly(0, 0);
  startCenter = new DOMPointReadOnly(0, 0);

  // selection area (Ctrl + drag)
  isSelecting = false;
  selectStart = new DOMPointReadOnly(0, 0);

  renderer = null;
  // Set once the WebGPU device is lost; blocks further render attempts.
  deviceLost = false;

  constructor(canvas, overlayCanvas) {
    this.canvas = canvas;
    this.resizeCanvas();

    this.overlayCanvas = overlayCanvas;
    this.overlayCtx = this.overlayCanvas.getContext("2d");
    this.resizeOverlayCanvas();
  }

  resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  // Keeps the overlay's backing store in sync with the gfx canvas; the
  // transform reset lets overlay draw calls be written in CSS pixels.
  resizeOverlayCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.overlayCanvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (this.overlayCanvas.width !== width || this.overlayCanvas.height !== height) {
      this.overlayCanvas.width = width;
      this.overlayCanvas.height = height;
    }
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.overlayCssWidth = rect.width;
    this.overlayCssHeight = rect.height;
  }

  // Screen-normalized [0,1] point -> fractal-space point, anchored at `anchor`.
  toFractal(normPoint, anchor) {
    const aspect = this.canvas.width / this.canvas.height;
    return view.normalizedToFractal(normPoint, anchor, this.scale, aspect);
  }
}
