import { test } from 'node:test';
import assert from 'node:assert/strict';

// fractalPanel.js only relies on the constructor and .x/.y readers of
// DOMPointReadOnly (a browser global), same as geometry.test.js.
globalThis.DOMPointReadOnly ??= class DOMPointReadOnly {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
};

globalThis.window ??= { devicePixelRatio: 1 };

const { FractalPanel, buildUniformData, sameRenderSignature } = await import('../../src/fractalPanel.js');
const { split64 } = await import('../../src/precision.js');

// Minimal HTMLCanvasElement stand-in: a plain object with the handful of
// properties/methods FractalPanel actually touches (width/height,
// getBoundingClientRect, getContext for the overlay canvas only).
function makeMockCanvas({ cssWidth = 800, cssHeight = 600 } = {}) {
  return {
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ width: cssWidth, height: cssHeight }),
  };
}

function makeMockOverlayCanvas(opts) {
  const canvas = makeMockCanvas(opts);
  canvas.getContext = () => ({ setTransform: () => {} });
  return canvas;
}

test('constructor sizes both canvases to CSS rect * devicePixelRatio', () => {
  window.devicePixelRatio = 2;
  const canvas = makeMockCanvas({ cssWidth: 400, cssHeight: 300 });
  const overlayCanvas = makeMockOverlayCanvas({ cssWidth: 400, cssHeight: 300 });
  const panel = new FractalPanel(canvas, overlayCanvas);

  assert.strictEqual(canvas.width, 800);
  assert.strictEqual(canvas.height, 600);
  assert.strictEqual(overlayCanvas.width, 800);
  assert.strictEqual(overlayCanvas.height, 600);
  assert.strictEqual(panel.overlayCssWidth, 400);
  assert.strictEqual(panel.overlayCssHeight, 300);
  window.devicePixelRatio = 1;
});

test('resizeCanvas only writes width/height when the rounded size actually changes', () => {
  const canvas = makeMockCanvas({ cssWidth: 100, cssHeight: 50 });
  const overlayCanvas = makeMockOverlayCanvas({ cssWidth: 100, cssHeight: 50 });
  const panel = new FractalPanel(canvas, overlayCanvas);

  let widthWrites = 0;
  const currentWidth = canvas.width;
  Object.defineProperty(canvas, 'width', {
    get: () => currentWidth,
    set: () => { widthWrites++; },
  });

  panel.resizeCanvas();
  assert.strictEqual(widthWrites, 0, 'no write when size is unchanged');
});

test('resizeCanvas clamps to a minimum of 1x1 pixel', () => {
  const canvas = makeMockCanvas({ cssWidth: 0, cssHeight: 0 });
  const overlayCanvas = makeMockOverlayCanvas({ cssWidth: 0, cssHeight: 0 });
  const panel = new FractalPanel(canvas, overlayCanvas);

  assert.strictEqual(canvas.width, 1);
  assert.strictEqual(canvas.height, 1);
  panel.resizeCanvas();
  assert.strictEqual(canvas.width, 1);
  assert.strictEqual(canvas.height, 1);
});

test('toFractal delegates to view.normalizedToFractal with the panel aspect ratio', async () => {
  const { view } = await import('../../src/geometry.js');
  const canvas = makeMockCanvas({ cssWidth: 800, cssHeight: 400 });
  const overlayCanvas = makeMockOverlayCanvas({ cssWidth: 800, cssHeight: 400 });
  const panel = new FractalPanel(canvas, overlayCanvas);
  panel.scale = 2;

  const anchor = new DOMPointReadOnly(-0.5, 0.1);
  const normPoint = new DOMPointReadOnly(0.75, 0.25);
  const expected = view.normalizedToFractal(normPoint, anchor, panel.scale, canvas.width / canvas.height);
  const actual = panel.toFractal(normPoint, anchor);

  assert.strictEqual(actual.x, expected.x);
  assert.strictEqual(actual.y, expected.y);
});

test('setScale clamps to the given {min,max} bounds and returns the clamped value', () => {
  const canvas = makeMockCanvas();
  const overlayCanvas = makeMockOverlayCanvas();
  const panel = new FractalPanel(canvas, overlayCanvas);
  const scaleBounds = { min: 0.1, max: 10 };

  assert.strictEqual(panel.setScale(5, scaleBounds), 5, 'within bounds: unchanged');
  assert.strictEqual(panel.scale, 5);

  assert.strictEqual(panel.setScale(50, scaleBounds), 10, 'above max: clamped to max');
  assert.strictEqual(panel.setScale(0.001, scaleBounds), 0.1, 'below min: clamped to min');
});

