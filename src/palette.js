// 256-entry RGBA gradient row, interpolated from a small set of control
// colors, plus a second 256-entry row holding a solid interior color (for
// points that never escape). Returned as one 256x2 RGBA buffer so it can be
// uploaded directly as the palette texture (row 0 = gradient, row 1 = interior).

function ramp16(fn) {
  const P = [];
  for (let i = 0; i < 16; i++) P.push(fn(i / 15));
  return P;
}

const APPLE2 = [
  [0,0,0],[255,255,255],[255,0,0],[0,255,0],
  [0,0,255],[255,255,0],[255,0,255],[0,255,255],
  [128,128,128],[255,128,0],[128,0,255],[0,128,255],
  [128,255,0],[255,0,128],[0,255,128],[128,0,0]
];

const VIRIDIS = [
  [68,1,84],[71,44,122],[59,81,139],[44,113,142],
  [33,144,141],[39,173,129],[92,200,99],[170,220,50],
  [253,231,37]
];

const FIRE = ramp16((t) => [255 * t, 80 * t, 0]);
const OCEAN = ramp16((t) => [0, 100 * t, 255 * t]);
const RAINBOW = ramp16((t) => [
  (Math.sin(6.28318 * t) + 1) / 2 * 255,
  (Math.sin(6.28318 * (t + 0.33)) + 1) / 2 * 255,
  (Math.sin(6.28318 * (t + 0.66)) + 1) / 2 * 255
]);

// Single source of truth for every palette: id, display label (consumed by
// the runtime-built <select> menus in mandelbrot.js), its control colors,
// and (for banded palettes) a dedicated interior color. Grouping mirrors the
// menu's <optgroup>s; `banded` lives on the group because it's a property of
// the group, not of each individual palette. Adding a palette is one entry
// here, nowhere else.
export const PALETTE_GROUPS = [
  { label: "Gradient", banded: false, palettes: [
    { id: 0, label: "Viridis",  colors: VIRIDIS },
    { id: 1, label: "Fire",     colors: FIRE },
    { id: 2, label: "Ocean",    colors: OCEAN },
    { id: 3, label: "Rainbow",  colors: RAINBOW },
    { id: 4, label: "Apple II", colors: APPLE2 },
  ]},
  // Banded palettes hard-alternate through their color list by iteration
  // count (as opposed to a smooth/procedural gradient). The shader indexes
  // these colors directly by `iter % N` (see mandelbrot.wgsl's bandCount
  // uniform) rather than through the continuous t=iter/maxIter LUT lookup
  // used by gradient palettes, so band color is exact at any maxIter with
  // no texel-resolution ceiling.
  { label: "Banded", banded: true, palettes: [
    { id: 5, label: "Black and White - Red", colors: [[0,0,0],[255,255,255]], interior: [255,0,0] },
    { id: 6, label: "Apple II - Banded",     colors: APPLE2 },
  ]},
];

const BY_ID = new Map(
  PALETTE_GROUPS.flatMap((group) =>
    group.palettes.map((p) => [p.id, { ...p, banded: group.banded }])
  )
);

// share URLs and localStorage can carry an arbitrary numeric palette id
// (e.g. a hand-edited or stale ?mpalette=99); fall back to Rainbow rather
// than throwing.
function lookup(type) {
  return BY_ID.get(type) ?? BY_ID.get(3);
}

// Number of colors a banded palette cycles through (0 for gradient palettes,
// which don't use band indexing).
export function paletteBandCount(type) {
  const entry = lookup(type);
  return entry.banded ? entry.colors.length : 0;
}

export function makePalette(type) {
  const arr = new Uint8Array(256 * 2 * 4);
  const entry = lookup(type);
  const P = entry.colors;

  if (entry.banded) {
    // The shader indexes texel i = iter % colors.length directly (exact
    // integer arithmetic, no maxIter dependency); repeating the N colors
    // across all 256 texels keeps the texture self-describing/inspectable
    // but only the first N texels are ever actually sampled.
    for (let i = 0; i < 256; i++) {
      const c = P[i % P.length];
      arr[i*4+0] = c[0];
      arr[i*4+1] = c[1];
      arr[i*4+2] = c[2];
      arr[i*4+3] = 255;
    }
  } else {
    for (let i=0;i<256;i++){
      const t=i/255;
      const p=t*(P.length-1);
      const idx=Math.floor(p);
      const f=p-idx;
      const idx2=Math.min(idx+1,P.length-1);

      const r=P[idx][0]*(1-f)+P[idx2][0]*f;
      const g=P[idx][1]*(1-f)+P[idx2][1]*f;
      const b=P[idx][2]*(1-f)+P[idx2][2]*f;

      arr[i*4+0]=r;
      arr[i*4+1]=g;
      arr[i*4+2]=b;
      arr[i*4+3]=255;
    }
  }

  const interior = entry.interior || [0, 0, 0];
  for (let i = 0; i < 256; i++) {
    const o = 256 * 4 + i * 4;
    arr[o+0] = interior[0];
    arr[o+1] = interior[1];
    arr[o+2] = interior[2];
    arr[o+3] = 255;
  }

  return arr;
}
