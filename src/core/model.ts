export const LIMITS = { side: 4096, pixels: 16_777_216, assetPixels: 33_554_432, layers: 32, fileBytes: 80 * 1024 * 1024, history: 40, historyBytes: 16 * 1024 * 1024, points: 250_000 } as const;
export const BLENDS = ['source-over', 'multiply', 'screen', 'overlay', 'soft-light', 'darken', 'lighten', 'color-dodge'] as const;
export type Blend = typeof BLENDS[number];
export type Point = { x: number; y: number };
export type Box = Point & { width: number; height: number };
export type Stroke = { points: Point[]; radius: number; hardness: number; opacity: number; color: string; mode: 'paint' | 'erase' | 'restore'; clip?: Point[] };
export type Layer = {
  id: string; name: string; assetId: string | null; width: number; height: number;
  x: number; y: number; scaleX: number; scaleY: number; rotation: number; flipX: boolean; flipY: boolean;
  visible: boolean; locked: boolean; opacity: number; blend: Blend;
  brightness: number; contrast: number; saturation: number;
  strokes: Stroke[]; mask: Stroke[];
};
export type Document = { schemaVersion: 1; id: string; name: string; width: number; height: number; layers: Layer[]; inpaint: Stroke[] };
export type Tool = 'move' | 'hand' | 'select' | 'crop' | 'brush' | 'erase' | 'mask' | 'eyedropper';
export type Asset = { id: string; blob: Blob; width: number; height: number };
export class EditorError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }
export function fail(message: string, code = 'INVALID_INPUT'): never { throw new EditorError(code, message); }
export function dimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > LIMITS.side || height > LIMITS.side || width * height > LIMITS.pixels) fail(`尺寸需为 1–${LIMITS.side} 的整数像素`);
}
export function createDocument(width = 1600, height = 1200, name = '未命名') : Document {
  dimensions(width, height);
  return { schemaVersion: 1, id: crypto.randomUUID(), name, width, height, layers: [], inpaint: [] };
}
export function createLayer(doc: Document, width: number, height: number, assetId: string | null, name: string): Layer {
  dimensions(width, height);
  const scale = Math.min(1, doc.width / width, doc.height / height);
  return { id: crypto.randomUUID(), name, assetId, width, height, x: doc.width / 2, y: doc.height / 2, scaleX: scale, scaleY: scale, rotation: 0, flipX: false, flipY: false, visible: true, locked: false, opacity: 1, blend: 'source-over', brightness: 0, contrast: 0, saturation: 0, strokes: [], mask: [] };
}
export function editable(doc: Document, id: string): Layer {
  const l = doc.layers.find(l => l.id === id);
  if (!l) fail('图层不存在', 'NOT_FOUND');
  if (l.locked) fail('请先解锁图层', 'LAYER_LOCKED');
  return l;
}
export function patchLayer(doc: Document, id: string, patch: Partial<Layer>): Document {
  const current = doc.layers.find(l => l.id === id);
  if (!current) fail('图层不存在', 'NOT_FOUND');
  if (current.locked && !(Object.keys(patch).length === 1 && patch.locked === false)) fail('请先解锁图层', 'LAYER_LOCKED');
  return { ...doc, layers: doc.layers.map(l => l.id === id ? { ...l, ...patch, id: l.id } : l) };
}
export function cropDocument(doc: Document, box: Box): Document {
  const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
  const width = Math.min(doc.width - x, Math.round(box.width));
  const height = Math.min(doc.height - y, Math.round(box.height));
  dimensions(width, height);
  const shift = (p: Point) => ({ x: p.x - x, y: p.y - y });
  return { ...doc, width, height, layers: doc.layers.map(l => ({ ...l, x: l.x - x, y: l.y - y })), inpaint: doc.inpaint.map(s => ({ ...s, points: s.points.map(shift), clip: s.clip?.map(shift) })) };
}
export function localPoint(p: Point, l: Layer): Point {
  const a = -l.rotation * Math.PI / 180, dx = p.x - l.x, dy = p.y - l.y;
  return { x: (dx * Math.cos(a) - dy * Math.sin(a)) / (l.scaleX * (l.flipX ? -1 : 1)) + l.width / 2, y: (dx * Math.sin(a) + dy * Math.cos(a)) / (l.scaleY * (l.flipY ? -1 : 1)) + l.height / 2 };
}
export function worldPoint(p: Point, l: Layer): Point {
  const a = l.rotation * Math.PI / 180, dx = (p.x - l.width / 2) * l.scaleX * (l.flipX ? -1 : 1), dy = (p.y - l.height / 2) * l.scaleY * (l.flipY ? -1 : 1);
  return { x: l.x + dx * Math.cos(a) - dy * Math.sin(a), y: l.y + dx * Math.sin(a) + dy * Math.cos(a) };
}
export function corners(b: Box): Point[] { return [{x:b.x,y:b.y},{x:b.x+b.width,y:b.y},{x:b.x+b.width,y:b.y+b.height},{x:b.x,y:b.y+b.height}]; }

