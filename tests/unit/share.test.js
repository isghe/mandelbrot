import { test } from 'node:test';
import assert from 'node:assert/strict';
import { share } from '../../src/share.js';

const initialState = {
  mandelbrotPanelCenter: { x: -0.5, y: 0 },
  mandelbrotPanelScale: 3.0,
  mandelbrotPanelMaxIter: 256,
  juliaSeed: { x: -0.8, y: 0.156 },
  juliaPanelCenter: { x: -0.8, y: 0.156 },
  juliaPanelScale: 3.0,
  juliaPanelMaxIter: 256,
  juliaPanelPaletteType: 4,
  juliaPanelProgressiveMode: 0,
  juliaPanelSmoothColoring: 0,
  mandelbrotPanelPaletteType: 4,
  mandelbrotPanelProgressiveMode: 0,
  mandelbrotPanelSmoothColoring: 0,
};

function baseState(overrides = {}) {
  return {
    ...initialState,
    mandelbrotPanelCenter: { ...initialState.mandelbrotPanelCenter },
    juliaSeed: { ...initialState.juliaSeed },
    juliaPanelCenter: { ...initialState.juliaPanelCenter },
    mandelbrotPanelGridOverlay: 0,
    mandelbrotPanelCenterMarker: 0,
    juliaPanelGridOverlay: 0,
    juliaPanelCenterMarker: 0,
    juliaMarker: 0,
    showMandelbrot: 1,
    showJulia: 0,
    ...overrides,
  };
}

test('buildShareUrl returns a bare URL when state matches initialState', () => {
  const url = share.buildShareUrl(baseState(), initialState, 'https://example.com', '/mandelbrot/');
  assert.strictEqual(url, 'https://example.com/mandelbrot/');
});

test('buildShareUrl only encodes fields that differ from initialState', () => {
  const url = share.buildShareUrl(baseState({ mandelbrotPanelScale: 1.5 }), initialState, 'https://example.com', '/');
  const params = new URL(url).searchParams;
  assert.strictEqual(params.get('mscale'), '1.5');
  assert.strictEqual(params.has('iter'), false);
  assert.strictEqual(params.has('mx'), false);
});

test('buildShareUrl encodes mandelbrotPanelCenter as mx/my when it differs', () => {
  const url = share.buildShareUrl(
    baseState({ mandelbrotPanelCenter: { x: -1.25, y: 0.1 } }),
    initialState,
    'https://example.com',
    '/'
  );
  const params = new URL(url).searchParams;
  assert.strictEqual(params.get('mx'), '-1.25');
  assert.strictEqual(params.get('my'), '0.1');
});

test('buildShareUrl encodes juliaSeed as sx/sy when it differs', () => {
  const url = share.buildShareUrl(
    baseState({ juliaSeed: { x: -0.3, y: 0.9 } }),
    initialState,
    'https://example.com',
    '/'
  );
  const params = new URL(url).searchParams;
  assert.strictEqual(params.get('sx'), '-0.3');
  assert.strictEqual(params.get('sy'), '0.9');
});

test('buildShareUrl encodes overlay display flags whenever truthy, regardless of initialState', () => {
  const url = share.buildShareUrl(
    baseState({ mandelbrotPanelGridOverlay: 1, mandelbrotPanelCenterMarker: 1, juliaMarker: 1 }),
    initialState,
    'https://example.com',
    '/'
  );
  const params = new URL(url).searchParams;
  assert.strictEqual(params.get('grid'), '1');
  assert.strictEqual(params.get('centerMark'), '1');
  assert.strictEqual(params.get('juliaMark'), '1');
});

test('buildShareUrl omits falsy overlay display flags', () => {
  const url = share.buildShareUrl(baseState(), initialState, 'https://example.com', '/');
  const params = new URL(url).searchParams;
  assert.strictEqual(params.has('grid'), false);
  assert.strictEqual(params.has('centerMark'), false);
  assert.strictEqual(params.has('juliaMark'), false);
});

