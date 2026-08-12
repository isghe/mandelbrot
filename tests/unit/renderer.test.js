import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestGPUDevice, attachCanvas, frameBands, BAND_WORK_BUDGET } from '../../src/renderer.js';

// renderer.js wraps the WebGPU API (adapter/device/pipeline/shader
// compilation), which only exists in a real browser with a GPU adapter (or
// SwiftShader). Mocking it here would mean re-implementing GPUDevice,
// GPUTexture, GPUCommandEncoder, etc. in the test itself — the test would
// then verify the mock, not real WebGPU behavior, adding no real safety
// net. This module's actual coverage is the e2e Playwright suite
// (tests/*.spec.js), which runs against a real (headless) WebGPU adapter
// and exercises requestGPUDevice()/attachCanvas()/render() end-to-end.
//
// This test only guards the module's basic contract: it loads without
// throwing and exports requestGPUDevice/attachCanvas as functions.
test('requestGPUDevice is exported as a function', () => {
  assert.strictEqual(typeof requestGPUDevice, 'function');
});

test('attachCanvas is exported as a function', () => {
  assert.strictEqual(typeof attachCanvas, 'function');
});

// frameBands is pure (no WebGPU dependency), so it gets real coverage here —
// see renderer.js's BAND_WORK_BUDGET comment for why bands exist at all.

function assertExactCoverage(bands, height) {
  let y = 0;
  for (const band of bands) {
    assert.strictEqual(band.y, y);
    assert.ok(band.height > 0);
    y += band.height;
  }
  assert.strictEqual(y, height);
}

test('frameBands: cheap frame (work under budget) returns a single band', () => {
  const bands = frameBands(400, 300, 256);
  assert.deepStrictEqual(bands, [{ y: 0, height: 300 }]);
});

test('frameBands: expensive frame (high maxIter) splits into multiple bands', () => {
  const width = 972, height = 972, maxIter = 8192;
  const bands = frameBands(width, height, maxIter);
  assert.ok(bands.length > 1);
  assertExactCoverage(bands, height);
  for (const band of bands.slice(0, -1)) {
    assert.ok(width * band.height * maxIter <= BAND_WORK_BUDGET);
  }
});

test('frameBands: bands are contiguous with no gaps or overlap, covering exactly [0, height)', () => {
  const bands = frameBands(1920, 1000, 4677);
  assertExactCoverage(bands, 1000);
});

test('frameBands: never returns 0 rows and never more rows than the canvas height', () => {
  // Single row would already exceed the budget many times over — clamp to 1.
  const bands = frameBands(10000, 5, 8192, 1);
  assert.strictEqual(bands.length, 5);
  for (const band of bands) assert.strictEqual(band.height, 1);
});

test('frameBands: a custom budget larger than the whole frame yields a single band', () => {
  const bands = frameBands(1920, 1080, 8192, Number.MAX_SAFE_INTEGER);
  assert.deepStrictEqual(bands, [{ y: 0, height: 1080 }]);
});

test('frameBands: degenerate/non-finite inputs fall back to a single band, no infinite loop', () => {
  assert.deepStrictEqual(frameBands(0, 720, 256), [{ y: 0, height: 720 }]);
  assert.deepStrictEqual(frameBands(1280, 720, 0), [{ y: 0, height: 720 }]);
  assert.deepStrictEqual(frameBands(NaN, 720, 256), [{ y: 0, height: 720 }]);
  assert.deepStrictEqual(frameBands(1280, 720, NaN), [{ y: 0, height: 720 }]);
  assert.deepStrictEqual(frameBands(1280, 0, 256), [{ y: 0, height: 1 }]);
  assert.deepStrictEqual(frameBands(1280, NaN, 256), [{ y: 0, height: 1 }]);
});
