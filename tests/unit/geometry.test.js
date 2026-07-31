import { test } from 'node:test';
import assert from 'node:assert/strict';

// geometry.js only relies on the constructor and .x/.y readers of
// DOMPointReadOnly (a browser global), so a minimal polyfill is enough to
// unit test it in plain Node without a browser.
globalThis.DOMPointReadOnly ??= class DOMPointReadOnly {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
};

const { domPoint, view, grid } = await import('../../geometry.js');

function assertPoint(actual, expectedX, expectedY, msg) {
  assert.strictEqual(actual.x, expectedX, msg && `${msg} (x)`);
  assert.strictEqual(actual.y, expectedY, msg && `${msg} (y)`);
}

test('add sums both components', () => {
  const r = domPoint.add(new DOMPointReadOnly(1, 2), new DOMPointReadOnly(3, 4));
  assertPoint(r, 4, 6);
});

test('scale multiplies both components by a scalar', () => {
  const r = domPoint.scale(new DOMPointReadOnly(2, -3), 2.5);
  assertPoint(r, 5, -7.5);
});

test('negate flips the sign of both components', () => {
  const r = domPoint.negate(new DOMPointReadOnly(2, -3));
  assertPoint(r, -2, 3);
});

test('sub subtracts the second point from the first', () => {
  const r = domPoint.sub(new DOMPointReadOnly(5, 5), new DOMPointReadOnly(2, 7));
  assertPoint(r, 3, -2);
});

test('lerp at t=0 returns the first point, t=1 returns the second', () => {
  const a = new DOMPointReadOnly(0, 0);
  const b = new DOMPointReadOnly(10, 20);
  assertPoint(domPoint.lerp(a, b, 0), 0, 0, 't=0');
  assertPoint(domPoint.lerp(a, b, 1), 10, 20, 't=1');
});

test('lerp at t=0.25 interpolates proportionally', () => {
  const a = new DOMPointReadOnly(0, 0);
  const b = new DOMPointReadOnly(10, 20);
  assertPoint(domPoint.lerp(a, b, 0.25), 2.5, 5);
});

test('mid returns the midpoint of two points', () => {
  const r = domPoint.mid(new DOMPointReadOnly(2, 4), new DOMPointReadOnly(8, 10));
  assertPoint(r, 5, 7);
});

function assertPointClose(actual, expectedX, expectedY, msg) {
  assert.ok(Math.abs(actual.x - expectedX) < 1e-9, msg && `${msg} (x): ${actual.x} vs ${expectedX}`);
  assert.ok(Math.abs(actual.y - expectedY) < 1e-9, msg && `${msg} (y): ${actual.y} vs ${expectedY}`);
}

test('toFractal maps the screen center to the anchor', () => {
  const anchor = new DOMPointReadOnly(0, 0);
  const r = view.toFractal(new DOMPointReadOnly(0.5, 0.5), anchor, 2, 1);
  assertPoint(r, 0, 0);
});

test('toFractal: x grows right, y grows up (inverted from screen y)', () => {
  const anchor = new DOMPointReadOnly(0, 0);
  assertPoint(view.toFractal(new DOMPointReadOnly(1.0, 0.5), anchor, 2, 1), 1, 0);
  assertPoint(view.toFractal(new DOMPointReadOnly(0.5, 0.0), anchor, 2, 1), 0, 1);
});

test('toFractal accounts for aspect ratio on x only', () => {
  const anchor = new DOMPointReadOnly(0, 0);
  const r = view.toFractal(new DOMPointReadOnly(0.75, 0.5), anchor, 2, 2);
  assertPoint(r, 1, 0);
});

test('anchorFor is the inverse of toFractal, solved for anchor', () => {
  const anchor = new DOMPointReadOnly(-0.5, 0.1);
  const scale = 3.2;
  const aspect = 1.6;
  for (const [nx, ny] of [[0, 0], [1, 1], [0.25, 0.75], [0.5, 0.5]]) {
    const normPoint = new DOMPointReadOnly(nx, ny);
    const fractalPoint = view.toFractal(normPoint, anchor, scale, aspect);
    const back = view.anchorFor(fractalPoint, normPoint, scale, aspect);
    assertPointClose(back, anchor.x, anchor.y, `round-trip (${nx},${ny})`);
  }
});

