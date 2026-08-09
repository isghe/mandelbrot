import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePalette, paletteBandCount } from '../../src/palette.js';

const TYPES = [0, 1, 2, 3, 4, 5];

test('makePalette returns a 256x2-entry RGBA buffer', () => {
  const palette = makePalette(4);
  assert.ok(palette instanceof Uint8Array);
  assert.strictEqual(palette.length, 256 * 2 * 4);
});

test('makePalette alpha is always fully opaque', () => {
  for (const type of TYPES) {
    const palette = makePalette(type);
    for (let i = 0; i < 512; i++) {
      assert.strictEqual(palette[i * 4 + 3], 255, `type ${type} entry ${i} alpha`);
    }
  }
});

test('makePalette(4) starts at black and ends at Apple2\'s last control color', () => {
  const palette = makePalette(4);
  assert.deepStrictEqual([...palette.slice(0, 3)], [0, 0, 0]);
  assert.deepStrictEqual([...palette.slice(255 * 4, 255 * 4 + 3)], [128, 0, 0]);
});

test('makePalette(0) starts and ends at Viridis\'s control colors', () => {
  const palette = makePalette(0);
  assert.deepStrictEqual([...palette.slice(0, 3)], [68, 1, 84]);
  assert.deepStrictEqual([...palette.slice(255 * 4, 255 * 4 + 3)], [253, 231, 37]);
});

test('makePalette produces a different gradient row per type', () => {
  const palettes = TYPES.map((type) => makePalette(type));
  for (let i = 0; i < palettes.length; i++) {
    for (let j = i + 1; j < palettes.length; j++) {
      assert.notDeepStrictEqual(
        [...palettes[i].slice(0, 256 * 4)],
        [...palettes[j].slice(0, 256 * 4)],
        `type ${TYPES[i]} vs ${TYPES[j]}`
      );
    }
  }
});

test('interior row (row 1) is solid black for existing gradient palettes', () => {
  for (const type of [0, 1, 2, 3, 4]) {
    const palette = makePalette(type);
    for (let i = 0; i < 256; i++) {
      const o = 256 * 4 + i * 4;
      assert.deepStrictEqual([...palette.slice(o, o + 3)], [0, 0, 0], `type ${type} interior entry ${i}`);
    }
  }
});

test('makePalette(5) gradient row is hard black/white bands, no intermediate colors', () => {
  const palette = makePalette(5);
  const seen = new Set();
  for (let i = 0; i < 256; i++) {
    const r = palette[i * 4 + 0], g = palette[i * 4 + 1], b = palette[i * 4 + 2];
    seen.add(`${r},${g},${b}`);
  }
  assert.deepStrictEqual([...seen].sort(), ['0,0,0', '255,255,255'].sort());
});

test('makePalette(5) interior row is solid red', () => {
  const palette = makePalette(5);
  for (let i = 0; i < 256; i++) {
    const o = 256 * 4 + i * 4;
    assert.deepStrictEqual([...palette.slice(o, o + 3)], [255, 0, 0], `interior entry ${i}`);
  }
});

// The shader indexes banded palettes by exact integer `iter % bandCount`
// (see mandelbrot.wgsl), sampling texel `idx` directly - so the first N
// texels of row 0 must be exactly the N registered colors, in order.
test('makePalette(5) first 2 texels are exactly black then white (the registered band colors)', () => {
  const palette = makePalette(5);
  assert.deepStrictEqual([...palette.slice(0, 3)], [0, 0, 0], 'texel 0 (even iter)');
  assert.deepStrictEqual([...palette.slice(4, 7)], [255, 255, 255], 'texel 1 (odd iter)');
});

test('paletteBandCount returns the color count for banded palettes, 0 for gradient palettes', () => {
  assert.strictEqual(paletteBandCount(5), 2, 'Black and White - Red');
  for (const type of [0, 1, 2, 3, 4]) {
    assert.strictEqual(paletteBandCount(type), 0, `gradient type ${type}`);
  }
});
