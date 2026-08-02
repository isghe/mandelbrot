// 256-entry RGBA palette, interpolated from a small set of control colors.
export function makePalette(type) {
  const arr = new Uint8Array(256 * 4);

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
  return arr;
}