test('anchorFor with normPoint at screen center returns the fractal point itself', () => {
  const fractalPoint = new DOMPointReadOnly(-1.25, 0.4);
  const r = view.anchorFor(fractalPoint, new DOMPointReadOnly(0.5, 0.5), 2, 1);
  assertPoint(r, -1.25, 0.4);
});

test('anchorFor accounts for aspect ratio on x only', () => {
  const fractalPoint = new DOMPointReadOnly(0, 0);
  const r = view.anchorFor(fractalPoint, new DOMPointReadOnly(1, 0.5), 2, 2);
  assertPoint(r, -2, 0);
});

test('pan with zero delta returns the anchor unchanged', () => {
  const anchor = new DOMPointReadOnly(-0.5, 0.25);
  const r = view.pan(anchor, new DOMPointReadOnly(0, 0), 2, 1);
  assertPoint(r, -0.5, 0.25);
});

test('pan: dragging right/down moves the anchor left/up (screen vs fractal y are inverted)', () => {
  const anchor = new DOMPointReadOnly(0, 0);
  const r = view.pan(anchor, new DOMPointReadOnly(0.1, 0.1), 2, 1);
  assertPoint(r, -0.2, 0.2);
});

test('pan accounts for aspect ratio on x only', () => {
  const anchor = new DOMPointReadOnly(0, 0);
  const r = view.pan(anchor, new DOMPointReadOnly(0.1, 0), 2, 2);
  assertPoint(r, -0.4, 0);
});

test('pan is the inverse of itself for the opposite screenDelta', () => {
  const anchor = new DOMPointReadOnly(-0.5, 0.1);
  const delta = new DOMPointReadOnly(0.15, -0.2);
  const panned = view.pan(anchor, delta, 3.2, 1.6);
  const back = view.pan(panned, domPoint.negate(delta), 3.2, 1.6);
  assertPointClose(back, anchor.x, anchor.y, 'round-trip');
});

test('fractalToNormalized maps the anchor to the screen center', () => {
  const anchor = new DOMPointReadOnly(0, 0);
  const r = view.fractalToNormalized(new DOMPointReadOnly(0, 0), anchor, 2, 1);
  assertPoint(r, 0.5, 0.5);
});

test('fractalToNormalized: x grows right, y grows down (inverted from fractal y)', () => {
  const anchor = new DOMPointReadOnly(0, 0);
  assertPoint(view.fractalToNormalized(new DOMPointReadOnly(1, 0), anchor, 2, 1), 1.0, 0.5);
  assertPoint(view.fractalToNormalized(new DOMPointReadOnly(0, 1), anchor, 2, 1), 0.5, 0.0);
});

test('fractalToNormalized accounts for aspect ratio on x only', () => {
  const anchor = new DOMPointReadOnly(0, 0);
  const r = view.fractalToNormalized(new DOMPointReadOnly(1, 0), anchor, 2, 2);
  assertPoint(r, 0.75, 0.5);
});

test('fractalToNormalized accounts for a non-origin anchor', () => {
  const anchor = new DOMPointReadOnly(-0.5, 0.25);
  const r = view.fractalToNormalized(new DOMPointReadOnly(-0.5, 0.25), anchor, 2, 1);
  assertPoint(r, 0.5, 0.5);
});

test('fractalToNormalized is the inverse of toFractal', () => {
  const anchor = new DOMPointReadOnly(-0.5, 0.1);
  const scale = 3.2;
  const aspect = 1.6;
  for (const [nx, ny] of [[0, 0], [1, 1], [0.25, 0.75], [0.5, 0.5]]) {
    const fractal = view.toFractal(new DOMPointReadOnly(nx, ny), anchor, scale, aspect);
    const back = view.fractalToNormalized(fractal, anchor, scale, aspect);
    assertPointClose(back, nx, ny, `round-trip (${nx},${ny})`);
  }
});