test('buildShareUrl encodes julia=1 when the Julia panel is shown, omitting it by default', () => {
  const shown = share.buildShareUrl(baseState({ showJulia: 1 }), initialState, 'https://example.com', '/');
  assert.strictEqual(new URL(shown).searchParams.get('julia'), '1');

  const hidden = share.buildShareUrl(baseState(), initialState, 'https://example.com', '/');
  assert.strictEqual(new URL(hidden).searchParams.has('julia'), false);
});

test('buildShareUrl encodes mandelbrot=0 when the Mandelbrot panel is hidden, omitting it by default', () => {
  const hidden = share.buildShareUrl(baseState({ showMandelbrot: 0 }), initialState, 'https://example.com', '/');
  assert.strictEqual(new URL(hidden).searchParams.get('mandelbrot'), '0');

  const shown = share.buildShareUrl(baseState(), initialState, 'https://example.com', '/');
  assert.strictEqual(new URL(shown).searchParams.has('mandelbrot'), false);
});

test('buildShareUrl stamps the current schema version on any URL that encodes state, not on a bare URL', () => {
  const bare = share.buildShareUrl(baseState(), initialState, 'https://example.com', '/');
  assert.strictEqual(new URL(bare).searchParams.has('v'), false);

  const changed = share.buildShareUrl(baseState({ mandelbrotPanelScale: 1.5 }), initialState, 'https://example.com', '/');
  assert.strictEqual(new URL(changed).searchParams.get('v'), String(share.SCHEMA_VERSION));
});

test('parseShareParams returns null for an empty search string', () => {
  assert.strictEqual(share.parseShareParams(''), null);
  assert.strictEqual(share.parseShareParams('?'), null);
});

test('parseShareParams parses mandelbrotPanelCenter only when both mx and my are present', () => {
  assert.strictEqual(share.parseShareParams('?v=3&mx=-1.25'), null);
  const s = share.parseShareParams('?v=3&mx=-1.25&my=0.1');
  assert.deepStrictEqual(s.mandelbrotPanelCenter, { x: -1.25, y: 0.1 });
});

test('parseShareParams parses juliaSeed only when both sx and sy are present', () => {
  const s = share.parseShareParams('?v=3&sx=-0.3&sy=0.9');
  assert.deepStrictEqual(s.juliaSeed, { x: -0.3, y: 0.9 });
});

test('parseShareParams parses juliaPanelCenter only when both jpx and jpy are present', () => {
  const s = share.parseShareParams('?jpx=0.1&jpy=-0.2');
  assert.deepStrictEqual(s.juliaPanelCenter, { x: 0.1, y: -0.2 });
});

test('buildShareUrl encodes the Julia panel\'s own pan/zoom (jpx/jpy/jscale) when it differs, and round-trips', () => {
  const state = baseState({ juliaPanelCenter: { x: 0.1, y: -0.2 }, juliaPanelScale: 1.5 });
  const url = share.buildShareUrl(state, initialState, 'https://example.com', '/');
  const search = new URL(url).search;
  assert.match(search, /jpx=0\.1/);
  assert.match(search, /jpy=-0\.2/);
  assert.match(search, /jscale=1\.5/);

  const parsed = share.parseShareParams(search);
  assert.deepStrictEqual(parsed.juliaPanelCenter, { x: 0.1, y: -0.2 });
  assert.strictEqual(parsed.juliaPanelScale, 1.5);
});

test('buildShareUrl encodes the Julia panel\'s own quality/look (jiter/jpalette/jprogressive/jsmooth) when it differs from initialState, and round-trips', () => {
  const state = baseState({
    juliaPanelMaxIter: 999,
    juliaPanelPaletteType: 2,
    juliaPanelProgressiveMode: 1,
    juliaPanelSmoothColoring: 1,
  });
  const url = share.buildShareUrl(state, initialState, 'https://example.com', '/');
  const search = new URL(url).search;
  assert.match(search, /jiter=999/);
  assert.match(search, /jpalette=2/);
  assert.match(search, /jprogressive=1/);
  assert.match(search, /jsmooth=1/);

  const parsed = share.parseShareParams(search);
  assert.strictEqual(parsed.juliaPanelMaxIter, 999);
  assert.strictEqual(parsed.juliaPanelPaletteType, 2);
  assert.strictEqual(parsed.juliaPanelProgressiveMode, 1);
  assert.strictEqual(parsed.juliaPanelSmoothColoring, 1);
});

