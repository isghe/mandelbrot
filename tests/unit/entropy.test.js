import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEscapeEntropy, NOT_RENDERED, INTERIOR, BIN_COUNT } from '../../src/entropy.js';

const bitsScratch = new ArrayBuffer(4);
const bitsAsU32 = new Uint32Array(bitsScratch);
const bitsAsF32 = new Float32Array(bitsScratch);
function floatToBits(f) {
  bitsAsF32[0] = f;
  return bitsAsU32[0];
}

function samplesOf(pairs) {
  const flat = new Uint32Array(pairs.length * 2);
  pairs.forEach(([x, y], i) => {
    flat[i * 2] = x;
    flat[i * 2 + 1] = y;
  });
  return flat;
}

function escaped(iter, nuPrime = -0.2) {
  return [iter + 1, floatToBits(nuPrime)];
}

test('all-interior samples: zero entropy, full interior fraction, full coverage', () => {
  const samples = samplesOf(Array.from({ length: 16 }, () => [INTERIOR, 0]));
  const result = computeEscapeEntropy(samples);
  assert.strictEqual(result.entropy, 0);
  assert.strictEqual(result.entropyNormalized, 0);
  assert.strictEqual(result.coverage, 1);
  assert.strictEqual(result.interiorFraction, 1);
});

test('all not-rendered samples: zero coverage, zero entropy, no NaN', () => {
  const samples = samplesOf(Array.from({ length: 16 }, () => [NOT_RENDERED, 0]));
  const result = computeEscapeEntropy(samples);
  assert.strictEqual(result.coverage, 0);
  assert.strictEqual(result.entropy, 0);
  assert.strictEqual(result.entropyNormalized, 0);
  assert.strictEqual(result.interiorFraction, 0);
});

test('not-rendered samples are excluded from coverage denominator correctly', () => {
  const samples = samplesOf([
    ...Array.from({ length: 3 }, () => [NOT_RENDERED, 0]),
    ...Array.from({ length: 1 }, () => [INTERIOR, 0]),
  ]);
  const result = computeEscapeEntropy(samples);
  assert.strictEqual(result.coverage, 0.25);
  assert.strictEqual(result.interiorFraction, 1);
});

test('single occupied bin has zero entropy regardless of which bin', () => {
  const samples = samplesOf(Array.from({ length: 8 }, () => escaped(500)));
  const result = computeEscapeEntropy(samples);
  assert.strictEqual(result.entropy, 0);
});

test('two equally-populated, well-separated bins give entropy of exactly 1 bit', () => {
  const samples = samplesOf([
    ...Array.from({ length: 10 }, () => escaped(4)),
    ...Array.from({ length: 10 }, () => escaped(4000)),
  ]);
  const result = computeEscapeEntropy(samples);
  assert.ok(Math.abs(result.entropy - 1) < 1e-9, `expected ~1 bit, got ${result.entropy}`);
  assert.ok(Math.abs(result.entropyNormalized - 1 / Math.log2(BIN_COUNT)) < 1e-9);
});

test('entropy is independent of maxIter: same relative escape depths, different iter scale', () => {
  const low = samplesOf([
    ...Array.from({ length: 5 }, () => escaped(10)),
    ...Array.from({ length: 5 }, () => escaped(80)),
  ]);
  const high = samplesOf([
    ...Array.from({ length: 5 }, () => escaped(1000)),
    ...Array.from({ length: 5 }, () => escaped(8000)),
  ]);
  const lowResult = computeEscapeEntropy(low);
  const highResult = computeEscapeEntropy(high);
  assert.ok(Math.abs(lowResult.entropy - highResult.entropy) < 1e-9);
});

test('near-zero or negative smoothIter (early escape, negative nuPrime) does not throw or NaN', () => {
  const samples = samplesOf([escaped(0, -0.9), escaped(0, -0.99), escaped(1, -0.5)]);
  const result = computeEscapeEntropy(samples);
  assert.ok(Number.isFinite(result.entropy));
  assert.ok(Number.isFinite(result.entropyNormalized));
});

test('iteration count at the very top of ITER.max range does not throw or NaN', () => {
  const samples = samplesOf([escaped(8192, -0.1)]);
  const result = computeEscapeEntropy(samples);
  assert.ok(Number.isFinite(result.entropy));
});

test('maximum entropy is bounded by log2(BIN_COUNT)', () => {
  const pairs = [];
  for (let iter = 1; iter < 8192; iter += 40) pairs.push(escaped(iter));
  const result = computeEscapeEntropy(samplesOf(pairs));
  assert.ok(result.entropyNormalized <= 1 + 1e-9);
});
