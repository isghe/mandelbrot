// Double-single split: f64 -> hi+lo f32 pair, for extended-precision
// arithmetic in the shader (see mandelbrot.wgsl's Point/point_add).
export function split64(x) {
  const hi = Math.fround(x);
  const lo = x - hi;
  return [hi, lo];
}