test('buildShareUrl encodes the Julia panel\'s own grid/center-marker overlay flags (jgrid/jcenterMark) whenever truthy, regardless of initialState, and round-trips', () => {
  const state = baseState({ juliaPanelGridOverlay: 1, juliaPanelCenterMarker: 1 });
  const url = share.buildShareUrl(state, initialState, 'https://example.com', '/');
  const params = new URL(url).searchParams;
  assert.strictEqual(params.get('jgrid'), '1');
  assert.strictEqual(params.get('jcenterMark'), '1');

  const parsed = share.parseShareParams(new URL(url).search);
  assert.strictEqual(parsed.juliaPanelGridOverlay, 1);
  assert.strictEqual(parsed.juliaPanelCenterMarker, 1);
});

test('parseShareParams (v3) maps scalar params to their field names', () => {
  const s = share.parseShareParams('?v=3&iter=999&mandelbrot=0&julia=1&palette=2&progressive=1&smooth=1&grid=1&centerMark=1&juliaMark=1&mscale=1.5');
  assert.deepStrictEqual(s, {
    mandelbrotPanelMaxIter: 999,
    showMandelbrot: 0,
    showJulia: 1,
    mandelbrotPanelPaletteType: 2,
    mandelbrotPanelProgressiveMode: 1,
    mandelbrotPanelSmoothColoring: 1,
    mandelbrotPanelGridOverlay: 1,
    mandelbrotPanelCenterMarker: 1,
    juliaMarker: 1,
    mandelbrotPanelScale: 1.5,
  });
});

test('parseShareParams (legacy v2) reads the old x/y/jx/jy/scale param names into the renamed fields', () => {
  const s = share.parseShareParams('?v=2&x=-1.25&y=0.1&jx=-0.3&jy=0.9&scale=1.5');
  assert.deepStrictEqual(s.mandelbrotPanelCenter, { x: -1.25, y: 0.1 });
  assert.deepStrictEqual(s.juliaSeed, { x: -0.3, y: 0.9 });
  assert.strictEqual(s.mandelbrotPanelScale, 1.5);
});

test('parseShareParams (legacy v1) maps julia=1 to the exclusive-Julia visibility combo', () => {
  const s = share.parseShareParams('?julia=1&scale=1.5');
  assert.strictEqual(s.showJulia, 1);
  assert.strictEqual(s.showMandelbrot, 0);
});

test('parseShareParams (legacy v1) maps julia=0 (or absent) to Mandelbrot-only', () => {
  const explicit = share.parseShareParams('?julia=0&scale=1.5');
  assert.strictEqual(explicit.showJulia, 0);
  assert.strictEqual(explicit.showMandelbrot, 1);

  const absent = share.parseShareParams('?scale=1.5');
  assert.strictEqual(absent.showJulia, undefined);
  assert.strictEqual(absent.showMandelbrot, undefined);
});

test('parseShareParams treats a present-but-empty param as absent, not zero', () => {
  const s = share.parseShareParams('?iter=');
  assert.strictEqual(s, null);
});

test('parseShareParams skips non-finite values', () => {
  const s = share.parseShareParams('?iter=notanumber');
  assert.strictEqual(s, null);
});

test('parseShareParams treats absent v as legacy version 1 (old unprefixed "scale" name)', () => {
  const s = share.parseShareParams('?scale=1.5');
  assert.deepStrictEqual(s, { mandelbrotPanelScale: 1.5 });
});

test('parseShareParams accepts v=1 explicitly (legacy julia semantics, old "scale" name)', () => {
  const s = share.parseShareParams('?v=1&scale=1.5&julia=1');
  assert.deepStrictEqual(s, { mandelbrotPanelScale: 1.5, showJulia: 1, showMandelbrot: 0 });
});

test('parseShareParams rejects an unknown future version', () => {
  const s = share.parseShareParams('?v=6&mscale=1.5');
  assert.strictEqual(s, null);
});

test('parseShareParams treats a bare v with no other params as no state', () => {
  const s = share.parseShareParams('?v=1');
  assert.strictEqual(s, null);
});

