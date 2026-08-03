import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestGPUDevice, attachCanvas } from '../../src/renderer.js';

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
