import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  requestGPUDevice, attachCanvas, frameBands, BAND_WORK_BUDGET, shareBands,
  nextBandBudget, MAX_FRAME_BAND_BUDGET, TARGET_FRAME_MS, exposedRegions,
} from '../../src/renderer.js';

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

// frameBands is pure (no WebGPU dependency), so it gets real coverage here —
// see renderer.js's BAND_WORK_BUDGET comment for why bands exist at all.

function assertExactCoverage(bands, region) {
  let y = region.y;
  for (const band of bands) {
    assert.strictEqual(band.x, region.x);
    assert.strictEqual(band.width, region.width);
    assert.strictEqual(band.y, y);
    assert.ok(band.height > 0);
    y += band.height;
  }
  assert.strictEqual(y, region.y + region.height);
}

test('frameBands: cheap frame (work under budget) returns a single band', () => {
  // maxIter derived from the budget rather than hardcoded: this assertion is
  // about "a frame comfortably under the budget isn't split", not about any
  // particular value of BAND_WORK_BUDGET, which is tuned against real
  // hardware and expected to move.
  const width = 400, height = 300;
  const maxIter = Math.floor(BAND_WORK_BUDGET / (width * height * 4));
  assert.ok(maxIter >= 1, 'budget must leave room for a cheap frame at all');
  const region = { x: 0, y: 0, width, height };
  assert.deepStrictEqual(frameBands([region], maxIter), [region]);
});

test('frameBands: expensive frame (high maxIter) splits into multiple bands', () => {
  const region = { x: 0, y: 0, width: 972, height: 972 };
  const maxIter = 8192;
  const bands = frameBands([region], maxIter);
  assert.ok(bands.length > 1);
  assertExactCoverage(bands, region);
  for (const band of bands.slice(0, -1)) {
    assert.ok(band.width * band.height * maxIter <= BAND_WORK_BUDGET);
  }
});

test('frameBands: bands are contiguous with no gaps or overlap, covering exactly the region', () => {
  const region = { x: 0, y: 0, width: 1920, height: 1000 };
  assertExactCoverage(frameBands([region], 4677), region);
});

test('frameBands: never returns 0 rows and never more rows than the region height', () => {
  // Single row would already exceed the budget many times over — clamp to 1.
  const bands = frameBands([{ x: 0, y: 0, width: 10000, height: 5 }], 8192, 1);
  assert.strictEqual(bands.length, 5);
  for (const band of bands) assert.strictEqual(band.height, 1);
});

test('frameBands: a custom budget larger than the whole region yields a single band', () => {
  const region = { x: 0, y: 0, width: 1920, height: 1080 };
  const bands = frameBands([region], 8192, Number.MAX_SAFE_INTEGER);
  assert.deepStrictEqual(bands, [region]);
});

test('frameBands: multiple regions are banded independently and concatenated in order', () => {
  const maxIter = 8192;
  const regionA = { x: 0, y: 0, width: 972, height: 972 };
  const regionB = { x: 972, y: 100, width: 50, height: 400 };
  const bands = frameBands([regionA, regionB], maxIter);
  const bandsA = bands.filter((b) => b.x === regionA.x);
  const bandsB = bands.filter((b) => b.x === regionB.x);
  assertExactCoverage(bandsA, regionA);
  assertExactCoverage(bandsB, regionB);
  assert.deepStrictEqual(bands, [...bandsA, ...bandsB]);
});

test('frameBands: a narrow tall strip (horizontal-pan exposure) never yields a zero-row band', () => {
  const region = { x: 1200, y: 0, width: 5, height: 720 };
  const bands = frameBands([region], 8192);
  assert.ok(bands.length > 0);
  for (const band of bands) assert.ok(band.height > 0);
  assertExactCoverage(bands, region);
});

