export function floodMask(src: Uint8ClampedArray, width: number, height: number, x: number, y: number, tolerance: number, contiguous = true): Uint8Array {
  const mask = new Uint8Array(width * height);
  const sx = Math.floor(x), sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return mask;
  const seed = (sy * width + sx) * 4;
  const sr = src[seed], sg = src[seed + 1], sb = src[seed + 2], sa = src[seed + 3];
  const matches = (i: number) => Math.max(Math.abs(src[i] - sr), Math.abs(src[i + 1] - sg), Math.abs(src[i + 2] - sb), Math.abs(src[i + 3] - sa)) <= tolerance;
  if (!contiguous) {
    for (let i = 0, p = 0; p < mask.length; i += 4, p++) if (matches(i)) mask[p] = 255;
    return mask;
  }
  const stack = [sy * width + sx];
  mask[sy * width + sx] = 255;
  while (stack.length) {
    const i = stack.pop()!, cx = i % width, cy = (i - cx) / width;
    for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (mask[n] || !matches(n * 4)) continue;
      mask[n] = 255;
      stack.push(n);
    }
  }
  return mask;
}
export function applyMaskColor(dest: Uint8ClampedArray, width: number, height: number, mask: Uint8Array, color: [number, number, number, number]) {
  const [r, g, b, a] = color;
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    if (!mask[p]) continue;
    dest[i] = r; dest[i + 1] = g; dest[i + 2] = b; dest[i + 3] = a;
  }
}
export function andMasks(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] && b[i] ? 255 : 0;
  return out;
}
export function parseHex(hex: string): [number, number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];
}
