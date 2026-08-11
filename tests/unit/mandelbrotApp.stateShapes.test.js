import { test } from 'node:test';
import assert from 'node:assert/strict';
import { share } from '../../src/share.js';
import { settings } from '../../src/settings.js';

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
  // Wide enough for overlay.js's drawGrid/drawCenterMarker/drawJuliaMarker,
  // needed once the round-trip test restores a state with gridOverlay/
  // centerMarker on, which draws at construction time (drawOverlay()).
  canvas.getContext = () => ({
    setTransform() {},
    clearRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    stroke() {},
    set strokeStyle(_v) {},
    set lineWidth(_v) {},
  });
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
    appendChild() {},
  };
}

// Minimal stand-in for the <optgroup>/<option> nodes populatePaletteMenu()
// (mandelbrot.js) builds via document.createElement — just enough surface
// for it to set label/value/textContent and append children without
// throwing.
function makeMockElement() {
  return {
    label: '',
    value: '',
    textContent: '',
    appendChild() {},
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
    mocks[`${name}IterMinus`] = makeMockControl();
    mocks[`${name}IterPlus`] = makeMockControl();
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
    'mandelbrotLandmarks', 'landmarksOverlay',
  ]) {
    mocks[id] = makeMockControl();
  }
  return mocks;
}

// `store` is a plain object used as the localStorage backing — shared across
// installGlobals() calls when a test needs a second app instance to read
// what a first one wrote (see the round-trip test below).
function installGlobals({ store = {} } = {}) {
  const mocks = buildDomMocks();
  globalThis.document = {
    getElementById: (id) => mocks[id],
    createElement: () => makeMockElement(),
    body: { classList: { toggle() {} } },
    activeElement: null,
  };
  globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
  globalThis.location = { search: '', origin: 'http://localhost', pathname: '/' };
  globalThis.localStorage = {
    getItem: (key) => (Object.hasOwn(store, key) ? store[key] : null),
    setItem: (key, value) => { store[key] = value; },
  };
  return mocks;
}

installGlobals();

const { MandelbrotApp } = await import('../../src/mandelbrot.js');

const TIER1_PANEL_KEYS = ['center', 'scale', 'maxIter', 'paletteType', 'smoothColoring', 'progressiveMode'];
const TIER1_PANEL_FORBIDDEN = ['gridOverlay', 'centerMarker', 'show'];
const SNAPSHOT_VIEW_TOP_KEYS = ['mandelbrotPanel', 'juliaPanel', 'juliaSeed'];
const SNAPSHOT_VIEW_TOP_FORBIDDEN = ['showMandelbrot', 'showJulia', 'juliaMarker', 'landmarksOverlay'];
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
  'showMandelbrot', 'showJulia', 'juliaMarker', 'landmarksOverlay',
];
const DISPLAY_PREFS_KEYS = [
  'mandelbrotPanelGridOverlay', 'mandelbrotPanelCenterMarker',
  'juliaPanelGridOverlay', 'juliaPanelCenterMarker',
  'juliaMarker', 'landmarksOverlay', 'showMandelbrot', 'showJulia',
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

function makeApp(opts) {
  installGlobals(opts);
  return new MandelbrotApp();
}

// Every field the two flat schema producers/consumers touch, mutated away
// from its constructor default — used by the round-trip test below to prove
// nothing is lost or misrouted going out through shareState() and back in
// through restoreSettings().
function mutateEveryField(app) {
  for (const side of ['mandelbrot', 'julia']) {
    const model = app.modelNamed(side);
    model.panel.center = new DOMPointReadOnly(0.11, -0.22);
    model.panel.scale = 0.5;
    model.panel.maxIter = 777;
    model.panel.paletteType = 2;
    model.panel.progressiveMode = 1;
    model.panel.smoothColoring = 1;
    model.panel.gridOverlay = 1;
    model.panel.centerMarker = 1;
    model.show = side === 'mandelbrot' ? 1 : 0;
  }
  app.juliaSeed = new DOMPointReadOnly(0.33, -0.44);
  app.juliaMarker = 1;
  app.landmarksOverlay = 1;
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
  app.landmarksOverlay = 1;

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
  const prefs = settings.captureDisplayPrefs(app);
  assertExactKeys(prefs, DISPLAY_PREFS_KEYS, 'captureDisplayPrefs');
  assertNoKeys(prefs, DISPLAY_PREFS_FORBIDDEN, 'captureDisplayPrefs');
});

test('captureDisplayPrefs reflects live model mutations', () => {
  const app = makeApp();
  app.modelNamed('mandelbrot').panel.gridOverlay = 1;
  assert.equal(settings.captureDisplayPrefs(app).mandelbrotPanelGridOverlay, 1);
});

// --- P1: flattenSnapshotForShare() (Tier 1 flat bridge) ---

