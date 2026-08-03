import { test } from 'node:test';
import assert from 'node:assert/strict';
import { share } from '../../src/share.js';

const initialState = {
  center: { x: -0.5, y: 0 },
  scale: 3.0,
  maxIter: 256,
  juliaC: { x: -0.8, y: 0.156 },
  paletteType: 4,
  progressiveMode: 0,
  smoothColoring: 0,
};

function baseState(overrides = {}) {
  return {
    ...initialState,
    center: { ...initialState.center },
    juliaC: { ...initialState.juliaC },
    gridOverlay: 0,
    centerMarker: 0,
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
  const url = share.buildShareUrl(baseState({ scale: 1.5 }), initialState, 'https://example.com', '/');
  const params = new URL(url).searchParams;
  assert.strictEqual(params.get('scale'), '1.5');
  assert.strictEqual(params.has('iter'), false);
  assert.strictEqual(params.has('x'), false);
});

test('buildShareUrl encodes center as a pair when it differs', () => {
  const url = share.buildShareUrl(
    baseState({ center: { x: -1.25, y: 0.1 } }),
    initialState,
    'https://example.com',
    '/'
  );
  const params = new URL(url).searchParams;
  assert.strictEqual(params.get('x'), '-1.25');
  assert.strictEqual(params.get('y'), '0.1');
});

test('buildShareUrl encodes juliaC as jx/jy when it differs', () => {
  const url = share.buildShareUrl(
    baseState({ juliaC: { x: -0.3, y: 0.9 } }),
    initialState,
    'https://example.com',
    '/'
  );
  const params = new URL(url).searchParams;
  assert.strictEqual(params.get('jx'), '-0.3');
  assert.strictEqual(params.get('jy'), '0.9');
});

