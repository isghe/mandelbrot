// WGSL rounds a uniform-address-space struct's size up to a 16-byte
// multiple, so the host buffer must be 64 B even though these 14 fields
// only span 56 B; the JS-side array appends 2 unused padding floats.
struct Params {
    scale         : f32,
    centerX_hi    : f32,
    centerX_lo    : f32,
    centerY_hi    : f32,
    centerY_lo    : f32,
    juliaCx_hi    : f32,
    juliaCx_lo    : f32,
    juliaCy_hi    : f32,
    juliaCy_lo    : f32,
    maxIter       : f32,
    width         : f32,
    height        : f32,
    juliaMode     : f32,
    smoothColoring: f32,
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
    // textureSampleLevel (not textureSample) because this function is now
    // called from behind a per-pixel branch (interior vs. escaped): a plain
    // textureSample relies on implicit derivatives, which WGSL requires to
    // come from uniform control flow across the pixel quad.
    let col=textureSampleLevel(paletteTex,paletteSampler,uv,0.0);
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

// A 2D point where each coordinate is a df64 (hi/lo) number.
struct Point {
    x: vec2<f32>,
    y: vec2<f32>,
};

fn point_add(a: Point, b: Point) -> Point {
    return Point(ds_add(a.x, b.x), ds_add(a.y, b.y));
}

// Analytic test for the main cardioid and period-2 bulb: points inside
// either region never escape, so the caller can skip the iteration loop
// entirely. Uses plain f32, so it's only safe to call at shallow zoom
// (see the params.scale gate at the call site).
fn is_main_interior(cx: f32, cy: f32) -> bool {
    let cy2 = cy * cy;

    let bulbX = cx + 1.0;
    if (bulbX * bulbX + cy2 <= 0.0625) {
        return true;
    }

    let cardioidX = cx - 0.25;
    let q = cardioidX * cardioidX + cy2;
    return q * (q + cardioidX) <= 0.25 * cy2;
}

@fragment
fn fs_main(in:VSOut)->@location(0) vec4<f32>{
    let uv = in.fragPos*0.5 + vec2<f32>(0.5,0.5);
    let aspect = params.width / params.height;

    let center = Point(
        vec2<f32>(params.centerX_hi, params.centerX_lo),
        vec2<f32>(params.centerY_hi, params.centerY_lo)
    );
    let juliaC = Point(
        vec2<f32>(params.juliaCx_hi, params.juliaCx_lo),
        vec2<f32>(params.juliaCy_hi, params.juliaCy_lo)
    );

    let offsetX = (uv.x - 0.5) * params.scale * aspect;
    let offsetY = (uv.y - 0.5) * params.scale;

    let offset = Point(vec2<f32>(offsetX, 0.0), vec2<f32>(offsetY, 0.0));
    let z0 = point_add(center, offset);

    var z: Point;
    var c: Point;

    if (params.juliaMode == 0.0) {
        z = Point(vec2<f32>(0.0, 0.0), vec2<f32>(0.0, 0.0));
        c = z0;
    } else {
        z = z0;
        c = juliaC;
    }

    var iter:i32 = 0;
    var escaped = false;
    var radius2 = vec2<f32>(0.0, 0.0);

    // Analytic shortcut: skip the whole iteration loop for points known to
    // lie in the main cardioid or period-2 bulb. Only valid against the
    // Mandelbrot c-plane (not Julia, where c is fixed and z0 varies), and
    // only at shallow zoom where plain f32 precision is safe.
    let skipLoop = params.juliaMode == 0.0 && params.scale > 1e-6 && is_main_interior(c.x.x, c.y.x);

    if (!skipLoop) {
        loop {
            let x2 = ds_mul(z.x, z.x);
            let y2 = ds_mul(z.y, z.y);
            radius2 = ds_add(x2, y2);

            if (radius2.x > 4.0 || (radius2.x == 4.0 && radius2.y > 0.0)) {
                escaped = true;
                break;
            }
            if (iter >= i32(params.maxIter)) { break; }

            let xt = ds_add(ds_sub(x2, y2), c.x);
            let xy = ds_mul(z.x, z.y);
            z.y = ds_add(vec2<f32>(xy.x * 2.0, xy.y * 2.0), c.y);
            z.x = xt;

            iter = iter + 1;
        }
    }

    if (!escaped) {
        // Interior: point did not escape within maxIter, dedicated color.
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    var t : f32;
    if (params.smoothColoring != 0.0) {
        // Continuous (smooth) escape-time coloring, avoids banding and
        // reduces dependence of color on maxIter.
        let smoothIter = f32(iter) + 1.0 - log2(0.5 * log2(radius2.x));
        t = fract(smoothIter * 0.02);
    } else {
        t = f32(iter) / params.maxIter;
    }

    let col = palette256(t);
    return vec4<f32>(col,1.0);
}
