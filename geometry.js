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
