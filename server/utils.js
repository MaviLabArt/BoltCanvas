export function makeId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return String(h);
}

export function now() {
  return Date.now();
}
