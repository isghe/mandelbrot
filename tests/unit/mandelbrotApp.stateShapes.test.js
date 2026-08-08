import { test } from 'node:test';
import assert from 'node:assert/strict';

// mandelbrot.js relies on a full browser environment (DOM, WebGPU, storage).
// This file only exercises MandelbrotApp's constructor (state shapes are all
// synchronous, plain-object methods) — never init() (GPU) — via a minimal
// mock harness, same spirit as fractalPanel.test.js's canvas mocks.
globalThis.__MANDELBROT_TEST__ = true;

globalThis.DOMPointReadOnly ??= class DOMPointReadOnly {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
};

function makeMockCanvas({ cssWidth = 800, cssHeight = 600 } = {}) {
  return {
    width: 0,
    height: 0,
    classList: { toggle() {} },
    getBoundingClientRect: () => ({ width: cssWidth, height: cssHeight }),
    addEventListener() {},
  };
}

function makeMockOverlayCanvas(opts) {
  const canvas = makeMockCanvas(opts);
  canvas.getContext = () => ({ setTransform() {}, clearRect() {} });
  return canvas;
}

function makeMockControl() {
  return {
    checked: false,
    value: '',
    textContent: '',
    min: 0,
    max: 0,
    style: {},
    classList: { toggle() {} },
    onclick: null,
    onchange: null,
    oninput: null,
  };
}

// Mirrors createModel()'s mechanical id composition (mandelbrot.js) for both
// models plus the app-level ids resolved directly in the constructor.
function buildDomMocks() {
  const mocks = {};
  for (const name of ['mandelbrot', 'julia']) {
    const cap = name[0].toUpperCase() + name.slice(1);
    mocks[`${name}Gfx`] = makeMockCanvas();
    mocks[`${name}Overlay`] = makeMockOverlayCanvas();
    mocks[`${name}IterSlider`] = makeMockControl();
    mocks[`${name}IterLabel`] = makeMockControl();
    mocks[`${name}ZoomSlider`] = makeMockControl();
    mocks[`${name}ZoomLabel`] = makeMockControl();
    mocks[`${name}PaletteType`] = makeMockControl();
    mocks[`${name}ProgressiveMode`] = makeMockControl();
    mocks[`${name}SmoothColoring`] = makeMockControl();
    mocks[`${name}GridOverlay`] = makeMockControl();
    mocks[`${name}CenterMarker`] = makeMockControl();
    mocks[`show${cap}`] = makeMockControl();
    mocks[`ui${cap}`] = makeMockControl();
  }
  for (const id of [
    'selectionBox', 'noVizMessage', 'gpuError', 'gpuErrorMessage', 'gpuReloadBtn',
    'uiToggleBtn', 'ui', 'juliaMarker', 'backBtn', 'forwardBtn', 'resetBtn', 'shareBtn',
  ]) {
    mocks[id] = makeMockControl();
  }
  return mocks;
}

function installGlobals() {
  const mocks = buildDomMocks();
  globalThis.document = {
    getElementById: (id) => mocks[id],
    body: { classList: { toggle() {} } },
    activeElement: null,
  };
  globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
  globalThis.location = { search: '', origin: 'http://localhost', pathname: '/' };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  return mocks;
}

installGlobals();

const { MandelbrotApp } = await import('../../src/mandelbrot.js');

const TIER1_PANEL_KEYS = ['center', 'scale', 'maxIter', 'paletteType', 'smoothColoring', 'progressiveMode'];
const TIER1_PANEL_FORBIDDEN = ['gridOverlay', 'centerMarker', 'show'];
const SNAPSHOT_VIEW_TOP_KEYS = ['mandelbrotPanel', 'juliaPanel', 'juliaSeed'];
const SNAPSHOT_VIEW_TOP_FORBIDDEN = ['showMandelbrot', 'showJulia', 'juliaMarker'];
const FLATTEN_SHARE_KEYS = [
  'mandelbrotPanelCenter', 'mandelbrotPanelScale', 'mandelbrotPanelMaxIter',
  'mandelbrotPanelPaletteType', 'mandelbrotPanelProgressiveMode', 'mandelbrotPanelSmoothColoring',
  'juliaSeed',
  'juliaPanelCenter', 'juliaPanelScale', 'juliaPanelMaxIter',
  'juliaPanelPaletteType', 'juliaPanelProgressiveMode', 'juliaPanelSmoothColoring',
];
const FLATTEN_SHARE_FORBIDDEN = [
  'mandelbrotPanelGridOverlay', 'mandelbrotPanelCenterMarker',
  'juliaPanelGridOverlay', 'juliaPanelCenterMarker',
  'showMandelbrot', 'showJulia', 'juliaMarker',
];
const DISPLAY_PREFS_KEYS = [
  'mandelbrotPanelGridOverlay', 'mandelbrotPanelCenterMarker',
  'juliaPanelGridOverlay', 'juliaPanelCenterMarker',
  'juliaMarker', 'showMandelbrot', 'showJulia',
];
const DISPLAY_PREFS_FORBIDDEN = [
  'mandelbrotPanelCenter', 'mandelbrotPanelScale', 'mandelbrotPanelMaxIter',
  'mandelbrotPanelPaletteType', 'mandelbrotPanelProgressiveMode', 'mandelbrotPanelSmoothColoring',
  'juliaPanelCenter', 'juliaPanelScale', 'juliaPanelMaxIter',
  'juliaPanelPaletteType', 'juliaPanelProgressiveMode', 'juliaPanelSmoothColoring',
  'mandelbrotPanel', 'juliaPanel',
];
const SHARE_STATE_KEYS = [...FLATTEN_SHARE_KEYS, ...DISPLAY_PREFS_KEYS];

