// Applies `op` component-wise to two DOMPoints, e.g.
// binaryOperation(a, b, (x, y) => x + y) is equivalent to add(a, b).
function binaryOperation(a, b, op) {
  return new DOMPointReadOnly(op(a.x, b.x), op(a.y, b.y));
}

function add(a, b) {
  return binaryOperation(a, b, (x, y) => x + y);
}

// Component-wise (Hadamard) product of two DOMPoints — as opposed to
// scale(), which multiplies a DOMPoint by a scalar.
function multiply(a, b) {
  return binaryOperation(a, b, (x, y) => x * y);
}

function scale(p, k) {
  return new DOMPointReadOnly(p.x * k, p.y * k);
}

function negate(a) {
  return scale(a, -1);
}

function sub(a, b) {
  return add(a, negate(b));
}

function lerp(a, b, t) {
  return add(a, scale(sub(b, a), t));
}

function mid(a, b) {
  return lerp(a, b, 0.5);
}

export const domPoint = { binaryOperation, add, sub, scale, multiply, negate, lerp, mid };

// Screen-normalized [0,1] point -> fractal-space point, anchored at
// `anchor`, given the view's vertical extent `scale` (complex-plane units)
// and the canvas `aspect` ratio (width/height).
function toFractal(normPoint, anchor, scale, aspect) {
  return new DOMPointReadOnly(
    (normPoint.x - 0.5) * scale * aspect + anchor.x,
    (0.5 - normPoint.y) * scale + anchor.y
  );
}

// Solves toFractal(normPoint, anchor, scale, aspect) === fractalPoint for
// `anchor`, given `normPoint` and `fractalPoint` fixed. Used to zoom while
// keeping a chosen fractal point under a fixed screen position: not a true
// functional inverse of toFractal over normPoint<->fractal (those stay
// fixed here) — just isolating the other term, since anchor enters
// toFractal additively with coefficient 1.
function anchorFor(fractalPoint, normPoint, scale, aspect) {
  return new DOMPointReadOnly(
    fractalPoint.x - (normPoint.x - 0.5) * scale * aspect,
    fractalPoint.y - (0.5 - normPoint.y) * scale
  );
}

// Inverse of toFractal: fractal-space point -> screen-normalized [0,1] point.
function fractalToNormalized(fractalPoint, anchor, scale, aspect) {
  return new DOMPointReadOnly(
    (fractalPoint.x - anchor.x) / (scale * aspect) + 0.5,
    0.5 - (fractalPoint.y - anchor.y) / scale
  );
}

// fractalToNormalized, then scaled into a `w`x`h` pixel viewport.
function fractalToPixel(fractalPoint, anchor, scale, aspect, w, h) {
  const n = fractalToNormalized(fractalPoint, anchor, scale, aspect);
  return new DOMPointReadOnly(n.x * w, n.y * h);
}

// New anchor after dragging by `screenDelta` (a normalized [0,1] screen-space
// displacement), given the view's `scale` and `aspect`. Same fractal-per-screen-unit
// relationship as toFractal, just solved for a shifted anchor instead of a point.
function pan(anchor, screenDelta, scale, aspect) {
  return new DOMPointReadOnly(
    anchor.x - screenDelta.x * scale * aspect,
    anchor.y + screenDelta.y * scale
  );
}

export const view = { toFractal, anchorFor, fractalToNormalized, fractalToPixel, pan };

// Rounds a raw grid step (range / targetLines) to a "nice" value of the form
// {1, 2, 5} * 10^n, so grid line density stays reasonable across zoom levels.
function niceGridStep(range, targetLines = 8) {
  const raw = range / targetLines;
  const exponent = Math.floor(Math.log10(raw));
  const fraction = raw / 10 ** exponent;
  let niceFraction;
  if (fraction < 1.5) niceFraction = 1;
  else if (fraction < 3) niceFraction = 2;
  else if (fraction < 7) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * 10 ** exponent;
}

// Positions of grid lines (multiples of `step`) within [min, max], computed
// as i * step (integer index times step) rather than by repeatedly adding
// step, so floating-point error can't accumulate across iterations.
function gridLines(min, max, step) {
  const i0 = Math.ceil(min / step);
  const i1 = Math.floor(max / step);
  const lines = [];
  for (let i = i0; i <= i1; i++) lines.push(i * step);
  return lines;
}

export const grid = { niceGridStep, gridLines };
