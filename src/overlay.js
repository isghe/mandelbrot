import { domPoint, view, grid } from './geometry.js';
import { MANDELBROT_LANDMARKS } from './landmarks.js';

function drawGrid(ctx, w, h, center, scale, aspect) {
  const step = grid.niceGridStep(scale, 8);
  const half = new DOMPointReadOnly((scale * aspect) / 2, scale / 2);
  const min = domPoint.sub(center, half);
  const max = domPoint.add(center, half);
  const eps = step * 1e-9;

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const x of grid.gridLines(min.x, max.x, step)) {
    if (Math.abs(x) < eps) continue;
    const p = view.fractalToPixel(new DOMPointReadOnly(x, 0), center, scale, aspect, w, h);
    ctx.moveTo(p.x, 0);
    ctx.lineTo(p.x, h);
  }
  for (const y of grid.gridLines(min.y, max.y, step)) {
    if (Math.abs(y) < eps) continue;
    const p = view.fractalToPixel(new DOMPointReadOnly(0, y), center, scale, aspect, w, h);
    ctx.moveTo(0, p.y);
    ctx.lineTo(w, p.y);
  }
  ctx.stroke();

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (min.x <= 0 && 0 <= max.x) {
    const p = view.fractalToPixel(new DOMPointReadOnly(0, 0), center, scale, aspect, w, h);
    ctx.moveTo(p.x, 0);
    ctx.lineTo(p.x, h);
  }
  if (min.y <= 0 && 0 <= max.y) {
    const p = view.fractalToPixel(new DOMPointReadOnly(0, 0), center, scale, aspect, w, h);
    ctx.moveTo(0, p.y);
    ctx.lineTo(w, p.y);
  }
  ctx.stroke();
}

// Position is always (w/2, h/2) since `center` is the anchor, but it's
// still routed through fractalToPixel for symmetry with drawJuliaMarker and
// so it stays correct if that invariant ever changes.
function drawCenterMarker(ctx, w, h, center, scale, aspect) {
  const p = view.fractalToPixel(center, center, scale, aspect, w, h);
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
function drawJuliaMarker(ctx, w, h, juliaSeed, center, scale, aspect) {
  const p = view.fractalToPixel(juliaSeed, center, scale, aspect, w, h);
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

// Each landmark's position is independent of `center`, same as the Julia
// seed above, so it gets the same per-point cull rather than always being
// on-screen like the grid/center marker.
function drawLandmarks(ctx, w, h, center, scale, aspect) {
  for (const landmark of MANDELBROT_LANDMARKS) {
    const p = view.fractalToPixel(new DOMPointReadOnly(landmark.x, landmark.y), center, scale, aspect, w, h);
    if (p.x < 0 || p.x > w || p.y < 0 || p.y > h) continue;
    const r = 4;

    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    strokeLandmarkDot(ctx, p, r);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#33ccff";
    strokeLandmarkDot(ctx, p, r);
  }
}

function strokeLandmarkDot(ctx, p, r) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.stroke();
}

export const overlay = { drawGrid, drawCenterMarker, drawJuliaMarker, drawLandmarks };
