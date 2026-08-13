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

const {
  FractalPanel, buildUniformData, sameRenderSignature, sameComputeSignature, sameViewGeometry, panShiftBetween,
} = await import('../../src/fractalPanel.js');
const { view: viewMath } = await import('../../src/geometry.js');
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

// sameComputeSignature decides whether the iterate pass would reproduce
// exactly the escape data already in the target — the precondition for a
// palette/look change to skip beginFrame and take the cheap recolor() path
// instead (see FractalPanel.needsRecolorOnly below).

test('sameComputeSignature: identical data is a match regardless of paletteType', () => {
  const a = { data: new Float32Array([1, 2, 3]), paletteType: 4 };
  const b = { data: new Float32Array([1, 2, 3]), paletteType: 9 };
  assert.strictEqual(sameComputeSignature(a, b), true);
});

test('sameComputeSignature: a smoothColoring or bandCount change alone is still a match', () => {
  const a = { data: buildUniformData(makeUniformArgs()) };
  for (const same of [{ smoothColoring: 1 }, { bandCount: 8 }, { smoothColoring: 1, bandCount: 8 }]) {
    const b = { data: buildUniformData(makeUniformArgs(same)) };
    assert.strictEqual(sameComputeSignature(a, b), true, JSON.stringify(same));
  }
});

test('sameComputeSignature: a geometry or iteration-count change is not a match', () => {
  const a = { data: buildUniformData(makeUniformArgs()) };
  for (const moved of [{ center: { x: -0.4, y: 0 } }, { scale: 1.5 }, { displayIter: 512 }, { canvasWidth: 900 }]) {
    const b = { data: buildUniformData(makeUniformArgs(moved)) };
    assert.strictEqual(sameComputeSignature(a, b), false, JSON.stringify(moved));
  }
});

test('sameComputeSignature: a juliaSeed change is ignored for a non-Julia panel (juliaMode 0)', () => {
  const a = { data: buildUniformData(makeUniformArgs()) };
  const b = { data: buildUniformData(makeUniformArgs({ juliaSeed: { x: 0.1, y: -0.6 } })) };
  assert.strictEqual(sameComputeSignature(a, b), true);
});

test('sameComputeSignature: a juliaSeed change is not ignored for the Julia panel (juliaMode 1)', () => {
  const a = { data: buildUniformData(makeUniformArgs({ juliaMode: 1 })) };
  const b = { data: buildUniformData(makeUniformArgs({ juliaMode: 1, juliaSeed: { x: 0.1, y: -0.6 } })) };
  assert.strictEqual(sameComputeSignature(a, b), false);
});

test('sameComputeSignature: a null/undefined previous signature is never a match', () => {
  const next = { data: buildUniformData(makeUniformArgs()) };
  assert.strictEqual(sameComputeSignature(null, next), false);
  assert.strictEqual(sameComputeSignature(undefined, next), false);
});

function makeUniformArgs(overrides = {}) {
  return {
    center: { x: -0.5, y: 0 },
    scale: 3.0,
    juliaSeed: { x: -0.7, y: 0.27 },
    displayIter: 256,
    canvasWidth: 800,
    canvasHeight: 600,
    juliaMode: 0,
    smoothColoring: 0,
    bandCount: 0,
    ...overrides,
  };
}

test('sameRenderSignature: a juliaSeed change is ignored for a non-Julia panel (juliaMode 0)', () => {
  const a = { data: buildUniformData(makeUniformArgs()), paletteType: 4 };
  const b = { data: buildUniformData(makeUniformArgs({ juliaSeed: { x: 0.1, y: -0.6 } })), paletteType: 4 };
  assert.strictEqual(sameRenderSignature(a, b), true);
});

