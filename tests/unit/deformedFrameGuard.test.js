import { test } from 'node:test';
import assert from 'node:assert/strict';

// Same minimal mock-DOM harness as mandelbrotApp.stateShapes.test.js — see
// that file's header comment for why a full MandelbrotApp needs this much
// mocking just to exercise plain-object/synchronous methods.
globalThis.__MANDELBROT_TEST__ = true;

globalThis.DOMPointReadOnly ??= class DOMPointReadOnly {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
};

function makeMockCanvas({ id = '', cssWidth = 800, cssHeight = 600 } = {}) {
  const classes = new Set();
  return {
    id,
    width: 0,
    height: 0,
    classList: {
      toggle(name, force) { force ? classes.add(name) : classes.delete(name); },
      add(name) { classes.add(name); },
      contains(name) { return classes.has(name); },
    },
    getBoundingClientRect: () => ({ width: cssWidth, height: cssHeight }),
    addEventListener() {},
  };
}

function makeMockOverlayCanvas(opts) {
  const canvas = makeMockCanvas(opts);
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

function makeMockElement() {
  return { label: '', value: '', textContent: '', appendChild() {} };
}

function buildDomMocks() {
  const mocks = {};
  for (const name of ['mandelbrot', 'julia']) {
    const cap = name[0].toUpperCase() + name.slice(1);
    mocks[`${name}Gfx`] = makeMockCanvas({ id: `${name}Gfx` });
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

function installGlobals() {
  const mocks = buildDomMocks();
  globalThis.document = {
    getElementById: (id) => mocks[id],
    createElement: () => makeMockElement(),
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

function makeApp() {
  installGlobals();
  return new MandelbrotApp();
}

test('isDeformedFrame is false when backing store aspect matches on-screen aspect', () => {
  const app = makeApp();
  const panel = app.modelNamed('mandelbrot').panel;
  panel.canvas.width = 800;
  panel.canvas.height = 600;
  panel.canvas.getBoundingClientRect = () => ({ width: 400, height: 300 }); // same 4:3 aspect, different dpr
  assert.equal(app.isDeformedFrame(panel), false);
});

test('isDeformedFrame is true when backing store X/Y ratio does not match the on-screen shape (X-squash case)', () => {
  const app = makeApp();
  const panel = app.modelNamed('mandelbrot').panel;
  // On-screen the canvas is a normal 800x600 box, but the backing store was
  // sized from a transient near-zero-width rect (e.g. mid-layout-thrash) —
  // this is the X-squash scenario the guard exists for.
  panel.canvas.width = 4;
  panel.canvas.height = 600;
  panel.canvas.getBoundingClientRect = () => ({ width: 800, height: 600 });
  assert.equal(app.isDeformedFrame(panel), true);
});

test('isDeformedFrame is false when the panel is hidden/collapsed (zero on-screen size)', () => {
  const app = makeApp();
  const panel = app.modelNamed('mandelbrot').panel;
  panel.canvas.width = 800;
  panel.canvas.height = 600;
  panel.canvas.getBoundingClientRect = () => ({ width: 0, height: 0 });
  assert.equal(app.isDeformedFrame(panel), false);
});

// Guard is exercised via renderOnce (not renderPanel directly) below,
// because the deformity check runs as a pre-pass over every visible panel
// before any panel is rendered — see renderOnce's comment.
for (const name of ['mandelbrot', 'julia']) {
  test(`renderOnce halts all rendering and shows a fatal error when the ${name} panel's frame is deformed (guard is panel-agnostic)`, () => {
    const app = makeApp();
    const mandelbrot = app.modelNamed('mandelbrot').panel;
    const julia = app.modelNamed('julia').panel;
    let mandelbrotRendered = false;
    let juliaRendered = false;
    mandelbrot.renderer = { render: () => { mandelbrotRendered = true; } };
    julia.renderer = { render: () => { juliaRendered = true; } };

    const deformed = app.modelNamed(name).panel;
    deformed.canvas.width = 4;
    deformed.canvas.height = 600;
    deformed.canvas.getBoundingClientRect = () => ({ width: 800, height: 600 });

    app.renderOnce();

    assert.equal(mandelbrotRendered, false, 'must not submit any panel to the renderer, deformed or not');
    assert.equal(juliaRendered, false, 'must not submit any panel to the renderer, deformed or not');
    assert.equal(app.renderHalted, true);
    assert.equal(app.errorBox.style.display, 'block');
    assert.match(app.errorMessage.textContent, /Deformed frame detected/);
    assert.equal(app.reloadBtn.style.display, 'inline-block');
  });
}

test('the fatal error message carries enough context to root-cause a recurrence', () => {
  const app = makeApp();
  const panel = app.modelNamed('mandelbrot').panel;
  panel.renderer = { render() {} };
  panel.canvas.width = 4;
  panel.canvas.height = 600;
  panel.canvas.getBoundingClientRect = () => ({ width: 800, height: 600 });
  panel.scale = 1.5e-13;
  panel.maxIter = 4096;
  app.lastResizeAt = Date.now() - 42;

  app.renderOnce();

  const msg = app.errorMessage.textContent;
  assert.match(msg, /scale=1\.5e-13/);
  assert.match(msg, /maxIter=4096/);
  assert.match(msg, /devicePixelRatio=/);
  assert.match(msg, /msSinceLastResize=\d+/);
  assert.match(msg, /deviceLost=false/);
});

test('renderOnce is a no-op once renderHalted is set', () => {
  const app = makeApp();
  const panel = app.modelNamed('mandelbrot').panel;
  let rendered = false;
  panel.renderer = { render: () => { rendered = true; } };
  panel.canvas.width = 800;
  panel.canvas.height = 600;
  panel.canvas.getBoundingClientRect = () => ({ width: 800, height: 600 });

  app.renderHalted = true;
  app.renderOnce();

  assert.equal(rendered, false);
});

// The last frame presented before a fatal error (e.g. a real DEVICE_HUNG)
// can be visibly corrupted, and nothing renders again until reload — a
// centered error box alone left that corrupted frame visible around/behind
// it. showFatalError must hide every panel's canvas so no corrupted pixels
// can remain on screen once a fatal error is shown.
test('showFatalError hides every panel\'s gfx and overlay canvas', () => {
  const app = makeApp();
  app.showFatalError('boom');

  for (const name of ['mandelbrot', 'julia']) {
    const panel = app.modelNamed(name).panel;
    assert.equal(panel.canvas.classList.contains('panel-hidden'), true, `${name} gfx canvas must be hidden`);
    assert.equal(panel.overlayCanvas.classList.contains('panel-hidden'), true, `${name} overlay canvas must be hidden`);
  }
});

// Reset (or any other panel-visibility toggle) after a fatal error must not
// re-expose the corrupted canvas: updatePanelVisibility toggles
// panel-hidden based on `show`, which would otherwise remove the class
// showFatalError just added.
test('updatePanelVisibility keeps canvases hidden after a fatal error, even when the panel is shown', () => {
  const app = makeApp();
  app.handleDeviceLost({ reason: 'unknown', message: 'DXGI_ERROR_DEVICE_HUNG (0x887A0006)' });

  app.modelNamed('mandelbrot').show = true;
  app.modelNamed('julia').show = true;
  app.updatePanelVisibility();

  for (const name of ['mandelbrot', 'julia']) {
    const panel = app.modelNamed(name).panel;
    assert.equal(panel.canvas.classList.contains('panel-hidden'), true, `${name} gfx canvas must stay hidden`);
    assert.equal(panel.overlayCanvas.classList.contains('panel-hidden'), true, `${name} overlay canvas must stay hidden`);
  }
});

// Same guarantee via the other halt flag — renderHalted alone (no device
// loss) must also survive a visibility toggle, not just deviceLost.
test('updatePanelVisibility keeps canvases hidden when only renderHalted is set', () => {
  const app = makeApp();
  app.handleUncapturedError('Validation Error: simulated GPU error');

  app.modelNamed('mandelbrot').show = true;
  app.modelNamed('julia').show = true;
  app.updatePanelVisibility();

  for (const name of ['mandelbrot', 'julia']) {
    const panel = app.modelNamed(name).panel;
    assert.equal(panel.canvas.classList.contains('panel-hidden'), true, `${name} gfx canvas must stay hidden`);
    assert.equal(panel.overlayCanvas.classList.contains('panel-hidden'), true, `${name} overlay canvas must stay hidden`);
  }
});

test('handleUncapturedError halts rendering, shows a fatal error, and logs an app-state snapshot', () => {
  const app = makeApp();
  const mandelbrot = app.modelNamed('mandelbrot').panel;
  mandelbrot.scale = 1.5e-13;
  mandelbrot.maxIter = 4096;
  mandelbrot.canvas.width = 800;
  mandelbrot.canvas.height = 600;
  app.lastResizeAt = Date.now() - 42;

  const originalConsoleError = console.error;
  const logs = [];
  console.error = (msg) => logs.push(msg);
  try {
    app.handleUncapturedError('Validation Error: something exploded');
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(app.renderHalted, true);
  assert.equal(app.errorBox.style.display, 'block');
  assert.match(app.errorMessage.textContent, /WebGPU error: Validation Error: something exploded/);
  assert.equal(app.reloadBtn.style.display, 'inline-block');

  assert.equal(logs.length, 1);
  assert.match(logs[0], /Validation Error: something exploded/);
  assert.match(logs[0], /devicePixelRatio=/);
  assert.match(logs[0], /msSinceLastResize=\d+/);
  assert.match(logs[0], /"name":"mandelbrot"/);
  assert.match(logs[0], /"scale":1\.5e-13/);
  assert.match(logs[0], /"maxIter":4096/);
  assert.match(logs[0], /"canvas":"800x600"/);
});

// Regression coverage for a diagnostic gap found from a real DEVICE_HUNG/TDR
// (D3D12) hit in the wild: onDeviceLost used to just show the raw
// driver message with no app-state context, unlike handleUncapturedError —
// so a real device loss couldn't be correlated with what the app was doing
// (which panel, scale, iteration count) when it happened.
test('handleDeviceLost sets deviceLost, shows a fatal error, and logs the same app-state snapshot as handleUncapturedError', () => {
  const app = makeApp();
  const julia = app.modelNamed('julia').panel;
  julia.scale = 2.3e-14;
  julia.maxIter = 8192;
  julia.canvas.width = 640;
  julia.canvas.height = 480;
  app.lastResizeAt = Date.now() - 10;

  const originalConsoleError = console.error;
  const logs = [];
  console.error = (msg) => logs.push(msg);
  try {
    app.handleDeviceLost({ reason: 'unknown', message: 'DXGI_ERROR_DEVICE_HUNG (0x887A0006)' });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(app.deviceLost, true);
  assert.equal(app.errorBox.style.display, 'block');
  assert.match(app.errorMessage.textContent, /WebGPU device lost \(unknown\): DXGI_ERROR_DEVICE_HUNG/);
  assert.equal(app.reloadBtn.style.display, 'inline-block');

  assert.equal(logs.length, 1);
  assert.match(logs[0], /DXGI_ERROR_DEVICE_HUNG/);
  assert.match(logs[0], /devicePixelRatio=/);
  assert.match(logs[0], /msSinceLastResize=\d+/);
  assert.match(logs[0], /"name":"julia"/);
  assert.match(logs[0], /"scale":2\.3e-14/);
  assert.match(logs[0], /"maxIter":8192/);
  assert.match(logs[0], /"canvas":"640x480"/);
});

// End-to-end reproduction of the reported scenario: a resize/layout-thrash
// event (window resize, panel visibility toggle) is caught mid-transition,
// so resizeCanvasBackingStore() (fractalPanel.js) bakes a torn width/height
// into the canvas's backing store; by the time the next renderOnce() fires,
// layout has settled and getBoundingClientRect() reports the panel's true
// on-screen shape again — which now disagrees with the backing store. This
// drives the guard through the app's real object graph (resizeVisiblePanels
// -> renderOnce -> renderPanel), not by calling isDeformedFrame/renderPanel
// directly with hand-picked numbers.
test('a transient near-zero-width rect during a resize, followed by renderOnce once layout settles, is caught before a frame is drawn', () => {
  const app = makeApp();
  const mandelbrot = app.modelNamed('mandelbrot').panel;
  const julia = app.modelNamed('julia').panel;
  let mandelbrotRendered = false;
  let juliaRendered = false;
  mandelbrot.renderer = { render: () => { mandelbrotRendered = true; } };
  julia.renderer = { render: () => { juliaRendered = true; } };

  // Layout mid-thrash: the Mandelbrot canvas's box is momentarily ~0 wide.
  mandelbrot.canvas.getBoundingClientRect = () => ({ width: 0.4, height: 600 });
  app.resizeVisiblePanels(); // mirrors onResize (mandelbrot.js)
  assert.equal(mandelbrot.canvas.width, 1, 'backing store clamped to the Math.max(1, …) floor, not 0');
  assert.equal(mandelbrot.canvas.height, 600);

  // Layout has now settled to its real on-screen size, but the backing
  // store above was never corrected (no further resize event fires).
  mandelbrot.canvas.getBoundingClientRect = () => ({ width: 800, height: 600 });

  const originalConsoleError = console.error;
  const logs = [];
  console.error = (msg) => logs.push(msg);
  try {
    app.renderOnce();
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(mandelbrotRendered, false, 'the deformed panel must not reach the GPU');
  assert.equal(juliaRendered, false, 'renderHalted stops the whole app, not just the offending panel');
  assert.equal(app.renderHalted, true);
  assert.equal(app.errorBox.style.display, 'block');
  assert.match(app.errorMessage.textContent, /Deformed frame detected on panel "mandelbrotGfx"/);

  // The diagnostic console.error actually fires, with the numbers that
  // would let this exact scenario be root-caused: the backing store's
  // near-zero-width aspect (1/600) vs the settled on-screen aspect (1.333).
  assert.equal(logs.length, 1);
  assert.match(logs[0], /canvas backing store 1x600 \(aspect 0\.0017\)/);
  assert.match(logs[0], /on-screen size 800\.0x600\.0 \(aspect 1\.3333\)/);
  assert.match(logs[0], /msSinceLastResize=\d+/);
});