test('frameBands: degenerate/non-finite inputs fall back to a single band, no infinite loop', () => {
  assert.deepStrictEqual(
    frameBands([{ x: 0, y: 0, width: 0, height: 720 }], 256),
    [{ x: 0, y: 0, width: 1, height: 720 }]
  );
  assert.deepStrictEqual(
    frameBands([{ x: 0, y: 0, width: 1280, height: 720 }], 0),
    [{ x: 0, y: 0, width: 1280, height: 720 }]
  );
  assert.deepStrictEqual(
    frameBands([{ x: 0, y: 0, width: NaN, height: 720 }], 256),
    [{ x: 0, y: 0, width: 1, height: 720 }]
  );
  assert.deepStrictEqual(
    frameBands([{ x: 0, y: 0, width: 1280, height: 720 }], NaN),
    [{ x: 0, y: 0, width: 1280, height: 720 }]
  );
  assert.deepStrictEqual(
    frameBands([{ x: 0, y: 0, width: 1280, height: 0 }], 256),
    [{ x: 0, y: 0, width: 1280, height: 1 }]
  );
  assert.deepStrictEqual(
    frameBands([{ x: 0, y: 0, width: 1280, height: NaN }], 256),
    [{ x: 0, y: 0, width: 1280, height: 1 }]
  );
  assert.deepStrictEqual(frameBands([], 256), [{ x: 0, y: 0, width: 1, height: 1 }]);
});

// shareBands splits one animation frame's band budget across the panels that
// still have bands pending — the mechanism that stops one expensive panel
// from monopolising a frame while the other waits.

test('shareBands: a budget covering everything pending serves every panel in full', () => {
  assert.deepStrictEqual(shareBands([2, 3], 5), [2, 3]);
  assert.deepStrictEqual(shareBands([2, 3], 99), [2, 3]);
});

test('shareBands: a scarce budget is dealt round-robin, not first-come-first-served', () => {
  // The whole point: 1 band each, rather than 2 to the first panel and none
  // to the second.
  assert.deepStrictEqual(shareBands([40, 40], 2), [1, 1]);
  assert.deepStrictEqual(shareBands([40, 40], 5), [3, 2]);
});

test('shareBands: a panel that runs out mid-deal hands its remainder to the others', () => {
  assert.deepStrictEqual(shareBands([1, 40], 5), [1, 4]);
  assert.deepStrictEqual(shareBands([1, 1, 40], 6), [1, 1, 4]);
});

test('shareBands: an idle panel gets nothing, and never blocks the busy one', () => {
  assert.deepStrictEqual(shareBands([0, 7], 4), [0, 4]);
  assert.deepStrictEqual(shareBands([0, 0], 4), [0, 0]);
});

test('shareBands: never hands out more than the budget, or more than a panel has pending', () => {
  for (const pending of [[3, 5], [9, 1], [4, 4], [0, 6]]) {
    for (const budget of [0, 1, 2, 4, 7, 20]) {
      const share = shareBands(pending, budget);
      assert.ok(share.reduce((a, b) => a + b, 0) <= budget, `sum <= budget for ${pending}/${budget}`);
      share.forEach((n, i) => assert.ok(n <= pending[i], `panel ${i} within pending for ${pending}/${budget}`));
    }
  }
});

test('shareBands: degenerate inputs yield no work rather than throwing or looping', () => {
  assert.deepStrictEqual(shareBands([], 4), []);
  assert.deepStrictEqual(shareBands([3, 3], 0), [0, 0]);
  assert.deepStrictEqual(shareBands([3, 3], -1), [0, 0]);
  assert.deepStrictEqual(shareBands([3, 3], NaN), [0, 0]);
  assert.deepStrictEqual(shareBands([NaN, -2, 3], 4), [0, 0, 3]);
});

// The case the rotation exists for: a budget too small to give every busy
// panel a band. Dealing from index 0 every time would hand every band to the
// first panel until its frame finished, and only then start the second — the
// exact monopoly the shared budget removes, one frame at a time.

test('shareBands: with a budget of one and two busy panels, consecutive frames alternate', () => {
  const pending = [40, 40];
  assert.deepStrictEqual(shareBands(pending, 1, 0), [1, 0]);
  assert.deepStrictEqual(shareBands(pending, 1, 1), [0, 1]);
  assert.deepStrictEqual(shareBands(pending, 1, 2), [1, 0]);
  assert.deepStrictEqual(shareBands(pending, 1, 3), [0, 1]);
});

