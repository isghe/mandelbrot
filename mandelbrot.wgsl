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

@fragment
fn fs_main(in:VSOut)->@location(0) vec4<f32>{
    let uv = in.fragPos*0.5 + vec2<f32>(0.5,0.5);
    let aspect = params.width / params.height;

    let centerX = params.centerX_hi + params.centerX_lo;
    let centerY = params.centerY_hi + params.centerY_lo;
    let juliaCx = params.juliaCx_hi + params.juliaCx_lo;
    let juliaCy = params.juliaCy_hi + params.juliaCy_lo;

    let x0 = (uv.x - 0.5) * params.scale * aspect + centerX;
    let y0 = (uv.y - 0.5) * params.scale + centerY;

    var x:f32;
    var y:f32;
    var cx:f32;
    var cy:f32;

    if (params.juliaMode == 0.0) {
        x = 0.0;
        y = 0.0;
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
        if (x*x + y*y > 4.0 || iter >= i32(params.maxIter)) { break; }

        let xt = x*x - y*y + cx;
        y = 2.0*x*y + cy;
        x = xt;

        iter = iter + 1;
    }

    let t = f32(iter) / params.maxIter;

    let col = palette256(t);
    return vec4<f32>(col,1.0);
}
