import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MANDELBROT_LANDMARKS } from '../../src/landmarks.js';

test('every landmark has a unique name and a description', () => {
  const names = new Set();
  for (const landmark of MANDELBROT_LANDMARKS) {
    assert.strictEqual(typeof landmark.name, 'string');
    assert.ok(landmark.name.length > 0);
    assert.ok(!names.has(landmark.name), `duplicate name "${landmark.name}"`);
    names.add(landmark.name);
    assert.strictEqual(typeof landmark.description, 'string');
    assert.ok(landmark.description.length > 0);
  }
});

test('every landmark sits inside the Mandelbrot set\'s bounding box', () => {
  for (const landmark of MANDELBROT_LANDMARKS) {
    assert.ok(Number.isFinite(landmark.x), `${landmark.name} x`);
    assert.ok(Number.isFinite(landmark.y), `${landmark.name} y`);
    assert.ok(landmark.x >= -2.5 && landmark.x <= 1, `${landmark.name} x=${landmark.x} out of range`);
    assert.ok(landmark.y >= -1.5 && landmark.y <= 1.5, `${landmark.name} y=${landmark.y} out of range`);
  }
});
