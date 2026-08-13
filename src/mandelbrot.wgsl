// WGSL rounds a uniform-address-space struct's size up to a 16-byte
// multiple, so the host buffer must be 64 B even though these 15 fields
// only span 60 B; the JS-side array appends 1 unused padding float.
struct Params {
    scale         : f32,
    centerX_hi    : f32,
    centerX_lo    : f32,
    centerY_hi    : f32,
    centerY_lo    : f32,
    juliaSeedX_hi : f32,
    juliaSeedX_lo : f32,
    juliaSeedY_hi : f32,
    juliaSeedY_lo : f32,
    maxIter       : f32,
    width         : f32,
    height        : f32,
    juliaMode     : f32,
    smoothColoring: f32,
    bandCount     : f32,
};

@group(0) @binding(0) var<uniform> params : Params;
@group(0) @binding(1) var paletteSampler : sampler;
@group(0) @binding(2) var paletteTex : texture_2d<f32>;

// Read by fs_colorize only, so it gets its own binding number rather than
// reusing 0-2: WGSL requires a unique @group/@binding per resource across
// the whole module, even though the two pipelines' layouts differ (each is
// built with layout:"auto", which derives the layout from just the bindings
// its own entry points actually reference — see renderer.js). Of the rest,
// only binding 0 is read by both: the sampler and the palette texture are
// fs_colorize's alone now that the colouring lives there, which is why the
// iterate pipeline's bind group carries the uniform and nothing else.
//
// texture_2d<u32>, not <f32>: the escape data is stored in an rg32uint
// target (see fs_main's return). A uint texel type also makes the derived
// layout's sample type unambiguously "uint" — the f32 equivalent would be
// rg32float, whose sample type is "unfilterable-float", and it is not
// settled that layout:"auto" derives that rather than plain (filterable)
// "float", which would fail validation without the float32-filterable
// feature. This side-steps the question entirely.
@group(0) @binding(3) var dataTex : texture_2d<u32>;

// Sentinel values for the R channel of the escape-data target, chosen so
// that "nothing has been rendered here yet" is *zero*: a freshly created
// WebGPU texture is zero-initialized, and a cleared band's loadOp writes
// clearValue {r:0,...} (renderer.js), so both keep meaning "black" without
// either one needing a special case. An escaped pixel stores iter+1, so it
// can never collide with 0; maxIter is capped well below the interior
// sentinel (MandelbrotApp.ITER), so that can't collide either.
const NOT_RENDERED : u32 = 0u;
const INTERIOR     : u32 = 0xFFFFFFFFu;

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

// Palette texture is 256x2: row 0 (y=0.25) is the escape-time gradient,
// row 1 (y=0.75) is a solid interior color for non-escaping points.
fn palette256(t:f32)->vec3<f32>{
    let uv=vec2<f32>(t,0.25);
    // textureSampleLevel (not textureSample) because this function is now
    // called from behind a per-pixel branch (interior vs. escaped): a plain
    // textureSample relies on implicit derivatives, which WGSL requires to
    // come from uniform control flow across the pixel quad.
    let col=textureSampleLevel(paletteTex,paletteSampler,uv,0.0);
    return col.rgb;
}

fn interiorColor()->vec3<f32>{
    let uv=vec2<f32>(0.5,0.75);
    let col=textureSampleLevel(paletteTex,paletteSampler,uv,0.0);
    return col.rgb;
}

