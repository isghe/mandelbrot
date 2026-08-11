import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../../src/settings.js';
import { share } from '../../src/share.js';

// settings.js's functions take `app` explicitly rather than reading `this`,
// so a lightweight fake app — not the full MandelbrotApp + DOM mock harness
// mandelbrotApp.stateShapes.test.js builds — is enough here. That file
// already covers snapshotView/captureDisplayPrefs/shareState/
// flattenSnapshotForShare/restoreSettings' shapes through app.X() delegates;
// this file covers what's genuinely untested elsewhere: saveSettings,
// loadSettings, scheduleSaveSettings and buildShareUrl's own composition.

globalThis.DOMPointReadOnly ??= class DOMPointReadOnly {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
};

class FakeApp {
  static SETTINGS_KEY = 'isghe-mandelbrot-settings';
  static SETTINGS_SAVE_MS = 400;
  static POINT_KEYS = new Set(['center']);

  juliaSeed = new DOMPointReadOnly(-0.8, 0.156);
  juliaMarker = 0;
  landmarksOverlay = 0;
  saveSettingsTimer = null;

  constructor() {
    const schema = (name) => ({
      panel: `${name}Panel`,
      view: {
        center: `${name}PanelCenter`, scale: `${name}PanelScale`, maxIter: `${name}PanelMaxIter`,
        paletteType: `${name}PanelPaletteType`, progressiveMode: `${name}PanelProgressiveMode`,
        smoothColoring: `${name}PanelSmoothColoring`,
      },
      displayPrefs: { gridOverlay: `${name}PanelGridOverlay`, centerMarker: `${name}PanelCenterMarker` },
      show: `show${name[0].toUpperCase()}${name.slice(1)}`,
    });
    const makePanel = () => ({
      center: new DOMPointReadOnly(-0.5, 0), scale: 3.0, maxIter: 256,
      paletteType: 4, progressiveMode: 0, smoothColoring: 0,
      gridOverlay: 0, centerMarker: 0, pivot: new DOMPointReadOnly(-0.5, 0),
    });
    this.models = [
      { name: 'mandelbrot', schema: schema('mandelbrot'), panel: makePanel(), show: 1 },
      { name: 'julia', schema: schema('julia'), panel: makePanel(), show: 1 },
    ];
    this.initialState = settings.snapshotView(this);
  }
}

function installGlobals({ store = {}, search = '' } = {}) {
  globalThis.location = { search, origin: 'https://example.com', pathname: '/mandelbrot/' };
  globalThis.history = { replaceState: (_state, _title, url) => { globalThis.location.href = url; } };
  globalThis.localStorage = {
    getItem: (key) => (Object.hasOwn(store, key) ? store[key] : null),
    setItem: (key, value) => { store[key] = value; },
  };
  return store;
}

test('saveSettings -> loadSettings round-trips shareState through localStorage', () => {
  installGlobals();
  const app = new FakeApp();
  app.models[0].panel.scale = 1.5;

  settings.saveSettings(app);
  const loaded = settings.loadSettings(app);

  assert.equal(loaded.mandelbrotPanelScale, 1.5);
});

test('saveSettings also updates the URL via buildShareUrl', () => {
  installGlobals();
  const app = new FakeApp();
  app.models[0].panel.scale = 1.5;

  settings.saveSettings(app);

  assert.equal(new URL(globalThis.location.href).searchParams.get('mscale'), '1.5');
});

test('loadSettings returns null when localStorage is empty', () => {
  installGlobals();
  const app = new FakeApp();
  assert.equal(settings.loadSettings(app), null);
});

test('scheduleSaveSettings debounces: only the last call within the window saves', (t) => {
  installGlobals();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = new FakeApp();

  settings.scheduleSaveSettings(app);
  app.models[0].panel.scale = 1.5;
  settings.scheduleSaveSettings(app);

  assert.equal(settings.loadSettings(app), null, 'must not have saved yet');
  t.mock.timers.tick(FakeApp.SETTINGS_SAVE_MS);

  assert.equal(settings.loadSettings(app).mandelbrotPanelScale, 1.5);
});

test('buildShareUrl returns a bare URL when state matches initialState', () => {
  installGlobals();
  const app = new FakeApp();
  assert.equal(settings.buildShareUrl(app), 'https://example.com/mandelbrot/');
});

test('buildShareUrl encodes only fields that differ from initialState', () => {
  installGlobals();
  const app = new FakeApp();
  app.models[0].panel.scale = 1.5;

  const params = new URL(settings.buildShareUrl(app)).searchParams;

  assert.equal(params.get('mscale'), '1.5');
  assert.equal(params.has('miter'), false);
});

test('restoreSettings from a share-URL restores state and persists it (saveSettings)', () => {
  const store = installGlobals({ search: `?v=${share.SCHEMA_VERSION}&mscale=1.5` });
  const app = new FakeApp();

  settings.restoreSettings(app);

  assert.equal(app.models[0].panel.scale, 1.5);
  assert.ok(Object.hasOwn(store, FakeApp.SETTINGS_KEY), 'shared state must be persisted back to localStorage');
});
