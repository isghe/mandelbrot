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

// Mirrors MandelbrotApp.toFractal (mandelbrot.js), used below to check that
// fractalToNormalized is a true inverse without importing the browser-only class.
function toFractal(normPoint, anchor, scale, aspect) {
  return new DOMPointReadOnly(
    (normPoint.x - 0.5) * scale * aspect + anchor.x,
    (0.5 - normPoint.y) * scale + anchor.y
  );
}

function assertPointClose(actual, expectedX, expectedY, msg) {
  assert.ok(Math.abs(actual.x - expectedX) < 1e-9, msg && `${msg} (x): ${actual.x} vs ${expectedX}`);
  assert.ok(Math.abs(actual.y - expectedY) < 1e-9, msg && `${msg} (y): ${actual.y} vs ${expectedY}`);
}

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
    const fractal = toFractal(new DOMPointReadOnly(nx, ny), anchor, scale, aspect);
    const back = view.fractalToNormalized(fractal, anchor, scale, aspect);
    assertPointClose(back, nx, ny, `round-trip (${nx},${ny})`);
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