function assertExactKeys(obj, expectedKeys, label) {
  assert.deepEqual(Object.keys(obj).sort(), [...expectedKeys].sort(), label);
}

function assertNoKeys(obj, forbidden, label) {
  for (const key of forbidden) {
    assert.equal(Object.hasOwn(obj, key), false, `${label}: must not have ${key}`);
  }
}

function makeApp() {
  installGlobals();
  return new MandelbrotApp();
}

// --- P0: snapshotView() (undo-history, Tier 1 only) ---

test('snapshotView top-level keys are exactly mandelbrotPanel/juliaPanel/juliaSeed', () => {
  const app = makeApp();
  const snap = app.snapshotView();
  assertExactKeys(snap, SNAPSHOT_VIEW_TOP_KEYS, 'snapshotView top-level');
  assertNoKeys(snap, SNAPSHOT_VIEW_TOP_FORBIDDEN, 'snapshotView top-level');
});

test('snapshotView each panel has exactly the Tier-1 keys, no display prefs', () => {
  const app = makeApp();
  const snap = app.snapshotView();
  for (const side of ['mandelbrotPanel', 'juliaPanel']) {
    assertExactKeys(snap[side], TIER1_PANEL_KEYS, `snapshotView.${side}`);
    assertNoKeys(snap[side], TIER1_PANEL_FORBIDDEN, `snapshotView.${side}`);
  }
});

test('snapshotView is unchanged when only Tier-2 display prefs are mutated', () => {
  const app = makeApp();
  const before = app.snapshotView();

  app.modelNamed('julia').panel.gridOverlay = 1;
  app.modelNamed('mandelbrot').show = 0;
  app.juliaMarker = 1;

  const after = app.snapshotView();
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const side of ['mandelbrotPanel', 'juliaPanel']) {
    assert.deepEqual(Object.keys(after[side]).sort(), TIER1_PANEL_KEYS.slice().sort());
    for (const key of TIER1_PANEL_KEYS) {
      assert.deepEqual(after[side][key], before[side][key], `${side}.${key} must be unchanged`);
    }
  }
});

// --- P0: captureDisplayPrefs() (Tier 2 only) ---

test('captureDisplayPrefs keys are exactly the Tier-2 set, no Tier-1 fields', () => {
  const app = makeApp();
  const prefs = app.captureDisplayPrefs();
  assertExactKeys(prefs, DISPLAY_PREFS_KEYS, 'captureDisplayPrefs');
  assertNoKeys(prefs, DISPLAY_PREFS_FORBIDDEN, 'captureDisplayPrefs');
});

test('captureDisplayPrefs reflects live model mutations', () => {
  const app = makeApp();
  app.modelNamed('mandelbrot').panel.gridOverlay = 1;
  assert.equal(app.captureDisplayPrefs().mandelbrotPanelGridOverlay, 1);
});

// --- P1: flattenSnapshotForShare() (Tier 1 flat bridge) ---

test('flattenSnapshotForShare emits exactly the Tier-1 flat key set', () => {
  const app = makeApp();
  const flat = app.flattenSnapshotForShare(app.snapshotView());
  assertExactKeys(flat, FLATTEN_SHARE_KEYS, 'flattenSnapshotForShare');
  assertNoKeys(flat, FLATTEN_SHARE_FORBIDDEN, 'flattenSnapshotForShare');
});

test('flattenSnapshotForShare values match the nested snapshotView fields', () => {
  const app = makeApp();
  const snap = app.snapshotView();
  const flat = app.flattenSnapshotForShare(snap);
  assert.deepEqual(flat.mandelbrotPanelScale, snap.mandelbrotPanel.scale);
  assert.deepEqual(flat.juliaPanelMaxIter, snap.juliaPanel.maxIter);
  assert.deepEqual(flat.juliaSeed, snap.juliaSeed);
});

// --- P1: shareState() (full flat union) ---

test('shareState keys are exactly the union of Tier-1 flat and Tier-2 keys', () => {
  const app = makeApp();
  assertExactKeys(app.shareState(), SHARE_STATE_KEYS, 'shareState');
});

test('shareState is a superset of flattenSnapshotForShare and captureDisplayPrefs keys', () => {
  const app = makeApp();
  const shareKeys = new Set(Object.keys(app.shareState()));
  for (const key of FLATTEN_SHARE_KEYS) assert.ok(shareKeys.has(key), `shareState missing ${key}`);
  for (const key of DISPLAY_PREFS_KEYS) assert.ok(shareKeys.has(key), `shareState missing ${key}`);
});