test('buildShareUrl -> parseShareParams round-trips every changed field', () => {
  const state = baseState({
    mandelbrotPanelCenter: { x: -1.25, y: 0.1 },
    mandelbrotPanelScale: 1.5,
    mandelbrotPanelMaxIter: 999,
    juliaSeed: { x: -0.3, y: 0.9 },
    mandelbrotPanelPaletteType: 2,
    mandelbrotPanelProgressiveMode: 1,
    mandelbrotPanelSmoothColoring: 1,
    mandelbrotPanelGridOverlay: 1,
    mandelbrotPanelCenterMarker: 1,
    juliaMarker: 1,
    showMandelbrot: 0,
    showJulia: 1,
  });
  const url = share.buildShareUrl(state, initialState, 'https://example.com', '/');
  const parsed = share.parseShareParams(new URL(url).search);

  assert.deepStrictEqual(parsed, {
    mandelbrotPanelCenter: { x: -1.25, y: 0.1 },
    mandelbrotPanelScale: 1.5,
    mandelbrotPanelMaxIter: 999,
    juliaSeed: { x: -0.3, y: 0.9 },
    mandelbrotPanelPaletteType: 2,
    mandelbrotPanelProgressiveMode: 1,
    mandelbrotPanelSmoothColoring: 1,
    mandelbrotPanelGridOverlay: 1,
    mandelbrotPanelCenterMarker: 1,
    juliaMarker: 1,
    showMandelbrot: 0,
    showJulia: 1,
  });
});

test('settingsData produces a plain JSON-serializable snapshot of state', () => {
  const state = baseState({ mandelbrotPanelScale: 1.5, mandelbrotPanelGridOverlay: 1 });
  const data = share.settingsData(state);
  assert.deepStrictEqual(data, {
    v: 5,
    mandelbrotPanel: {
      center: { x: -0.5, y: 0 }, scale: 1.5,
      maxIter: 256, paletteType: 4, smoothColoring: 0, progressiveMode: 0,
      gridOverlay: 1, centerMarker: 0,
    },
    showMandelbrot: 1,
    showJulia: 0,
    juliaSeed: { x: -0.8, y: 0.156 },
    juliaPanel: {
      center: { x: -0.8, y: 0.156 }, scale: 3.0,
      maxIter: 256, paletteType: 4, smoothColoring: 0, progressiveMode: 0,
      gridOverlay: 0, centerMarker: 0,
    },
    juliaMarker: 0,
  });
  assert.strictEqual(JSON.stringify(data), JSON.stringify(JSON.parse(JSON.stringify(data))));
});

test('settingsData always stamps the current schema version', () => {
  const data = share.settingsData(baseState());
  assert.strictEqual(data.v, share.SCHEMA_VERSION);
});

// A real pre-v2 blob: flat center/scale/juliaC (pre-v3 names too), no `v`,
// juliaMode instead of showMandelbrot/showJulia — not derived from the
// current (v4, nested) settingsData() output.
function legacyV1Blob(juliaMode) {
  return {
    center: { x: -0.5, y: 0 },
    scale: 3.0,
    juliaC: { x: -0.8, y: 0.156 },
    maxIter: 256,
    juliaMode,
    paletteType: 4,
    progressiveMode: 0,
    smoothColoring: 0,
    gridOverlay: 0,
    centerMarker: 0,
    juliaMarker: 0,
  };
}

test('loadSettingsData treats an object without v as legacy version 1', () => {
  const loaded = share.loadSettingsData(legacyV1Blob(0));
  assert.strictEqual(loaded.showJulia, 0);
  assert.strictEqual(loaded.showMandelbrot, 1);
});

test('loadSettingsData (legacy v1) maps a truthy juliaMode to the exclusive-Julia visibility combo', () => {
  const loaded = share.loadSettingsData(legacyV1Blob(1));
  assert.strictEqual(loaded.showJulia, 1);
  assert.strictEqual(loaded.showMandelbrot, 0);
});