test('fractalToPixel maps the anchor to the viewport center', () => {
  const anchor = new DOMPointReadOnly(0, 0);
  const r = view.fractalToPixel(new DOMPointReadOnly(0, 0), anchor, 2, 1, 900, 700);
  assertPointClose(r, 450, 350);
});

test('fractalToPixel scales normalized coordinates by viewport size', () => {
  const anchor = new DOMPointReadOnly(0, 0);
  // fractalToNormalized(1,0) with scale=2, aspect=1 -> nx=1.0, ny=0.5
  const r = view.fractalToPixel(new DOMPointReadOnly(1, 0), anchor, 2, 1, 900, 700);
  assertPointClose(r, 900, 350);
});

test('fractalToPixel accounts for aspect ratio and a non-origin anchor', () => {
  const anchor = new DOMPointReadOnly(-0.5, 0.25);
  // fractalToNormalized(0.5,0.25) with anchor=(-0.5,0.25), scale=2, aspect=2 -> nx=0.75, ny=0.5
  const r = view.fractalToPixel(new DOMPointReadOnly(0.5, 0.25), anchor, 2, 2, 800, 400);
  assertPointClose(r, 600, 200);
});

test('fractalToPixel is exactly fractalToNormalized scaled by (w, h)', () => {
  const cases = [
    [new DOMPointReadOnly(0.3, -0.7), new DOMPointReadOnly(-0.5, 0.1), 3.2, 1.6, 1024, 512],
    [new DOMPointReadOnly(-2, 5), new DOMPointReadOnly(0, 0), 0.5, 2.4, 640, 480],
  ];
  for (const [fractalPoint, anchor, scale, aspect, w, h] of cases) {
    const n = view.fractalToNormalized(fractalPoint, anchor, scale, aspect);
    const expected = new DOMPointReadOnly(n.x * w, n.y * h);
    const actual = view.fractalToPixel(fractalPoint, anchor, scale, aspect, w, h);
    assertPointClose(actual, expected.x, expected.y, `w=${w},h=${h}`);
  }
});

test('niceGridStep rounds to {1,2,5} * 10^n', () => {
  for (const range of [3, 0.003, 3e-9, 4000, 0.7, 12345]) {
    const step = grid.niceGridStep(range, 8);
    const exponent = Math.floor(Math.log10(step));
    const fraction = Math.round(step / 10 ** exponent);
    assert.ok([1, 2, 5].includes(fraction), `step ${step} for range ${range} should reduce to 1, 2, or 5 (got ${fraction})`);
  }
});

test('niceGridStep keeps line density in a reasonable range', () => {
  for (const range of [3, 0.003, 3e-9, 4000, 0.7, 12345]) {
    const step = grid.niceGridStep(range, 8);
    const lines = range / step;
    assert.ok(lines >= 4 && lines <= 20, `range/step=${lines} for range ${range} should be roughly between 4 and 20`);
  }
});

test('gridLines returns every multiple of step within [min, max]', () => {
  assert.deepStrictEqual(grid.gridLines(-2.5, 2.5, 1), [-2, -1, 0, 1, 2]);
  assert.deepStrictEqual(grid.gridLines(0, 3, 1), [0, 1, 2, 3]);
  assert.deepStrictEqual(grid.gridLines(0.1, 0.9, 1), []);
});

test('gridLines excludes values just outside the range (boundary rounding)', () => {
  // 2 is just past max=1.9999999 -> Math.floor(max/step) must exclude it
  assert.deepStrictEqual(grid.gridLines(0, 1.9999999, 1), [0, 1]);
  // -2 is just before min=-1.9999999 -> Math.ceil(min/step) must exclude it
  assert.deepStrictEqual(grid.gridLines(-1.9999999, 0, 1), [-1, 0]);
});

test('gridLines does not accumulate floating-point drift over many lines', () => {
  // With a naive `x += step` loop, repeated addition of a step like 0.1
  // accumulates rounding error; index-based i * step must not.
  const step = 0.1;
  const lines = grid.gridLines(0, 5, step);
  for (let i = 0; i < lines.length; i++) {
    assert.strictEqual(lines[i], i * step, `line ${i} should be exactly i * step`);
  }
});
