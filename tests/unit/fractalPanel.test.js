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

const { FractalPanel, buildUniformData } = await import('../../src/fractalPanel.js');
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
  assert.deepStrictEqual([...data.slice(14, 16)], [0, 0], 'trailing padding');
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
});