// Banded palettes (params.bandCount > 0): the palette's N colors live in the
// first N texels of row 0 (see palette.js), indexed by exact integer
// iteration count instead of the continuous t=iter/maxIter lookup used by
// palette256 - this has no texel-resolution ceiling, unlike sampling by t,
// which collapses distinct iterations onto the same texel once bands get
// narrower than 1/256 of the [0,1] range.
fn bandColor(idx:i32)->vec3<f32>{
    let uv=vec2<f32>((f32(idx)+0.5)/256.0,0.25);
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

// The iterate pass. Produces the palette-independent escape data for one
// pixel, not its colour — fs_colorize below turns that into a colour. Keeping
// the two apart is what lets a palette change repaint the panel without
// iterating anything again: the expensive half's output survives the frame.
@fragment
fn fs_main(in:VSOut)->@location(0) vec2<u32>{
    let uv = in.fragPos*0.5 + vec2<f32>(0.5,0.5);
    let aspect = params.width / params.height;

    let center = Point(
        vec2<f32>(params.centerX_hi, params.centerX_lo),
        vec2<f32>(params.centerY_hi, params.centerY_lo)
    );
    let juliaSeed = Point(
        vec2<f32>(params.juliaSeedX_hi, params.juliaSeedX_lo),
        vec2<f32>(params.juliaSeedY_hi, params.juliaSeedY_lo)
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
        c = juliaSeed;
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
        // Interior: point did not escape within maxIter. Which colour that
        // gets is fs_colorize's business; here it is just a class of pixel.
        return vec2<u32>(INTERIOR, 0u);
    }

    // Only iter and radius2 survive the pass, and neither depends on maxIter:
    // the escape test above precedes the maxIter test, so a pixel that escapes
    // does so at the same iteration whatever the cap was. That is why no
    // per-pixel maxIter has to be stored alongside them.
    //
    // radius2 is reduced to the smooth-colouring log term right here rather
    // than stored raw, and stored *negated*, so that fs_colorize can rebuild
    //     f32(iter) + 1.0 - log2(0.5 * log2(radius2.x))
    // in its original left-to-right association as (f32(iter) + 1.0) + nuPrime.
    // Storing 1.0 - log2(...) instead would reassociate the sum and shift the
    // result by up to an ULP, which at high iteration counts is enough to move
    // a pixel onto the neighbouring palette texel.
    let nuPrime = -log2(0.5 * log2(radius2.x));
    return vec2<u32>(u32(iter) + 1u, bitcast<u32>(nuPrime));
}

// The colorize pass. Reads the escape data fs_main's bands accumulated in the
// offscreen target and maps it through the palette onto the canvas, reusing
// vs_main's full-screen triangle. textureLoad with the framebuffer coordinate,
// not a sampled uv: the offscreen is always the exact size of the canvas
// backing store, so this is a 1:1 texel lookup with no filtering, no
// half-texel offset, and no sampler needed for it.
//
// Everything below used to be the tail of fs_main. Moving it here is the whole
// point of the split: the palette texture, smoothColoring and bandCount are
// read only here now, so none of them can change what the iterate pass would
// produce, and a new look needs no iteration redone. maxIter is the exception
// — fs_main still reads it as the loop bound, so changing it is a genuine
// recompute.
//
// The host takes advantage of that: fractalPanel.js's sameComputeSignature
// treats a palette/smoothColoring/bandCount-only change as leaving the render
// target's data untouched, so it rewrites the uniform buffer and repaints
// instead of starting a new frame (see needsRecolorOnly, renderer.js's
// recolor()).
@fragment
fn fs_colorize(in:VSOut)->@location(0) vec4<f32>{
    let data = textureLoad(dataTex, vec2<i32>(in.pos.xy), 0);

    // Not yet drawn: a target region that a frame hasn't reached, or that a
    // clear/reprojection wiped. Black, matching what a zeroed colour target
    // showed before the split.
    if (data.x == NOT_RENDERED) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    if (data.x == INTERIOR) {
        return vec4<f32>(interiorColor(), 1.0);
    }

    let iter = i32(data.x - 1u);

    if (params.bandCount > 0.0) {
        // Banded palette: exact per-iteration color, bands take precedence
        // over smoothColoring (which has no meaning for a hard-edged palette).
        let idx = iter % i32(params.bandCount);
        return vec4<f32>(bandColor(idx), 1.0);
    }

    var t : f32;
    if (params.smoothColoring != 0.0) {
        // Continuous (smooth) escape-time coloring, avoids banding and
        // reduces dependence of color on maxIter. See fs_main on why the
        // parenthesisation here is the one that reproduces the pre-split sum.
        let smoothIter = (f32(iter) + 1.0) + bitcast<f32>(data.y);
        t = fract(smoothIter * 0.02);
    } else {
        t = f32(iter) / params.maxIter;
    }

    let col = palette256(t);
    return vec4<f32>(col,1.0);
}