test('flattenSnapshotForShare emits exactly the Tier-1 flat key set', () => {
  const app = makeApp();
  const flat = settings.flattenSnapshotForShare(app, app.snapshotView());
  assertExactKeys(flat, FLATTEN_SHARE_KEYS, 'flattenSnapshotForShare');
  assertNoKeys(flat, FLATTEN_SHARE_FORBIDDEN, 'flattenSnapshotForShare');
});

test('flattenSnapshotForShare values match the nested snapshotView fields', () => {
  const app = makeApp();
  const snap = app.snapshotView();
  const flat = settings.flattenSnapshotForShare(app, snap);
  assert.deepEqual(flat.mandelbrotPanelScale, snap.mandelbrotPanel.scale);
  assert.deepEqual(flat.juliaPanelMaxIter, snap.juliaPanel.maxIter);
  assert.deepEqual(flat.juliaSeed, snap.juliaSeed);
});

// --- P1: shareState() (full flat union) ---

test('shareState keys are exactly the union of Tier-1 flat and Tier-2 keys', () => {
  const app = makeApp();
  assertExactKeys(settings.shareState(app), SHARE_STATE_KEYS, 'shareState');
});

test('shareState is a superset of flattenSnapshotForShare and captureDisplayPrefs keys', () => {
  const app = makeApp();
  const shareKeys = new Set(Object.keys(settings.shareState(app)));
  for (const key of FLATTEN_SHARE_KEYS) assert.ok(shareKeys.has(key), `shareState missing ${key}`);
  for (const key of DISPLAY_PREFS_KEYS) assert.ok(shareKeys.has(key), `shareState missing ${key}`);
});

// --- Mossa 0: consumers (restoreDisplayPrefs, restoreSettings) — the reverse
// direction, currently only reachable through slow/flaky e2e. These pin the
// consumer side before the schema-declaration refactor touches it. ---

test('restoreDisplayPrefs(captureDisplayPrefs()) is the identity', () => {
  const app = makeApp();
  const original = settings.captureDisplayPrefs(app);

  // Mutate every Tier-2 field away from its captured value.
  app.modelNamed('mandelbrot').panel.gridOverlay = 1;
  app.modelNamed('mandelbrot').panel.centerMarker = 1;
  app.modelNamed('julia').panel.gridOverlay = 1;
  app.modelNamed('julia').panel.centerMarker = 1;
  app.modelNamed('mandelbrot').show = 0;
  app.modelNamed('julia').show = 0;
  app.juliaMarker = 1;
  app.landmarksOverlay = 1;

  app.restoreDisplayPrefs(original);

  assert.deepEqual(settings.captureDisplayPrefs(app), original);
});

// --- each model's schema declaration (see createModel()) is what
// snapshotView()/shareState()/captureDisplayPrefs()/restoreDisplayPrefs()/
// restoreSettings() now derive their per-side behavior from. ---

test('each model derives exactly the expected flat schema names', () => {
  const app = makeApp();
  const mandelbrot = app.models.find((m) => m.name === 'mandelbrot');
  const julia = app.models.find((m) => m.name === 'julia');
  assert.deepEqual(mandelbrot.schema, {
    panel: 'mandelbrotPanel',
    view: {
      center: 'mandelbrotPanelCenter', scale: 'mandelbrotPanelScale', maxIter: 'mandelbrotPanelMaxIter',
      paletteType: 'mandelbrotPanelPaletteType', progressiveMode: 'mandelbrotPanelProgressiveMode',
      smoothColoring: 'mandelbrotPanelSmoothColoring',
    },
    displayPrefs: { gridOverlay: 'mandelbrotPanelGridOverlay', centerMarker: 'mandelbrotPanelCenterMarker' },
    show: 'showMandelbrot',
  });
  assert.deepEqual(julia.schema, {
    panel: 'juliaPanel',
    view: {
      center: 'juliaPanelCenter', scale: 'juliaPanelScale', maxIter: 'juliaPanelMaxIter',
      paletteType: 'juliaPanelPaletteType', progressiveMode: 'juliaPanelProgressiveMode',
      smoothColoring: 'juliaPanelSmoothColoring',
    },
    displayPrefs: { gridOverlay: 'juliaPanelGridOverlay', centerMarker: 'juliaPanelCenterMarker' },
    show: 'showJulia',
  });
});

test('shareState round-trips through share.settingsData/localStorage/restoreSettings', () => {
  const store = {};
  const app1 = makeApp({ store });
  mutateEveryField(app1);
  const before = settings.shareState(app1);
  localStorage.setItem(app1.constructor.SETTINGS_KEY, JSON.stringify(share.settingsData(before)));

  const app2 = makeApp({ store });
  const after = settings.shareState(app2);

  assert.deepEqual(after, before);
});