test('buildUniformData packs a 16-float array in the WGSL Params layout', () => {
  const center = new DOMPointReadOnly(-0.5, 0.25);
  const juliaSeed = new DOMPointReadOnly(-0.8, 0.156);
  const data = buildUniformData({
    center,
    scale: 2.5,
    juliaSeed,
    displayIter: 128,
    canvasWidth: 800,
    canvasHeight: 600,
    juliaMode: 1,
    smoothColoring: 0,
    bandCount: 2,
  });

  assert.strictEqual(data.length, 16, 'padded to 64 bytes (16 floats)');
  assert.strictEqual(data[0], 2.5, 'scale');

  // split64's `lo` is an f64 remainder; Float32Array storage rounds it to
  // f32, so compare against the same rounding rather than the raw split64
  // output.
  const asF32Pair = ([hi, lo]) => [Math.fround(hi), Math.fround(lo)];
  assert.deepStrictEqual([...data.slice(1, 3)], asF32Pair(split64(center.x)), 'center.x hi/lo');
  assert.deepStrictEqual([...data.slice(3, 5)], asF32Pair(split64(center.y)), 'center.y hi/lo');
  assert.deepStrictEqual([...data.slice(5, 7)], asF32Pair(split64(juliaSeed.x)), 'juliaSeed.x hi/lo');
  assert.deepStrictEqual([...data.slice(7, 9)], asF32Pair(split64(juliaSeed.y)), 'juliaSeed.y hi/lo');

  assert.strictEqual(data[9], 128, 'displayIter');
  assert.strictEqual(data[10], 800, 'canvasWidth');
  assert.strictEqual(data[11], 600, 'canvasHeight');
  assert.strictEqual(data[12], 1, 'juliaMode flag');
  assert.strictEqual(data[13], 0, 'smoothColoring flag');
  assert.strictEqual(data[14], 2, 'bandCount');
  assert.strictEqual(data[15], 0, 'trailing padding');
});

function makeMockSelectionBox() {
  return { style: {} };
}

const noopHooks = (overrides = {}) => ({
  selectionBox: makeMockSelectionBox(),
  scaleBounds: { min: 0.1, max: 10 },
  snapshotView: () => ({}),
  pushHistory: () => {},
  resetProgressive: () => {},
  scheduleRender: () => {},
  onGenuineClick: () => {},
  onScaleChange: () => {},
  ...overrides,
});

// Regression coverage for 96c7474: onPointerDown/onPointerUp used to ignore
// e.button entirely, so a right-click was handled identically to a genuine
// left-click (silently setting juliaSeed on the Mandelbrot panel and pushing
// history), on top of triggering the browser's own context menu.
test('onPointerDown ignores non-primary mouse buttons (e.g. right-click) and starts no gesture', () => {
  const canvas = makeMockCanvas();
  const overlayCanvas = makeMockOverlayCanvas();
  const panel = new FractalPanel(canvas, overlayCanvas);

  panel.onPointerDown(
    { button: 2, ctrlKey: false, clientX: 10, clientY: 10, pointerId: 1 },
    { selectionBox: makeMockSelectionBox(), snapshotView: () => ({}) }
  );

  assert.strictEqual(panel.primaryButtonDown, false);
  assert.strictEqual(panel.isDragging, false);
  assert.strictEqual(panel.isSelecting, false);
});

test('onPointerUp ignores the release of a button onPointerDown ignored, even with stale hasDragged state', () => {
  const canvas = makeMockCanvas();
  const overlayCanvas = makeMockOverlayCanvas();
  const panel = new FractalPanel(canvas, overlayCanvas);

  // The exact stale state that used to make a later right-click's release
  // fall through into the "genuine click" branch: hasDragged left over
  // false from a previous real left-click, with no gesture actually open.
  panel.hasDragged = false;

  let genuineClicks = 0;
  panel.onPointerUp(
    { button: 2, clientX: 10, clientY: 10 },
    noopHooks({ onGenuineClick: () => { genuineClicks++; } })
  );

  assert.strictEqual(genuineClicks, 0, 'a right-click release must not trigger onGenuineClick');
});

test('a primary-button click sets primaryButtonDown on pointerdown and clears it on pointerup, running the genuine-click path', () => {
  const canvas = makeMockCanvas();
  canvas.setPointerCapture = () => {};
  canvas.getBoundingClientRect = () => ({ width: 800, height: 600, left: 0, top: 0 });
  const overlayCanvas = makeMockOverlayCanvas();
  const panel = new FractalPanel(canvas, overlayCanvas);

  panel.onPointerDown(
    { button: 0, ctrlKey: false, clientX: 10, clientY: 10, pointerId: 1 },
    { selectionBox: makeMockSelectionBox(), snapshotView: () => ({}) }
  );
  assert.strictEqual(panel.primaryButtonDown, true);

  let genuineClicks = 0;
  panel.onPointerUp(
    { button: 0, clientX: 10, clientY: 10 },
    noopHooks({ onGenuineClick: () => { genuineClicks++; } })
  );

  assert.strictEqual(panel.primaryButtonDown, false);
  assert.strictEqual(genuineClicks, 1);
});

