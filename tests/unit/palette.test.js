import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePalette } from '../../src/palette.js';

test('makePalette returns a 256-entry RGBA buffer', () => {
  const palette = makePalette(4);
  assert.ok(palette instanceof Uint8Array);
  assert.strictEqual(palette.length, 256 * 4);
});

test('makePalette alpha is always fully opaque', () => {
  for (const type of [0, 1, 2, 3, 4]) {
    const palette = makePalette(type);
    for (let i = 0; i < 256; i++) {
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

test('makePalette produces a different buffer per type', () => {
  const palettes = [0, 1, 2, 3, 4].map(makePalette);
  for (let i = 0; i < palettes.length; i++) {
    for (let j = i + 1; j < palettes.length; j++) {
      assert.notDeepStrictEqual([...palettes[i]], [...palettes[j]], `type ${i} vs ${j}`);
    }
  }
});
