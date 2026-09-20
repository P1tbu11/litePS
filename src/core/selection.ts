import { composeOntoRaster, corners, worldPoint } from './model.ts';
import type { Box, GroupLayer, Point, RasterLayer, Span, Stroke } from './model.ts';

export type Selection = { width: number; height: number; data: Uint8Array };
export type Combine = 'replace' | 'add' | 'subtract' | 'intersect';
export type { Span };

export function selectionFromRect(width: number, height: number, box: Box): Selection {
  const data = new Uint8Array(width * height);
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.round(box.x + box.width)), y1 = Math.min(height, Math.round(box.y + box.height));
  for (let y = y0; y < y1; y++) data.fill(255, y * width + x0, y * width + x1);
  return { width, height, data };
}
export function selectionFromPolygon(width: number, height: number, points: Point[]): Selection {
  const data = new Uint8Array(width * height);
  if (points.length < 3) return { width, height, data };
  const ring = points[0].x === points.at(-1)!.x && points[0].y === points.at(-1)!.y ? points : [...points, points[0]];
  for (let y = 0; y < height; y++) {
    const ys = y + .5, xs: number[] = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i], b = ring[i + 1];
      if ((a.y <= ys && b.y > ys) || (b.y <= ys && a.y > ys)) xs.push(a.x + (ys - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.ceil(xs[i])), x1 = Math.min(width, Math.floor(xs[i + 1]));
      if (x1 > x0) data.fill(255, y * width + x0, y * width + x1);
    }
  }
  return { width, height, data };
}
export function selectionFromMask(width: number, height: number, data: Uint8Array): Selection {
  return { width, height, data: data.length === width * height ? data : data.slice(0, width * height) };
}
export function selectionIsEmpty(sel: Selection) { return !sel.data.some(v => v); }
export function selectionBounds(sel: Selection): Box | null {
  let x0 = sel.width, y0 = sel.height, x1 = -1, y1 = -1;
  for (let y = 0; y < sel.height; y++) {
    const row = y * sel.width;
    for (let x = 0; x < sel.width; x++) if (sel.data[row + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
export function invertSelection(sel: Selection): Selection {
  const data = new Uint8Array(sel.data.length);
  for (let i = 0; i < data.length; i++) data[i] = sel.data[i] ? 0 : 255;
  return { width: sel.width, height: sel.height, data };
}
export function combineSelections(a: Selection, b: Selection, mode: Combine): Selection {
  if (a.width !== b.width || a.height !== b.height) return mode === 'replace' ? b : a;
  if (mode === 'replace') return { width: b.width, height: b.height, data: new Uint8Array(b.data) };
  const data = new Uint8Array(a.data.length);
  for (let i = 0; i < data.length; i++) {
    const left = a.data[i], right = b.data[i];
    data[i] = mode === 'add' ? (left || right) : mode === 'subtract' ? (left && !right ? 255 : 0) : (left && right ? 255 : 0);
  }
  return { width: a.width, height: a.height, data };
}
export function spansFromMask(data: Uint8Array, width: number, height: number): Span[] {
  const spans: Span[] = [];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let x = 0;
    while (x < width) {
      while (x < width && !data[row + x]) x++;
      if (x >= width) break;
      const x0 = x;
      while (x < width && data[row + x]) x++;
      spans.push({ y, x0, x1: x });
    }
  }
  return spans;
}
export function selectionContours(sel: Selection): Point[][] {
  const w = sel.width, h = sel.height, data = sel.data;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] !== 0;
  const out = new Map<string, Point[]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = `${x0},${y0}`, list = out.get(k) ?? [];
    list.push({ x: x1, y: y1 });
    out.set(k, list);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!on(x, y)) continue;
    if (!on(x, y - 1)) add(x, y, x + 1, y);
    if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!on(x - 1, y)) add(x, y + 1, x, y);
  }
  const contours: Point[][] = [];
  while (out.size) {
    const start = out.keys().next().value!;
    const [sx, sy] = start.split(',').map(Number);
    const ring: Point[] = [{ x: sx, y: sy }];
    let cx = sx, cy = sy;
    for (;;) {
      const nexts = out.get(`${cx},${cy}`);
      if (!nexts?.length) break;
      const n = nexts.pop()!;
      if (!nexts.length) out.delete(`${cx},${cy}`);
      ring.push(n);
      cx = n.x; cy = n.y;
      if (cx === sx && cy === sy) break;
    }
    const simple: Point[] = [ring[0]];
    for (let i = 1; i < ring.length - 1; i++) {
      const a = simple[simple.length - 1], b = ring[i], c = ring[i + 1];
      if ((b.x - a.x) * (c.y - a.y) === (b.y - a.y) * (c.x - a.x)) continue;
      simple.push(b);
    }
    simple.push(ring[ring.length - 1]);
    if (simple.length > 2) contours.push(simple);
  }
  return contours;
}
export function selectionIsRect(sel: Selection) {
  const box = selectionBounds(sel);
  if (!box) return false;
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) if (!sel.data[y * sel.width + x]) return false;
  }
  return true;
}
export function selectionOnLayer(sel: Selection, layer: RasterLayer, groups: GroupLayer[] = []): Uint8Array {
  const world = composeOntoRaster(layer, groups);
  const out = new Uint8Array(layer.width * layer.height);
  for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) {
    const p = worldPoint({ x, y }, world);
    const dx = Math.floor(p.x), dy = Math.floor(p.y);
    if (dx >= 0 && dy >= 0 && dx < sel.width && dy < sel.height) out[y * layer.width + x] = sel.data[dy * sel.width + dx];
  }
  return out;
}
export function strokeClip(sel: Selection, layer: RasterLayer, groups: GroupLayer[] = []): Pick<Stroke, 'clip' | 'spans'> {
  const local = selectionOnLayer(sel, layer, groups);
  const box = selectionBounds({ width: layer.width, height: layer.height, data: local });
  if (!box) return {};
  if (selectionIsRect({ width: layer.width, height: layer.height, data: local })) return { clip: corners(box) };
  return { spans: spansFromMask(local, layer.width, layer.height) };
}
