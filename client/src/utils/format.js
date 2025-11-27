export function formatSats(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  return v.toLocaleString("en-US");
}