test('shareBands: over many frames at budget 1, two busy panels get served equally', () => {
  const pending = [40, 40];
  const total = [0, 0];
  for (let frame = 0; frame < 20; frame++) {
    shareBands(pending, 1, frame).forEach((n, i) => { total[i] += n; });
  }
  assert.deepStrictEqual(total, [10, 10]);
});

test('shareBands: rotation changes who goes first, not how much is dealt', () => {
  // A budget that covers everything pending is unaffected by where it starts.
  assert.deepStrictEqual(shareBands([2, 3], 5, 1), [2, 3]);
  // An odd budget hands the extra band to whoever the frame starts from.
  assert.deepStrictEqual(shareBands([9, 9], 3, 0), [2, 1]);
  assert.deepStrictEqual(shareBands([9, 9], 3, 1), [1, 2]);
});

test('shareBands: firstServed wraps and tolerates out-of-range or missing values', () => {
  assert.deepStrictEqual(shareBands([5, 5], 1, 7), [0, 1]);  // 7 % 2
  assert.deepStrictEqual(shareBands([5, 5], 1, -1), [0, 1]); // negative wraps forward
  assert.deepStrictEqual(shareBands([5, 5], 1, NaN), [1, 0]);
  assert.deepStrictEqual(shareBands([5, 5], 1), [1, 0]);     // defaults to panel 0
});

// nextBandBudget: additive growth while frames come in under target,
// multiplicative back-off when they run over.

test('nextBandBudget: a frame under target earns one more band', () => {
  assert.strictEqual(nextBandBudget(4, TARGET_FRAME_MS - 8), 5);
  assert.strictEqual(nextBandBudget(1, 1), 2);
});

test('nextBandBudget: a frame over target halves the budget', () => {
  assert.strictEqual(nextBandBudget(8, TARGET_FRAME_MS + 1), 4);
  assert.strictEqual(nextBandBudget(9, 1000), 4);
});

test('nextBandBudget: a frame exactly on target is not treated as over', () => {
  assert.strictEqual(nextBandBudget(4, TARGET_FRAME_MS), 5);
});

test('nextBandBudget: never drops below a single band', () => {
  assert.strictEqual(nextBandBudget(1, 5000), 1);
  assert.strictEqual(nextBandBudget(2, 5000), 1);
});

test('nextBandBudget: growth stops at the ceiling', () => {
  assert.strictEqual(nextBandBudget(MAX_FRAME_BAND_BUDGET, 1), MAX_FRAME_BAND_BUDGET);
  assert.strictEqual(nextBandBudget(MAX_FRAME_BAND_BUDGET + 100, 1), MAX_FRAME_BAND_BUDGET);
});

test('nextBandBudget: back-off from the ceiling reaches a single band in six frames', () => {
  // Why the ceiling is where it is: a budget that had drifted far higher
  // would keep spending a backlog for many frames after work turned
  // expensive, which is when responsiveness matters most.
  let budget = MAX_FRAME_BAND_BUDGET;
  let frames = 0;
  while (budget > 1) {
    budget = nextBandBudget(budget, TARGET_FRAME_MS + 100);
    frames++;
  }
  assert.strictEqual(frames, 6);
});

test('nextBandBudget: a missing or nonsensical measurement leaves the budget alone', () => {
  assert.strictEqual(nextBandBudget(5, NaN), 5);
  assert.strictEqual(nextBandBudget(5, 0), 5);
  assert.strictEqual(nextBandBudget(5, -3), 5);
  assert.strictEqual(nextBandBudget(5, Infinity), 5);
});

test('nextBandBudget: a nonsensical current budget falls back to a single band', () => {
  assert.strictEqual(nextBandBudget(NaN, 1), 2);
  assert.strictEqual(nextBandBudget(0, 1), 2);
  assert.strictEqual(nextBandBudget(-5, 5000), 1);
});

// exposedRegions is the other half of the pan reprojection (see
// fractalPanel.js's panShiftBetween for the half that decides the shift): it
// says which pixels the copied-across image doesn't cover and therefore still
// have to be computed.

const W = 1280;
const H = 720;

