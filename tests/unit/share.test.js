import { test } from 'node:test';
import assert from 'node:assert/strict';
import { share } from '../../share.js';

const initialState = {
  center: { x: -0.5, y: 0 },
  scale: 3.0,
  maxIter: 256,
  juliaMode: 0,
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

test('parseShareParams maps scalar params to their field names', () => {
  const s = share.parseShareParams('?iter=999&julia=1&palette=2&progressive=1&smooth=1&grid=1&centerMark=1&juliaMark=1&scale=1.5');
  assert.deepStrictEqual(s, {
    maxIter: 999,
    juliaMode: 1,
    paletteType: 2,
    progressiveMode: 1,
    smoothColoring: 1,
    gridOverlay: 1,
    centerMarker: 1,
    juliaMarker: 1,
    scale: 1.5,
  });
});

test('parseShareParams treats a present-but-empty param as absent, not zero', () => {
  const s = share.parseShareParams('?iter=');
  assert.strictEqual(s, null);
});

test('parseShareParams skips non-finite values', () => {
  const s = share.parseShareParams('?iter=notanumber');
  assert.strictEqual(s, null);
});

test('settingsData produces a plain JSON-serializable snapshot of state', () => {
  const state = baseState({ scale: 1.5, gridOverlay: 1 });
  const data = share.settingsData(state);
  assert.deepStrictEqual(data, {
    center: { x: -0.5, y: 0 },
    scale: 1.5,
    maxIter: 256,
    juliaMode: 0,
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