test('loadSettingsData (legacy v2) migrates center/scale/juliaC to the renamed fields', () => {
  const legacy = {
    v: 2,
    center: { x: -1.25, y: 0.1 },
    scale: 1.5,
    juliaC: { x: -0.3, y: 0.9 },
    showMandelbrot: 1,
    showJulia: 0,
  };
  const loaded = share.loadSettingsData(legacy);
  assert.deepStrictEqual(loaded.mandelbrotPanelCenter, { x: -1.25, y: 0.1 });
  assert.strictEqual(loaded.mandelbrotPanelScale, 1.5);
  assert.deepStrictEqual(loaded.juliaSeed, { x: -0.3, y: 0.9 });
  assert.strictEqual(loaded.center, undefined);
  assert.strictEqual(loaded.scale, undefined);
  assert.strictEqual(loaded.juliaC, undefined);
});

test('loadSettingsData (v3) passes flat mandelbrotPanelCenter/Scale and juliaPanelCenter/Scale through unchanged', () => {
  const flatV3 = {
    v: 3,
    mandelbrotPanelCenter: { x: -1.25, y: 0.1 },
    mandelbrotPanelScale: 1.5,
    juliaSeed: { x: -0.3, y: 0.9 },
    juliaPanelCenter: { x: 0.1, y: -0.2 },
    juliaPanelScale: 2.0,
    showMandelbrot: 1,
    showJulia: 0,
  };
  const loaded = share.loadSettingsData(flatV3);
  assert.deepStrictEqual(loaded.mandelbrotPanelCenter, { x: -1.25, y: 0.1 });
  assert.strictEqual(loaded.mandelbrotPanelScale, 1.5);
  assert.deepStrictEqual(loaded.juliaPanelCenter, { x: 0.1, y: -0.2 });
  assert.strictEqual(loaded.juliaPanelScale, 2.0);
  assert.strictEqual(loaded.mandelbrotPanel, undefined);
  assert.strictEqual(loaded.juliaPanel, undefined);
});

test('loadSettingsData (v5) flattens mandelbrotPanel/juliaPanel back into the flat mandelbrotPanelX/juliaPanelX field names, including the per-panel quality/look fields', () => {
  const stored = share.settingsData(baseState({ mandelbrotPanelScale: 1.5, juliaPanelPaletteType: 2 }));
  const loaded = share.loadSettingsData(stored);
  assert.deepStrictEqual(loaded.mandelbrotPanelCenter, { x: -0.5, y: 0 });
  assert.strictEqual(loaded.mandelbrotPanelScale, 1.5);
  assert.deepStrictEqual(loaded.juliaPanelCenter, { x: -0.8, y: 0.156 });
  assert.strictEqual(loaded.juliaPanelScale, 3.0);
  assert.strictEqual(loaded.juliaPanelPaletteType, 2);
  assert.strictEqual(loaded.juliaPanelMaxIter, 256);
  assert.strictEqual(loaded.juliaPanelGridOverlay, 0);
  assert.strictEqual(loaded.mandelbrotPanel, undefined);
  assert.strictEqual(loaded.juliaPanel, undefined);
});

test('loadSettingsData (v<5) promotes the old shared flat maxIter/paletteType/etc onto juliaPanel\'s own field names', () => {
  const v4 = {
    v: 4,
    mandelbrotPanel: { center: { x: -0.5, y: 0 }, scale: 3.0 },
    juliaPanel: { center: { x: -0.8, y: 0.156 }, scale: 3.0 },
    juliaSeed: { x: -0.8, y: 0.156 },
    maxIter: 999,
    paletteType: 2,
    smoothColoring: 1,
    progressiveMode: 1,
    gridOverlay: 1,
    centerMarker: 1,
    showMandelbrot: 1,
    showJulia: 0,
  };
  const loaded = share.loadSettingsData(v4);
  assert.strictEqual(loaded.juliaPanelMaxIter, 999);
  assert.strictEqual(loaded.juliaPanelPaletteType, 2);
  assert.strictEqual(loaded.juliaPanelSmoothColoring, 1);
  assert.strictEqual(loaded.juliaPanelProgressiveMode, 1);
  assert.strictEqual(loaded.juliaPanelGridOverlay, 1);
  assert.strictEqual(loaded.juliaPanelCenterMarker, 1);
});