test('sameRenderSignature: a juliaSeed change is not ignored for the Julia panel (juliaMode 1)', () => {
  const a = { data: buildUniformData(makeUniformArgs({ juliaMode: 1 })), paletteType: 4 };
  const b = { data: buildUniformData(makeUniformArgs({ juliaMode: 1, juliaSeed: { x: 0.1, y: -0.6 } })), paletteType: 4 };
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

test('FractalPanel.needsRecolorOnly: a palette or look change alone is a recolor', () => {
  const canvas = makeMockCanvas();
  const overlayCanvas = makeMockOverlayCanvas();
  const panel = new FractalPanel(canvas, overlayCanvas);
  panel.paletteType = 4;
  panel.markRendered(buildUniformData(makeUniformArgs()));

  // Same compute signature, different colour: a recolor.
  panel.paletteType = 7;
  assert.strictEqual(panel.needsRecolorOnly(buildUniformData(makeUniformArgs())), true);
  panel.paletteType = 4;
  assert.strictEqual(panel.needsRecolorOnly(buildUniformData(makeUniformArgs({ smoothColoring: 1 }))), true);
  assert.strictEqual(panel.needsRecolorOnly(buildUniformData(makeUniformArgs({ bandCount: 8 }))), true);
});

test('FractalPanel.needsRecolorOnly: identical data is not a recolor — nothing to do at all', () => {
  const canvas = makeMockCanvas();
  const overlayCanvas = makeMockOverlayCanvas();
  const panel = new FractalPanel(canvas, overlayCanvas);
  panel.paletteType = 4;
  panel.markRendered(buildUniformData(makeUniformArgs()));

  assert.strictEqual(panel.needsRecolorOnly(buildUniformData(makeUniformArgs())), false);
  assert.strictEqual(panel.isRenderUpToDate(buildUniformData(makeUniformArgs())), true);
});

test('FractalPanel.needsRecolorOnly: a geometry change is not a recolor, even alongside a palette change', () => {
  const canvas = makeMockCanvas();
  const overlayCanvas = makeMockOverlayCanvas();
  const panel = new FractalPanel(canvas, overlayCanvas);
  panel.paletteType = 4;
  panel.markRendered(buildUniformData(makeUniformArgs()));

  panel.paletteType = 7;
  const movedAndRecoloured = buildUniformData(makeUniformArgs({ center: { x: -0.4, y: 0 } }));
  assert.strictEqual(panel.needsRecolorOnly(movedAndRecoloured), false);
});

test('FractalPanel.needsRecolorOnly: nothing rendered yet is never a recolor', () => {
  const canvas = makeMockCanvas();
  const overlayCanvas = makeMockOverlayCanvas();
  const panel = new FractalPanel(canvas, overlayCanvas);
  assert.strictEqual(panel.needsRecolorOnly(buildUniformData(makeUniformArgs())), false);
});

// sameViewGeometry decides whether a new frame starts from black or wipes down
// over the previous image: it separates "the panel is looking somewhere else,
// so what's there is a picture of the wrong place" from "same place, only
// coarser or differently coloured".

test('sameViewGeometry: an unchanged view is the same view', () => {
  const a = { data: buildUniformData(makeUniformArgs()) };
  const b = { data: buildUniformData(makeUniformArgs()) };
  assert.strictEqual(sameViewGeometry(a, b), true);
});

test('sameViewGeometry: panning or zooming is a new view', () => {
  const a = { data: buildUniformData(makeUniformArgs()) };
  for (const moved of [{ center: { x: -0.4, y: 0 } }, { center: { x: -0.5, y: 0.2 } }, { scale: 1.5 }]) {
    const b = { data: buildUniformData(makeUniformArgs(moved)) };
    assert.strictEqual(sameViewGeometry(a, b), false, JSON.stringify(moved));
  }
});

test('sameViewGeometry: a resize is a new view — the shader derives each pixel from the canvas size', () => {
  const a = { data: buildUniformData(makeUniformArgs()) };
  for (const resized of [{ canvasWidth: 900 }, { canvasHeight: 700 }]) {
    const b = { data: buildUniformData(makeUniformArgs(resized)) };
    assert.strictEqual(sameViewGeometry(a, b), false, JSON.stringify(resized));
  }
});

test('sameViewGeometry: quality and colour changes keep the same view', () => {
  // The anti-strobe guarantee: the progressive ramp starts a fresh frame at
  // every step, and every one of those steps must keep the previous image
  // underneath instead of blanking the panel.
  const a = { data: buildUniformData(makeUniformArgs()) };
  for (const same of [{ displayIter: 512 }, { smoothColoring: 1 }, { bandCount: 8 }]) {
    const b = { data: buildUniformData(makeUniformArgs(same)) };
    assert.strictEqual(sameViewGeometry(a, b), true, JSON.stringify(same));
  }
});

test('sameViewGeometry: a juliaSeed change is a new view for the Julia panel only', () => {
  const seed = { juliaSeed: { x: 0.1, y: -0.6 } };
  const julia = (extra) => ({ data: buildUniformData(makeUniformArgs({ juliaMode: 1, ...extra })) });
  const mandelbrot = (extra) => ({ data: buildUniformData(makeUniformArgs({ juliaMode: 0, ...extra })) });
  // A different seed is a different set, so every pixel of the Julia panel is stale…
  assert.strictEqual(sameViewGeometry(julia({}), julia(seed)), false);
  // …while the Mandelbrot panel's shader never reads it.
  assert.strictEqual(sameViewGeometry(mandelbrot({}), mandelbrot(seed)), true);
});

test('sameViewGeometry: no previous frame counts as a new view, so the panel starts clean', () => {
  const next = { data: buildUniformData(makeUniformArgs()) };
  assert.strictEqual(sameViewGeometry(null, next), false);
  assert.strictEqual(sameViewGeometry(undefined, next), false);
});

test('FractalPanel.startsNewView follows the last frame it started', () => {
  const panel = new FractalPanel(makeMockCanvas(), makeMockOverlayCanvas());
  const view = buildUniformData(makeUniformArgs());

  assert.strictEqual(panel.startsNewView(view), true); // nothing rendered yet
  panel.markRendered(view);
  assert.strictEqual(panel.startsNewView(buildUniformData(makeUniformArgs())), false);
  assert.strictEqual(panel.startsNewView(buildUniformData(makeUniformArgs({ displayIter: 512 }))), false);
  assert.strictEqual(panel.startsNewView(buildUniformData(makeUniformArgs({ scale: 1.5 }))), true);
});

// panShiftBetween decides whether a frame can reuse the previous one's pixels
// (see renderer.js's exposedRegions for what then gets computed instead).
//
// The pairs below are built by actually panning through view.pan rather than
// by writing a moved centre by hand, so the test measures the same round trip
// the app does — snap the drag to whole pixels, turn it into a centre, then
// recover the pixel shift from the double-single halves of that centre.
const PAN_W = makeUniformArgs().canvasWidth;
const PAN_H = makeUniformArgs().canvasHeight;

function panned(dragX, dragY, overrides = {}) {
  const args = makeUniformArgs(overrides);
  const snapped = viewMath.snapDeltaToPixels({ x: dragX, y: dragY }, PAN_W, PAN_H);
  const moved = viewMath.pan(args.center, snapped, args.scale, PAN_W / PAN_H);
  return {
    prev: { data: buildUniformData(args), paletteType: 4 },
    next: { data: buildUniformData({ ...args, center: moved }), paletteType: 4 },
  };
}

test('panShiftBetween: a pan moves the image the way the drag went', () => {
  // Dragging right and down carries the image right and down with it, and the
  // framebuffer's y axis points down too — so both components keep the drag's
  // sign. Getting this backwards would copy the overlap to the mirror side of
  // the panel, which no amount of correct banding would rescue.
  const right = panned(0.15, 0.08);
  assert.deepStrictEqual(panShiftBetween(right.prev, right.next), { x: 120, y: 48 });

  const left = panned(-0.15, -0.08);
  assert.deepStrictEqual(panShiftBetween(left.prev, left.next), { x: -120, y: -48 });
});

test('panShiftBetween: a purely horizontal or vertical pan keeps the other axis at zero', () => {
  const horizontal = panned(0.15, 0);
  assert.deepStrictEqual(panShiftBetween(horizontal.prev, horizontal.next), { x: 120, y: 0 });

  const vertical = panned(0, -0.08);
  assert.deepStrictEqual(panShiftBetween(vertical.prev, vertical.next), { x: 0, y: -48 });
});

test('panShiftBetween: nothing rendered yet leaves nothing to reuse', () => {
  const { next } = panned(0.15, 0.08);
  assert.strictEqual(panShiftBetween(null, next), null);
  assert.strictEqual(panShiftBetween(undefined, next), null);
});

test('panShiftBetween: a pan that also changes what the iterate pass computes is not reusable', () => {
  // Each of these would leave the copied-across escape data computed to a
  // different recipe than what belongs beside it — a visible seam, not a
  // saving. Colour is deliberately not among them (see the next two tests):
  // it changes how escape data is painted, never what it is.
  for (const overrides of [
    { scale: 1.5 },
    { displayIter: 512 },
    { canvasWidth: 640 },
    { canvasHeight: 480 },
    { juliaMode: 1 },
  ]) {
    const base = panned(0.15, 0.08);
    const changed = panned(0.15, 0.08, overrides);
    assert.strictEqual(
      panShiftBetween(base.prev, changed.next), null,
      `${JSON.stringify(overrides)} should not count as a pure pan`
    );
  }
});

test('panShiftBetween: a recolour alongside a pan is still a pure pan', () => {
  // What gets copied is escape data, not colour (see mandelbrot.wgsl's
  // fs_main/fs_colorize split) — present() colorizes it fresh from whatever
  // palette is current, so a pan and a palette change together cost exactly
  // what the pan alone would have.
  const { prev, next } = panned(0.15, 0.08);
  assert.deepStrictEqual(
    panShiftBetween(prev, { ...next, paletteType: prev.paletteType + 1 }), { x: 120, y: 48 }
  );
});

test('panShiftBetween: a look change alongside a pan is still a pure pan', () => {
  for (const overrides of [{ smoothColoring: 1 }, { bandCount: 8 }]) {
    const base = panned(0.15, 0.08);
    const changed = panned(0.15, 0.08, overrides);
    assert.deepStrictEqual(
      panShiftBetween(base.prev, changed.next), { x: 120, y: 48 },
      `${JSON.stringify(overrides)} should still count as a pure pan`
    );
  }
});

test('panShiftBetween: a juliaSeed change follows the same rule as the render signature', () => {
  const seed = { juliaSeed: { x: 0.1, y: -0.6 } };
  // The Mandelbrot shader never reads the seed, so a seed change alongside a
  // pan is still a pure pan there...
  const mandelbrot = panned(0.15, 0.08);
  assert.deepStrictEqual(
    panShiftBetween(mandelbrot.prev, panned(0.15, 0.08, seed).next), { x: 120, y: 48 }
  );
  // ...while for Julia a different seed is a different set entirely.
  const julia = panned(0.15, 0.08, { juliaMode: 1 });
  assert.strictEqual(
    panShiftBetween(julia.prev, panned(0.15, 0.08, { juliaMode: 1, ...seed }).next), null
  );
});

test('panShiftBetween: a zoom is not a translation', () => {
  const args = makeUniformArgs();
  const prev = { data: buildUniformData(args), paletteType: 4 };
  const next = { data: buildUniformData({ ...args, scale: args.scale / 2 }), paletteType: 4 };
  assert.strictEqual(panShiftBetween(prev, next), null);
});

test('panShiftBetween: a jump that lands between pixels is not reusable', () => {
  // A history/landmark/URL jump doesn't go through snapDeltaToPixels, so its
  // centre generally sits half a pixel off the grid — copying the overlap
  // there would leave a seam that compounds over later pans.
  const args = makeUniformArgs();
  const moved = viewMath.pan(args.center, { x: 0.15 + 0.5 / PAN_W, y: 0 }, args.scale, PAN_W / PAN_H);
  const prev = { data: buildUniformData(args), paletteType: 4 };
  const next = { data: buildUniformData({ ...args, center: moved }), paletteType: 4 };
  assert.strictEqual(panShiftBetween(prev, next), null);
});

test('panShiftBetween: a standing-still or off-the-panel shift is not reusable', () => {
  const args = makeUniformArgs();
  const prev = { data: buildUniformData(args), paletteType: 4 };
  // Same view: nothing is uncovered, so the frame would have no bands at all
  // and would never land on screen.
  assert.strictEqual(panShiftBetween(prev, { data: buildUniformData(args), paletteType: 4 }), null);
  // Dragged the panel's whole width: no overlap survives to be copied.
  const off = viewMath.pan(args.center, { x: 1, y: 0 }, args.scale, PAN_W / PAN_H);
  assert.strictEqual(
    panShiftBetween(prev, { data: buildUniformData({ ...args, center: off }), paletteType: 4 }), null
  );
});

test('panShiftBetween: reprojection switches itself off as the precision floor is reached', () => {
  // No zoom cutoff is written down anywhere: the double-single centre stops
  // being able to express a whole-pixel shift, the residual breaks the
  // sub-pixel tolerance, and the same drag stops being reusable on its own.
  // Below this depth the same fractal point computed from two different
  // centres differs in its last bits, so the seam would be real.
  const deep = { center: { x: 0.7436438870371587, y: 0.1318259042126771 } };
  const shallow = panned(0.05, 0, { ...deep, scale: 1e-9 });
  assert.deepStrictEqual(panShiftBetween(shallow.prev, shallow.next), { x: 40, y: 0 });

  const floor = panned(0.05, 0, { ...deep, scale: 1e-13 });
  assert.strictEqual(panShiftBetween(floor.prev, floor.next), null);
});

test('FractalPanel.panShiftFor follows the last frame it started', () => {
  const panel = new FractalPanel(makeMockCanvas(), makeMockOverlayCanvas());
  const { prev, next } = panned(0.15, 0.08);
  panel.paletteType = prev.paletteType;

  assert.strictEqual(panel.panShiftFor(next.data), null); // nothing rendered yet
  panel.markRendered(prev.data);
  assert.deepStrictEqual(panel.panShiftFor(next.data), { x: 120, y: 48 });
  panel.invalidateRender();
  assert.strictEqual(panel.panShiftFor(next.data), null);
});