test('onPointerLeave clears primaryButtonDown', () => {
  const canvas = makeMockCanvas();
  canvas.setPointerCapture = () => {};
  canvas.style = {}; // isDragging is true here, so onPointerLeave's clearDragPreview() writes to it
  const overlayCanvas = makeMockOverlayCanvas();
  overlayCanvas.style = {};
  const panel = new FractalPanel(canvas, overlayCanvas);
  const selectionBox = makeMockSelectionBox();

  panel.onPointerDown(
    { button: 0, ctrlKey: false, clientX: 0, clientY: 0, pointerId: 1 },
    { selectionBox, snapshotView: () => ({}) }
  );
  assert.strictEqual(panel.primaryButtonDown, true);

  panel.onPointerLeave({ selectionBox });
  assert.strictEqual(panel.primaryButtonDown, false);
});

test('default field values match the app defaults FractalPanel replaced', () => {
  const canvas = makeMockCanvas();
  const overlayCanvas = makeMockOverlayCanvas();
  const panel = new FractalPanel(canvas, overlayCanvas);

  assert.strictEqual(panel.center.x, -0.5);
  assert.strictEqual(panel.center.y, 0.0);
  assert.strictEqual(panel.scale, 3.0);
  assert.strictEqual(panel.pivot.x, -0.5);
  assert.strictEqual(panel.pivot.y, 0.0);
  assert.strictEqual(panel.pivotScreen.x, 0.5);
  assert.strictEqual(panel.pivotScreen.y, 0.5);
  assert.strictEqual(panel.isDragging, false);
  assert.strictEqual(panel.isSelecting, false);
  assert.strictEqual(panel.renderer, null);

  assert.strictEqual(panel.maxIter, 256);
  assert.strictEqual(panel.paletteType, 4);
  assert.strictEqual(panel.palette256, null);
  assert.strictEqual(panel.smoothColoring, 0);
  assert.strictEqual(panel.progressiveMode, 0);
  assert.strictEqual(panel.progressiveIter, 1);
  assert.strictEqual(panel.gridOverlay, 0);
  assert.strictEqual(panel.centerMarker, 0);
});

test('sameRenderSignature: identical data and paletteType is a match', () => {
  const data = new Float32Array([1, 2, 3]);
  const a = { data, paletteType: 4 };
  const b = { data: new Float32Array([1, 2, 3]), paletteType: 4 };
  assert.strictEqual(sameRenderSignature(a, b), true);
});

test('sameRenderSignature: a differing float in the uniform data is not a match', () => {
  const a = { data: new Float32Array([1, 2, 3]), paletteType: 4 };
  const b = { data: new Float32Array([1, 2, 99]), paletteType: 4 };
  assert.strictEqual(sameRenderSignature(a, b), false);
});

test('sameRenderSignature: same uniform data but different paletteType is not a match', () => {
  const a = { data: new Float32Array([1, 2, 3]), paletteType: 4 };
  const b = { data: new Float32Array([1, 2, 3]), paletteType: 5 };
  assert.strictEqual(sameRenderSignature(a, b), false);
});

test('sameRenderSignature: a null/undefined previous signature is never a match', () => {
  const next = { data: new Float32Array([1, 2, 3]), paletteType: 4 };
  assert.strictEqual(sameRenderSignature(null, next), false);
  assert.strictEqual(sameRenderSignature(undefined, next), false);
});

test('FractalPanel.isRenderUpToDate/markRendered/invalidateRender', () => {
  const canvas = makeMockCanvas();
  const overlayCanvas = makeMockOverlayCanvas();
  const panel = new FractalPanel(canvas, overlayCanvas);
  panel.paletteType = 4;

  const data = new Float32Array([1, 2, 3]);
  assert.strictEqual(panel.isRenderUpToDate(data), false); // nothing rendered yet

  panel.markRendered(data);
  assert.strictEqual(panel.isRenderUpToDate(new Float32Array([1, 2, 3])), true);
  assert.strictEqual(panel.isRenderUpToDate(new Float32Array([1, 2, 4])), false);

  panel.invalidateRender();
  assert.strictEqual(panel.isRenderUpToDate(new Float32Array([1, 2, 3])), false);
});
