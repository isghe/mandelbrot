import { test } from 'node:test';
import assert from 'node:assert/strict';
import { split64 } from '../../precision.js';

test('split64 recombines exactly to the original f64 value', () => {
  const samples = [
    0,
    1,
    -1,
    0.5,
    -0.8,
    0.156,
    Math.PI,
    -0.5,
    1e-14,
    -1.401e-13, // representative deep-zoom scale
    3.0,
    123456.789012345,
  ];
  for (const x of samples) {
    const [hi, lo] = split64(x);
    assert.strictEqual(hi + lo, x, `hi+lo should reconstruct ${x} exactly`);
  }
});

test('split64 hi component is representable as f32 (Math.fround is idempotent on it)', () => {
  for (const x of [Math.PI, -0.8, 123456.789012345, 1e-14]) {
    const [hi] = split64(x);
    assert.strictEqual(Math.fround(hi), hi, `hi=${hi} should already be f32-representable`);
  }
});

test('split64 lo component is the residual error left out of the f32 rounding', () => {
  for (const x of [Math.PI, -0.8, 123456.789012345]) {
    const [hi, lo] = split64(x);
    assert.strictEqual(lo, x - Math.fround(x));
  }
});

test('split64 of an exactly f32-representable value has zero lo', () => {
  const x = 0.5; // exact in binary floating point, well within f32 range
  const [hi, lo] = split64(x);
  assert.strictEqual(hi, x);
  assert.strictEqual(lo, 0);
});
