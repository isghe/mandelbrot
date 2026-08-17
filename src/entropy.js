// Shannon entropy over a panel's escape-data samples (dataTex, see
// fs_main/fs_colorize in mandelbrot.wgsl), not over rendered colour. A
// palette change never moves this number for the same view: only
// maxIter/viewport/sampling do.
//
// Sentinel values below must match mandelbrot.wgsl's NOT_RENDERED/INTERIOR
// constants exactly — they are the same escape-data encoding, just read back
// into JS instead of consumed by fs_colorize.
export const NOT_RENDERED = 0;
export const INTERIOR = 0xffffffff;

// Bins are fixed-width in log2(smoothIter), not linear in iteration count, so
// that H stays comparable across views with different maxIter (ITER.max is
// 8192, log2(8193) < 13; 24 leaves headroom without the bin count blowing
// up). One extra bin holds every INTERIOR sample.
const LOG_MAX = 24;
const BIN_WIDTH = 1 / 8;
const LOG_BIN_COUNT = LOG_MAX / BIN_WIDTH;
export const BIN_COUNT = LOG_BIN_COUNT + 1;

const bitsScratch = new ArrayBuffer(4);
const bitsAsU32 = new Uint32Array(bitsScratch);
const bitsAsF32 = new Float32Array(bitsScratch);

function bitsToFloat32(bits) {
  bitsAsU32[0] = bits;
  return bitsAsF32[0];
}

function logBinIndex(smoothIter) {
  const log = Math.log2(smoothIter);
  const clamped = Number.isFinite(log) ? Math.min(Math.max(log, 0), LOG_MAX - Number.EPSILON) : 0;
  return Math.floor(clamped / BIN_WIDTH);
}

// samples: flat Uint32Array of interleaved (x, y) texel pairs, the same
// layout a mapped rg32uint staging buffer reads back as. x is
// NOT_RENDERED/INTERIOR/(iter+1); y is nuPrime's bit pattern, meaningful only
// when x encodes an escaped pixel.
export function computeEscapeEntropy(samples) {
  const histogram = new Float64Array(BIN_COUNT);
  const total = samples.length / 2;
  let rendered = 0;
  let interior = 0;

  for (let i = 0; i < samples.length; i += 2) {
    const x = samples[i];
    if (x === NOT_RENDERED) continue;
    rendered++;

    if (x === INTERIOR) {
      interior++;
      histogram[LOG_BIN_COUNT]++;
      continue;
    }

    const nuPrime = bitsToFloat32(samples[i + 1]);
    const smoothIter = x + nuPrime;
    histogram[logBinIndex(smoothIter)]++;
  }

  let entropy = 0;
  for (const count of histogram) {
    if (count === 0) continue;
    const p = count / rendered;
    entropy -= p * Math.log2(p);
  }

  return {
    entropy: rendered === 0 ? 0 : entropy,
    entropyNormalized: rendered === 0 ? 0 : entropy / Math.log2(BIN_COUNT),
    coverage: total === 0 ? 0 : rendered / total,
    interiorFraction: rendered === 0 ? 0 : interior / rendered,
  };
}
