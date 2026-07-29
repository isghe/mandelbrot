export function domPointAdd(a, b) {
  return new DOMPointReadOnly(a.x + b.x, a.y + b.y);
}

export function domPointScale(p, k) {
  return new DOMPointReadOnly(p.x * k, p.y * k);
}

export function domPointNegate(a) {
  return domPointScale(a, -1);
}

export function domPointSub(a, b) {
  return domPointAdd(a, domPointNegate(b));
}

export function domPointLerp(a, b, t) {
  return domPointAdd(a, domPointScale(domPointSub(b, a), t));
}

export function domPointMid(a, b) {
  return domPointLerp(a, b, 0.5);
}
