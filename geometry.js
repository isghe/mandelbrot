function add(a, b) {
  return new DOMPointReadOnly(a.x + b.x, a.y + b.y);
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

export const domPoint = { add, sub, scale, negate, lerp, mid };

// Inverse of MandelbrotApp.toFractal: fractal-space point -> screen-normalized
// [0,1] point, anchored at `anchor`, given the view's vertical extent `scale`
// (complex-plane units) and the canvas `aspect` ratio (width/height).
function fractalToNormalized(fractalPoint, anchor, scale, aspect) {
  return new DOMPointReadOnly(
    (fractalPoint.x - anchor.x) / (scale * aspect) + 0.5,
    0.5 - (fractalPoint.y - anchor.y) / scale
  );
}

export const view = { fractalToNormalized };

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

export const grid = { niceGridStep };