test('buildShareUrl encodes overlay display flags whenever truthy, regardless of initialState', () => {
  const url = share.buildShareUrl(
    baseState({ gridOverlay: 1, centerMarker: 1, juliaMarker: 1 }),
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

test('buildShareUrl stamps v=2 on any URL that encodes state, not on a bare URL', () => {
  const bare = share.buildShareUrl(baseState(), initialState, 'https://example.com', '/');
  assert.strictEqual(new URL(bare).searchParams.has('v'), false);

  const changed = share.buildShareUrl(baseState({ scale: 1.5 }), initialState, 'https://example.com', '/');
  assert.strictEqual(new URL(changed).searchParams.get('v'), String(share.SCHEMA_VERSION));
});

test('parseShareParams returns null for an empty search string', () => {
  assert.strictEqual(share.parseShareParams(''), null);
  assert.strictEqual(share.parseShareParams('?'), null);
});

test('parseShareParams parses center only when both x and y are present', () => {
  assert.strictEqual(share.parseShareParams('?x=-1.25'), null);
  const s = share.parseShareParams('?x=-1.25&y=0.1');
  assert.deepStrictEqual(s.center, { x: -1.25, y: 0.1 });
});

test('parseShareParams parses juliaC only when both jx and jy are present', () => {
  const s = share.parseShareParams('?jx=-0.3&jy=0.9');
  assert.deepStrictEqual(s.juliaC, { x: -0.3, y: 0.9 });
});

test('parseShareParams (v2) maps scalar params to their field names', () => {
  const s = share.parseShareParams('?v=2&iter=999&mandelbrot=0&julia=1&palette=2&progressive=1&smooth=1&grid=1&centerMark=1&juliaMark=1&scale=1.5');
  assert.deepStrictEqual(s, {
    maxIter: 999,
    showMandelbrot: 0,
    showJulia: 1,
    paletteType: 2,
    progressiveMode: 1,
    smoothColoring: 1,
    gridOverlay: 1,
    centerMarker: 1,
    juliaMarker: 1,
    scale: 1.5,
  });
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

test('parseShareParams treats absent v as legacy version 1', () => {
  const s = share.parseShareParams('?scale=1.5');
  assert.deepStrictEqual(s, { scale: 1.5 });
});

test('parseShareParams accepts v=1 explicitly (legacy julia semantics)', () => {
  const s = share.parseShareParams('?v=1&scale=1.5&julia=1');
  assert.deepStrictEqual(s, { scale: 1.5, showJulia: 1, showMandelbrot: 0 });
});

test('parseShareParams rejects an unknown future version', () => {
  const s = share.parseShareParams('?v=3&scale=1.5');
  assert.strictEqual(s, null);
});

test('parseShareParams treats a bare v with no other params as no state', () => {
  const s = share.parseShareParams('?v=1');
  assert.strictEqual(s, null);
});

test('buildShareUrl -> parseShareParams round-trips every changed field', () => {
  const state = baseState({
    center: { x: -1.25, y: 0.1 },
    scale: 1.5,
    maxIter: 999,
    juliaC: { x: -0.3, y: 0.9 },
    paletteType: 2,
    progressiveMode: 1,
    smoothColoring: 1,
    gridOverlay: 1,
    centerMarker: 1,
    juliaMarker: 1,
    showMandelbrot: 0,
    showJulia: 1,
  });
  const url = share.buildShareUrl(state, initialState, 'https://example.com', '/');
  const parsed = share.parseShareParams(new URL(url).search);

  assert.deepStrictEqual(parsed, {
    center: { x: -1.25, y: 0.1 },
    scale: 1.5,
    maxIter: 999,
    juliaC: { x: -0.3, y: 0.9 },
    paletteType: 2,
    progressiveMode: 1,
    smoothColoring: 1,
    gridOverlay: 1,
    centerMarker: 1,
    juliaMarker: 1,
    showMandelbrot: 0,
    showJulia: 1,
  });
});

test('settingsData produces a plain JSON-serializable snapshot of state', () => {
  const state = baseState({ scale: 1.5, gridOverlay: 1 });
  const data = share.settingsData(state);
  assert.deepStrictEqual(data, {
    v: 2,
    center: { x: -0.5, y: 0 },
    scale: 1.5,
    maxIter: 256,
    showMandelbrot: 1,
    showJulia: 0,
    juliaC: { x: -0.8, y: 0.156 },
    paletteType: 4,
    progressiveMode: 0,
    smoothColoring: 0,
    gridOverlay: 1,
    centerMarker: 0,
    juliaMarker: 0,
  });
  assert.strictEqual(JSON.stringify(data), JSON.stringify(JSON.parse(JSON.stringify(data))));
});

test('settingsData always stamps the current schema version', () => {
  const data = share.settingsData(baseState());
  assert.strictEqual(data.v, share.SCHEMA_VERSION);
});

test('loadSettingsData treats an object without v as legacy version 1', () => {
  const legacy = { ...share.settingsData(baseState()), juliaMode: 0 };
  delete legacy.v;
  delete legacy.showMandelbrot;
  delete legacy.showJulia;
  const loaded = share.loadSettingsData(legacy);
  assert.strictEqual(loaded.showJulia, 0);
  assert.strictEqual(loaded.showMandelbrot, 1);
});

test('loadSettingsData (legacy v1) maps a truthy juliaMode to the exclusive-Julia visibility combo', () => {
  const legacy = { ...share.settingsData(baseState()), juliaMode: 1 };
  delete legacy.v;
  delete legacy.showMandelbrot;
  delete legacy.showJulia;
  const loaded = share.loadSettingsData(legacy);
  assert.strictEqual(loaded.showJulia, 1);
  assert.strictEqual(loaded.showMandelbrot, 0);
});

test('loadSettingsData rejects an unknown future version', () => {
  const future = { ...share.settingsData(baseState()), v: 3 };
  assert.strictEqual(share.loadSettingsData(future), null);
});

test('loadSettingsData rejects a future version given as a string, not treated as legacy', () => {
  const future = { ...share.settingsData(baseState()), v: "3" };
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
