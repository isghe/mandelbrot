// WGSL rounds a uniform-address-space struct's size up to a 16-byte
// multiple, so the host buffer must be 64 B even though these 13 fields
// only span 52 B; the JS-side array appends 3 unused padding floats.
struct Params {
    scale        : f32,
    centerX_hi   : f32,
    centerX_lo   : f32,
    centerY_hi   : f32,
    centerY_lo   : f32,
    juliaCx_hi   : f32,
    juliaCx_lo   : f32,
    juliaCy_hi   : f32,
    juliaCy_lo   : f32,
    maxIter      : f32,
    width        : f32,
    height       : f32,
    juliaMode    : f32,
};

@group(0) @binding(0) var<uniform> params : Params;
@group(0) @binding(1) var paletteSampler : sampler;
@group(0) @binding(2) var paletteTex : texture_2d<f32>;

struct VSOut {
    @builtin(position) pos : vec4<f32>,
    @location(0) fragPos : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid:u32) -> VSOut {
    var pos = array<vec2<f32>,3>(
        vec2<f32>(-1.0,-1.0),
        vec2<f32>( 3.0,-1.0),
        vec2<f32>(-1.0, 3.0)
    );
    var out:VSOut;
    out.pos = vec4<f32>(pos[vid],0.0,1.0);
    out.fragPos = pos[vid];
    return out;
}

fn palette256(t:f32)->vec3<f32>{
    let uv=vec2<f32>(t,0.5);
    let col=textureSample(paletteTex,paletteSampler,uv);
    return col.rgb;
}

// ---- Double-single (df64) arithmetic: a DS number is vec2<f32>(hi, lo) ----

fn two_sum(a:f32, b:f32) -> vec2<f32> {
    let s = a + b;
    let v = s - a;
    let e = (a - (s - v)) + (b - v);
    return vec2<f32>(s, e);
}

fn quick_two_sum(a:f32, b:f32) -> vec2<f32> {
    let s = a + b;
    let e = b - (s - a);
    return vec2<f32>(s, e);
}

fn ds_split(a:f32) -> vec2<f32> {
    let SPLIT:f32 = 4097.0; // 2^12 + 1, correct splitter for f32's 24-bit mantissa
    let t = SPLIT * a;
    let hi = t - (t - a);
    let lo = a - hi;
    return vec2<f32>(hi, lo);
}

fn two_prod(a:f32, b:f32) -> vec2<f32> {
    let p = a * b;
    let as_ = ds_split(a);
    let bs = ds_split(b);
    let err = ((as_.x*bs.x - p) + as_.x*bs.y + as_.y*bs.x) + as_.y*bs.y;
    return vec2<f32>(p, err);
}

fn ds_add(a:vec2<f32>, b:vec2<f32>) -> vec2<f32> {
    var s = two_sum(a.x, b.x);
    let t = two_sum(a.y, b.y);
    s.y = s.y + t.x;
    s = quick_two_sum(s.x, s.y);
    s.y = s.y + t.y;
    s = quick_two_sum(s.x, s.y);
    return s;
}

fn ds_sub(a:vec2<f32>, b:vec2<f32>) -> vec2<f32> {
    return ds_add(a, vec2<f32>(-b.x, -b.y));
}

fn ds_mul(a:vec2<f32>, b:vec2<f32>) -> vec2<f32> {
    let p = two_prod(a.x, b.x);
    let e = a.x*b.y + a.y*b.x + p.y;
    return quick_two_sum(p.x, e);
}

@fragment
fn fs_main(in:VSOut)->@location(0) vec4<f32>{
    let uv = in.fragPos*0.5 + vec2<f32>(0.5,0.5);
    let aspect = params.width / params.height;

    let centerX = vec2<f32>(params.centerX_hi, params.centerX_lo);
    let centerY = vec2<f32>(params.centerY_hi, params.centerY_lo);
    let juliaCx = vec2<f32>(params.juliaCx_hi, params.juliaCx_lo);
    let juliaCy = vec2<f32>(params.juliaCy_hi, params.juliaCy_lo);

    let offsetX = (uv.x - 0.5) * params.scale * aspect;
    let offsetY = (uv.y - 0.5) * params.scale;

    let x0 = ds_add(centerX, vec2<f32>(offsetX, 0.0));
    let y0 = ds_add(centerY, vec2<f32>(offsetY, 0.0));

    var x:vec2<f32>;
    var y:vec2<f32>;
    var cx:vec2<f32>;
    var cy:vec2<f32>;

    if (params.juliaMode == 0.0) {
        x = vec2<f32>(0.0, 0.0);
        y = vec2<f32>(0.0, 0.0);
        cx = x0;
        cy = y0;
    } else {
        x = x0;
        y = y0;
        cx = juliaCx;
        cy = juliaCy;
    }

    var iter:i32 = 0;

    loop {
        let x2 = ds_mul(x, x);
        let y2 = ds_mul(y, y);

        // Escape test only needs the hi component: it's a coarse boundary
        // check, and full double-single precision here wouldn't change the
        // outcome for any pixel that matters.
        if (x2.x + y2.x > 4.0 || iter >= i32(params.maxIter)) { break; }

        let xt = ds_add(ds_sub(x2, y2), cx);
        let xy = ds_mul(x, y);
        y = ds_add(vec2<f32>(xy.x * 2.0, xy.y * 2.0), cy);
        x = xt;

        iter = iter + 1;
    }

    let t = f32(iter) / params.maxIter;

    let col = palette256(t);
    return vec4<f32>(col,1.0);
}
