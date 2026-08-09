// 256-entry RGBA gradient row, interpolated from a small set of control
// colors, plus a second 256-entry row holding a solid interior color (for
// points that never escape). Returned as one 256x2 RGBA buffer so it can be
// uploaded directly as the palette texture (row 0 = gradient, row 1 = interior).
const INTERIOR_COLORS = {
  5: [255, 0, 0], // Black and White - Red: interior is red
};

// Palettes whose escape-time color hard-alternates through a fixed color
// list by iteration count (as opposed to a smooth/procedural gradient).
// Adding a future banded palette is just another entry here, no new branch
// needed. The shader indexes these colors directly by `iter % N` (see
// mandelbrot.wgsl's bandCount uniform) rather than through the continuous
// t=iter/maxIter LUT lookup used by gradient palettes, so band color is
// exact at any maxIter with no texel-resolution ceiling.
const BANDED_PALETTES = {
  5: [[0, 0, 0], [255, 255, 255]], // Black and White - Red: even iter -> black, odd -> white
};

// Number of colors a banded palette cycles through (0 for gradient palettes,
// which don't use band indexing). The one place that reads BANDED_PALETTES
// outside this module.
export function paletteBandCount(type) {
  return type in BANDED_PALETTES ? BANDED_PALETTES[type].length : 0;
}

export function makePalette(type) {
  const arr = new Uint8Array(256 * 2 * 4);

  if (type in BANDED_PALETTES) {
    // The shader indexes texel i = iter % colors.length directly (exact
    // integer arithmetic, no maxIter dependency); repeating the N colors
    // across all 256 texels keeps the texture self-describing/inspectable
    // but only the first N texels are ever actually sampled.
    const colors = BANDED_PALETTES[type];
    for (let i = 0; i < 256; i++) {
      const c = colors[i % colors.length];
      arr[i*4+0] = c[0];
      arr[i*4+1] = c[1];
      arr[i*4+2] = c[2];
      arr[i*4+3] = 255;
    }
  } else {
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

    let P;
    if (type === 4) P = APPLE2;
    else if (type === 0) P = VIRIDIS;
    else {
      P = [];
      for (let i=0;i<16;i++){
        const t=i/15;
        if (type===1) P.push([255*t,80*t,0]);          // Fire
        else if (type===2) P.push([0,100*t,255*t]);   // Ocean
        else P.push([                                   // Rainbow
          (Math.sin(6.28318*t)+1)/2*255,
          (Math.sin(6.28318*(t+0.33))+1)/2*255,
          (Math.sin(6.28318*(t+0.66))+1)/2*255
        ]);
      }
    }

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

  const interior = INTERIOR_COLORS[type] || [0, 0, 0];
  for (let i = 0; i < 256; i++) {
    const o = 256 * 4 + i * 4;
    arr[o+0] = interior[0];
    arr[o+1] = interior[1];
    arr[o+2] = interior[2];
    arr[o+3] = 255;
  }

  return arr;
}