test('loadSettingsData (v<5 data, pre-mandelbrotPanelX rename) renames the surviving bare top-level fields to mandelbrotPanelX', () => {
  const v4 = {
    v: 4,
    mandelbrotPanel: { center: { x: -0.5, y: 0 }, scale: 3.0 },
    juliaPanel: { center: { x: -0.8, y: 0.156 }, scale: 3.0 },
    juliaSeed: { x: -0.8, y: 0.156 },
    maxIter: 999,
    paletteType: 2,
    smoothColoring: 1,
    progressiveMode: 1,
    gridOverlay: 1,
    centerMarker: 1,
    showMandelbrot: 1,
    showJulia: 0,
  };
  const loaded = share.loadSettingsData(v4);
  assert.strictEqual(loaded.mandelbrotPanelMaxIter, 999);
  assert.strictEqual(loaded.mandelbrotPanelPaletteType, 2);
  assert.strictEqual(loaded.mandelbrotPanelSmoothColoring, 1);
  assert.strictEqual(loaded.mandelbrotPanelProgressiveMode, 1);
  assert.strictEqual(loaded.mandelbrotPanelGridOverlay, 1);
  assert.strictEqual(loaded.mandelbrotPanelCenterMarker, 1);
  assert.strictEqual(loaded.maxIter, undefined);
  assert.strictEqual(loaded.paletteType, undefined);
  assert.strictEqual(loaded.smoothColoring, undefined);
  assert.strictEqual(loaded.progressiveMode, undefined);
  assert.strictEqual(loaded.gridOverlay, undefined);
  assert.strictEqual(loaded.centerMarker, undefined);
});

test('loadSettingsData (ancient unnested legacy blob) renames the bare top-level fields to mandelbrotPanelX too', () => {
  const loaded = share.loadSettingsData(legacyV1Blob(0));
  assert.strictEqual(loaded.mandelbrotPanelMaxIter, 256);
  assert.strictEqual(loaded.mandelbrotPanelPaletteType, 4);
  assert.strictEqual(loaded.mandelbrotPanelSmoothColoring, 0);
  assert.strictEqual(loaded.mandelbrotPanelProgressiveMode, 0);
  assert.strictEqual(loaded.mandelbrotPanelGridOverlay, 0);
  assert.strictEqual(loaded.mandelbrotPanelCenterMarker, 0);
  assert.strictEqual(loaded.maxIter, undefined);
  assert.strictEqual(loaded.paletteType, undefined);
});

test('settingsData -> loadSettingsData round-trips the Mandelbrot side under mandelbrotPanelX with no stray bare fields', () => {
  const stored = share.settingsData(baseState({ mandelbrotPanelMaxIter: 999, mandelbrotPanelPaletteType: 2 }));
  const loaded = share.loadSettingsData(stored);
  assert.strictEqual(loaded.mandelbrotPanelMaxIter, 999);
  assert.strictEqual(loaded.mandelbrotPanelPaletteType, 2);
  assert.strictEqual(loaded.maxIter, undefined);
  assert.strictEqual(loaded.paletteType, undefined);
  assert.strictEqual(loaded.progressiveMode, undefined);
  assert.strictEqual(loaded.smoothColoring, undefined);
  assert.strictEqual(loaded.gridOverlay, undefined);
  assert.strictEqual(loaded.centerMarker, undefined);
});

test('loadSettingsData rejects an unknown future version', () => {
  const future = { ...share.settingsData(baseState()), v: 6 };
  assert.strictEqual(share.loadSettingsData(future), null);
});

test('loadSettingsData rejects a future version given as a string, not treated as legacy', () => {
  const future = { ...share.settingsData(baseState()), v: "6" };
  assert.strictEqual(share.loadSettingsData(future), null);
});

test('loadSettingsData rejects a non-numeric v', () => {
  const bad = { ...share.settingsData(baseState()), v: "not a number" };
  assert.strictEqual(share.loadSettingsData(bad), null);
});

test('loadSettingsData returns null for null or non-object input', () => {
  assert.strictEqual(share.loadSettingsData(null), null);
  assert.strictEqual(share.loadSettingsData('not an object'), null);
});