// The two properties that make the region list correct whatever its shape:
// together the rectangles cover exactly the pixels the shifted image misses,
// and they never cover the same pixel twice (which would compute it twice and
// make the band budget lie about the frame's cost).
function assertExposesExactly(regions, shift) {
  const covered = new Set();
  for (const region of regions) {
    for (let y = region.y; y < region.y + region.height; y++) {
      for (let x = region.x; x < region.x + region.width; x++) {
        assert.ok(x >= 0 && x < W && y >= 0 && y < H, `region pixel ${x},${y} is off-canvas`);
        const key = y * W + x;
        assert.ok(!covered.has(key), `regions overlap at ${x},${y}`);
        covered.add(key);
      }
    }
  }
  // Every pixel not covered by the old image slid over by `shift`.
  let expected = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sourceX = x - shift.x;
      const sourceY = y - shift.y;
      const reused = sourceX >= 0 && sourceX < W && sourceY >= 0 && sourceY < H;
      if (reused) continue;
      expected++;
      assert.ok(covered.has(y * W + x), `pixel ${x},${y} is neither reused nor exposed`);
    }
  }
  assert.strictEqual(covered.size, expected);
  // The same count stated the other way round, as the area arithmetic the
  // whole optimisation is justified by.
  assert.strictEqual(
    expected,
    W * H - (W - Math.abs(shift.x)) * (H - Math.abs(shift.y))
  );
}

for (const shift of [{ x: 120, y: 64 }, { x: -120, y: 64 }, { x: 120, y: -64 }, { x: -120, y: -64 }]) {
  test(`exposedRegions: an L-shape that tiles exactly what a (${shift.x}, ${shift.y}) pan uncovers`, () => {
    const regions = exposedRegions(W, H, shift);
    assert.strictEqual(regions.length, 2);
    assertExposesExactly(regions, shift);
  });
}

test('exposedRegions: a purely horizontal pan uncovers one full-height strip', () => {
  const regions = exposedRegions(W, H, { x: 120, y: 0 });
  assert.deepStrictEqual(regions, [{ x: 0, y: 0, width: 120, height: H }]);
  assertExposesExactly(regions, { x: 120, y: 0 });
});

test('exposedRegions: a purely vertical pan uncovers one full-width strip', () => {
  const regions = exposedRegions(W, H, { x: 0, y: -64 });
  assert.deepStrictEqual(regions, [{ x: 0, y: H - 64, width: W, height: 64 }]);
  assertExposesExactly(regions, { x: 0, y: -64 });
});

test('exposedRegions: no overlap left to reuse means no regions at all', () => {
  // The caller renders the whole panel in this case, so returning the whole
  // panel here would be a second, competing answer to the same question.
  assert.deepStrictEqual(exposedRegions(W, H, { x: W, y: 0 }), []);
  assert.deepStrictEqual(exposedRegions(W, H, { x: 0, y: -H }), []);
  assert.deepStrictEqual(exposedRegions(W, H, { x: 0, y: 0 }), []);
});

test('exposedRegions: a degenerate canvas or a nonsensical shift yields no regions', () => {
  assert.deepStrictEqual(exposedRegions(0, H, { x: 10, y: 0 }), []);
  assert.deepStrictEqual(exposedRegions(W, 0, { x: 10, y: 0 }), []);
  assert.deepStrictEqual(exposedRegions(W, H, { x: NaN, y: NaN }), []);
  assert.deepStrictEqual(exposedRegions(W, H, null), []);
});

test('exposedRegions: a narrow strip still bands into whole rows, never zero-height ones', () => {
  // The pan case frameBands didn't used to be able to express: tall and
  // narrow, rather than the full-width slabs a whole-canvas frame produces.
  const strip = exposedRegions(W, H, { x: 12, y: 0 })[0];
  const bands = frameBands([strip], 8192);
  assert.ok(bands.length > 1, 'an expensive strip should still be split');
  let y = strip.y;
  for (const band of bands) {
    assert.strictEqual(band.x, strip.x);
    assert.strictEqual(band.width, strip.width);
    assert.strictEqual(band.y, y);
    assert.ok(band.height > 0);
    y += band.height;
  }
  assert.strictEqual(y, strip.y + strip.height);
});