// Never trust project JSON or agent input. Reconstruct only recognized fields.
export function validateDocument(value: unknown): Document {
  const object = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail('工程结构无效'); return v as Record<string, unknown>; };
  const num = (v: unknown, min: number, max: number): number => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail('工程中有无效数值'); return v; };
  const str = (v: unknown, max = 100): string => { if (typeof v !== 'string' || v.length < 1 || v.length > max) fail('工程中有无效名称'); return v; };
  const id = (v: unknown): string => { const s = str(v, 100); if (!/^[a-zA-Z0-9_-]+$/.test(s)) fail('工程标识无效'); return s; };
  const bool = (v: unknown): boolean => { if (typeof v !== 'boolean') fail('工程中有无效开关'); return v; };
  let pointCount = 0;
  const point = (v: unknown): Point => { const p = object(v); if (++pointCount > LIMITS.points) fail('笔画过多，请拆分工程'); return { x: num(p.x,-1e6,1e6), y: num(p.y,-1e6,1e6) }; };
  const strokes = (v: unknown): Stroke[] => {
    if (!Array.isArray(v) || v.length > 10_000) fail('笔画数据无效');
    return v.map(v => { const s = object(v);
      if (!Array.isArray(s.points) || !s.points.length || !['paint','erase','restore'].includes(s.mode as string) || typeof s.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.color)) fail('笔画数据无效');
      let clip: Point[] | undefined;
      if (s.clip !== undefined) { if (!Array.isArray(s.clip) || s.clip.length !== 4) fail('选区数据无效'); clip = s.clip.map(point); }
      return { points: s.points.map(point), radius: num(s.radius,.01,20_000), hardness: num(s.hardness,0,1), opacity: num(s.opacity,0,1), color: s.color, mode: s.mode as Stroke['mode'], ...(clip ? {clip} : {}) };
    });
  };
  const d = object(value);
  if (d.schemaVersion !== 1) fail('暂不支持这个工程版本', 'UNSUPPORTED_VERSION');
  const width = num(d.width,1,LIMITS.side), height = num(d.height,1,LIMITS.side); dimensions(width,height);
  if (!Array.isArray(d.layers) || d.layers.length > LIMITS.layers) fail(`最多支持 ${LIMITS.layers} 个图层`);
  const ids = new Set<string>(); let pixels = 0;
  const layers = d.layers.map(value => { const l = object(value), layerId = id(l.id);
    if (ids.has(layerId)) fail('图层标识重复'); ids.add(layerId);
    const width = num(l.width,1,LIMITS.side), height = num(l.height,1,LIMITS.side); dimensions(width,height);
    pixels += width * height; if (pixels > LIMITS.assetPixels) fail('工程总像素超出当前内存预算');
    if (!BLENDS.includes(l.blend as Blend)) fail('混合模式无效');
    return { id: layerId, name: str(l.name), assetId: l.assetId === null ? null : id(l.assetId), width, height,
      x: num(l.x,-1e6,1e6), y: num(l.y,-1e6,1e6), scaleX: num(l.scaleX,.001,100), scaleY: num(l.scaleY,.001,100), rotation: num(l.rotation,-36000,36000),
      flipX: bool(l.flipX), flipY: bool(l.flipY), visible: bool(l.visible), locked: bool(l.locked), opacity: num(l.opacity,0,1), blend: l.blend as Blend,
      brightness: num(l.brightness,-1,1), contrast: num(l.contrast,-1,1), saturation: num(l.saturation,-1,1), strokes: strokes(l.strokes), mask: strokes(l.mask) };
  });
  return { schemaVersion: 1, id: id(d.id), name: str(d.name), width, height, layers, inpaint: strokes(d.inpaint) };
}
