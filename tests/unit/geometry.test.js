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

const { domPoint } = await import('../../geometry.js');

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
