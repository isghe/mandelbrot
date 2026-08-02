import { domPoint, view, grid } from './geometry.js';

// Fractal-space point -> overlay pixel point (CSS px), for a view anchored
// at `center` with the given `scale`/`aspect`. Thin wrapper around the pure
// view.fractalToPixel, so overlay drawing stays in DOMPoint terms until the
// final ctx.* calls, the only place scalars are unavoidable (Canvas 2D API).
function toPixel(fractalPoint, center, scale, aspect, w, h) {
  return view.fractalToPixel(fractalPoint, center, scale, aspect, w, h);
}

function drawGrid(ctx, w, h, center, scale, aspect) {
  const step = grid.niceGridStep(scale, 8);
  const half = new DOMPointReadOnly((scale * aspect) / 2, scale / 2);
  const min = domPoint.sub(center, half);
  const max = domPoint.add(center, half);
  const eps = step * 1e-9;

  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const x of grid.gridLines(min.x, max.x, step)) {
    if (Math.abs(x) < eps) continue;
    const p = toPixel(new DOMPointReadOnly(x, 0), center, scale, aspect, w, h);
    ctx.moveTo(p.x, 0);
    ctx.lineTo(p.x, h);
  }
  for (const y of grid.gridLines(min.y, max.y, step)) {
    if (Math.abs(y) < eps) continue;
    const p = toPixel(new DOMPointReadOnly(0, y), center, scale, aspect, w, h);
    ctx.moveTo(0, p.y);
    ctx.lineTo(w, p.y);
  }
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (min.x <= 0 && 0 <= max.x) {
    const p = toPixel(new DOMPointReadOnly(0, 0), center, scale, aspect, w, h);
    ctx.moveTo(p.x, 0);
    ctx.lineTo(p.x, h);
  }
  if (min.y <= 0 && 0 <= max.y) {
    const p = toPixel(new DOMPointReadOnly(0, 0), center, scale, aspect, w, h);
    ctx.moveTo(0, p.y);
    ctx.lineTo(w, p.y);
  }
  ctx.stroke();
}

// Position is always (w/2, h/2) since `center` is toPixel's anchor, but
// it's still routed through toPixel for symmetry with drawJuliaMarker and
// so it stays correct if that invariant ever changes.
function drawCenterMarker(ctx, w, h, center, scale, aspect) {
  const p = toPixel(center, center, scale, aspect, w, h);
  const r = 6;

  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  strokeCrosshair(ctx, p, r);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#ffffff";
  strokeCrosshair(ctx, p, r);
}

function strokeCrosshair(ctx, p, r) {
  const { x: px, y: py } = p;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.moveTo(px - r - 4, py);
  ctx.lineTo(px - r, py);
  ctx.moveTo(px + r, py);
  ctx.lineTo(px + r + 4, py);
  ctx.moveTo(px, py - r - 4);
  ctx.lineTo(px, py - r);
  ctx.moveTo(px, py + r);
  ctx.lineTo(px, py + r + 4);
  ctx.stroke();
}

// Diamond marker, distinct in shape and color from the center crosshair
// so the two are never confused when both are visible.
function drawJuliaMarker(ctx, w, h, juliaC, center, scale, aspect) {
  const p = toPixel(juliaC, center, scale, aspect, w, h);
  if (p.x < 0 || p.x > w || p.y < 0 || p.y > h) return;
  const r = 7;

  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  strokeDiamond(ctx, p, r);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#ffee33";
  strokeDiamond(ctx, p, r);
}

function strokeDiamond(ctx, p, r) {
  const { x: px, y: py } = p;
  ctx.beginPath();
  ctx.moveTo(px, py - r);
  ctx.lineTo(px + r, py);
  ctx.lineTo(px, py + r);
  ctx.lineTo(px - r, py);
  ctx.closePath();
  ctx.stroke();
}

export const overlay = { toPixel, drawGrid, drawCenterMarker, drawJuliaMarker };
