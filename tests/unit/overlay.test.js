import { test } from 'node:test';
import assert from 'node:assert/strict';

// overlay.js only relies on the constructor and .x/.y readers of
// DOMPointReadOnly (a browser global), same as geometry.test.js.
globalThis.DOMPointReadOnly ??= class DOMPointReadOnly {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
};

const { overlay } = await import('../../src/overlay.js');

// Minimal CanvasRenderingContext2D stand-in: strokeStyle/lineWidth are
// plain writable properties (never asserted on), draw calls are recorded
// in order so tests can inspect what got drawn without a real canvas.
function makeMockCtx() {
  const calls = [];
  const ctx = {
    beginPath: () => calls.push(['beginPath']),
    moveTo: (x, y) => calls.push(['moveTo', x, y]),
    lineTo: (x, y) => calls.push(['lineTo', x, y]),
    arc: (x, y, r, start, end) => calls.push(['arc', x, y, r, start, end]),
    closePath: () => calls.push(['closePath']),
    stroke: () => calls.push(['stroke']),
  };
  return { ctx, calls };
}

test('drawCenterMarker is always centered at (w/2, h/2), regardless of center/scale/aspect', () => {
  const { ctx, calls } = makeMockCtx();
  const center = new DOMPointReadOnly(3, -2);
  overlay.drawCenterMarker(ctx, 200, 150, center, 5, 1.3);

  const arcCalls = calls.filter(([method]) => method === 'arc');
  assert.strictEqual(arcCalls.length, 2, 'crosshair is stroked twice (shadow + white)');
  for (const [, x, y] of arcCalls) {
    assert.strictEqual(x, 100);
    assert.strictEqual(y, 75);
  }
});

test('drawJuliaMarker draws nothing when the point falls outside the canvas', () => {
  const { ctx, calls } = makeMockCtx();
  const juliaC = new DOMPointReadOnly(1000, 1000);
  const center = new DOMPointReadOnly(0, 0);
  overlay.drawJuliaMarker(ctx, 100, 100, juliaC, center, 2, 1);

  assert.deepStrictEqual(calls, []);
});

test('drawJuliaMarker draws a diamond centered on the projected point when in bounds', () => {
  const { ctx, calls } = makeMockCtx();
  const juliaC = new DOMPointReadOnly(0, 0);
  const center = new DOMPointReadOnly(0, 0);
  overlay.drawJuliaMarker(ctx, 100, 100, juliaC, center, 2, 1);

  // juliaC === center projects to the canvas midpoint, (50, 50).
  const moveToCalls = calls.filter(([method]) => method === 'moveTo');
  assert.strictEqual(moveToCalls.length, 2, 'diamond is stroked twice (shadow + yellow)');
  for (const [, x, y] of moveToCalls) {
    assert.strictEqual(x, 50);
    assert.strictEqual(y, 50 - 7); // top vertex: (px, py - r)
  }
});

test('drawGrid draws the x/y axes when the origin is within the visible range', () => {
  const { ctx, calls } = makeMockCtx();
  const center = new DOMPointReadOnly(0, 0);
  overlay.drawGrid(ctx, 100, 100, center, 2, 1);

  // Second beginPath/stroke pair is the axis pass (see overlay.js: grid
  // lines first, then the brighter x/y axis overlay).
  const beginPathIndices = calls
    .map(([method], i) => (method === 'beginPath' ? i : -1))
    .filter((i) => i >= 0);
  assert.strictEqual(beginPathIndices.length, 2);
  const axisSegment = calls.slice(beginPathIndices[1]);
  const axisMoveTos = axisSegment.filter(([method]) => method === 'moveTo');
  assert.strictEqual(axisMoveTos.length, 2, 'both x and y axis lines are drawn');
});

test('drawGrid skips the x/y axes when the origin is outside the visible range', () => {
  const { ctx, calls } = makeMockCtx();
  const center = new DOMPointReadOnly(100, 100);
  overlay.drawGrid(ctx, 100, 100, center, 1, 1);

  const beginPathIndices = calls
    .map(([method], i) => (method === 'beginPath' ? i : -1))
    .filter((i) => i >= 0);
  const axisSegment = calls.slice(beginPathIndices[1]);
  const axisMoveTos = axisSegment.filter(([method]) => method === 'moveTo');
  assert.strictEqual(axisMoveTos.length, 0, 'origin is far outside the view, no axis lines');
});
