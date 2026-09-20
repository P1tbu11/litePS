export const LIMITS = { side: 4096, pixels: 16_777_216, assetPixels: 33_554_432, layers: 32, fileBytes: 80 * 1024 * 1024, history: 40, historyBytes: 16 * 1024 * 1024, points: 250_000 } as const;
export const BLENDS = ['source-over', 'multiply', 'screen', 'overlay', 'soft-light', 'darken', 'lighten', 'color-dodge'] as const;
export const GROUP_BLEND = 'pass-through' as const;
export type Blend = typeof BLENDS[number];
export type GroupBlend = Blend | typeof GROUP_BLEND;
export type Point = { x: number; y: number };
export type Box = Point & { width: number; height: number };
export type Span = { y: number; x0: number; x1: number };
export type Stroke = { points: Point[]; radius: number; hardness: number; opacity: number; color: string; mode: 'paint' | 'erase' | 'restore'; clip?: Point[]; spans?: Span[] };
export type LayerMask = { assetId: string | null; disabled: boolean; strokes: Stroke[] };
export type RasterLayer = {
  type: 'raster';
  id: string; name: string; assetId: string | null; width: number; height: number;
  x: number; y: number; scaleX: number; scaleY: number; rotation: number; flipX: boolean; flipY: boolean;
  visible: boolean; locked: boolean; opacity: number; blend: Blend;
  brightness: number; contrast: number; saturation: number;
  strokes: Stroke[]; mask: LayerMask | null;
};
export type GroupLayer = {
  type: 'group';
  id: string; name: string; children: Layer[];
  x: number; y: number; scaleX: number; scaleY: number; rotation: number; flipX: boolean; flipY: boolean;
  visible: boolean; locked: boolean; opacity: number; blend: GroupBlend;
  mask: LayerMask | null;
};
export type Layer = RasterLayer | GroupLayer;
export type LayerPatch = Partial<Pick<RasterLayer, 'name' | 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'flipX' | 'flipY' | 'visible' | 'locked' | 'opacity' | 'brightness' | 'contrast' | 'saturation' | 'strokes'>> & { blend?: GroupBlend; children?: Layer[] };
export type Document = { schemaVersion: 1; id: string; name: string; width: number; height: number; layers: Layer[]; inpaint: Stroke[] };
export type Tool = 'move' | 'hand' | 'select' | 'lasso' | 'crop' | 'brush' | 'erase' | 'eyedropper' | 'wand' | 'fill';
export type Asset = { id: string; blob: Blob; width: number; height: number };
export class EditorError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }
export function fail(message: string, code = 'INVALID_INPUT'): never { throw new EditorError(code, message); }
export function isRaster(layer: Layer): layer is RasterLayer { return layer.type !== 'group'; }
export function isGroup(layer: Layer): layer is GroupLayer { return layer.type === 'group'; }
export function dimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > LIMITS.side || height > LIMITS.side || width * height > LIMITS.pixels) fail(`尺寸需为 1–${LIMITS.side} 的整数像素`);
}
export function createDocument(width = 1600, height = 1200, name = '未命名') : Document {
  dimensions(width, height);
  return { schemaVersion: 1, id: crypto.randomUUID(), name, width, height, layers: [], inpaint: [] };
}
export function createLayer(doc: Document, width: number, height: number, assetId: string | null, name: string): RasterLayer {
  dimensions(width, height);
  const scale = Math.min(1, doc.width / width, doc.height / height);
  return { type: 'raster', id: crypto.randomUUID(), name, assetId, width, height, x: doc.width / 2, y: doc.height / 2, scaleX: scale, scaleY: scale, rotation: 0, flipX: false, flipY: false, visible: true, locked: false, opacity: 1, blend: 'source-over', brightness: 0, contrast: 0, saturation: 0, strokes: [], mask: null };
}
export function createMask(): LayerMask { return { assetId: null, disabled: false, strokes: [] }; }
export function hasMask(layer: Layer) { return layer.mask !== null; }
export function maskEnabled(layer: Layer) { return !!layer.mask && !layer.mask.disabled; }
export function needsDocumentComposite(nodes: Layer[]): boolean {
  for (const node of nodes) {
    if (isGroup(node) && (maskEnabled(node) || node.opacity < 1 || isIsolatedGroup(node) || needsDocumentComposite(node.children))) return true;
  }
  return false;
}
export function createGroup(name = '组', children: Layer[] = []): GroupLayer {
  return { type: 'group', id: crypto.randomUUID(), name, children, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false, visible: true, locked: false, opacity: 1, blend: GROUP_BLEND, mask: null };
}
export type Xform = Pick<GroupLayer, 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'flipX' | 'flipY'>;
export function isIsolatedGroup(group: GroupLayer) { return group.blend !== GROUP_BLEND; }
export function isIdentityGroup(group: GroupLayer) {
  return group.x === 0 && group.y === 0 && group.scaleX === 1 && group.scaleY === 1 && group.rotation === 0 && !group.flipX && !group.flipY;
}
export function applyGroupXform(local: Xform, group: GroupLayer): Xform {
  const angle = group.rotation * Math.PI / 180, fx = group.flipX ? -1 : 1, fy = group.flipY ? -1 : 1;
  const dx = local.x * group.scaleX * fx, dy = local.y * group.scaleY * fy;
  return {
    x: group.x + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: group.y + dx * Math.sin(angle) + dy * Math.cos(angle),
    scaleX: local.scaleX * group.scaleX, scaleY: local.scaleY * group.scaleY,
    rotation: local.rotation + group.rotation, flipX: local.flipX !== group.flipX, flipY: local.flipY !== group.flipY,
  };
}
export function invertGroupXform(world: Xform, group: GroupLayer): Xform {
  const angle = -group.rotation * Math.PI / 180, fx = group.flipX ? -1 : 1, fy = group.flipY ? -1 : 1;
  const dx = world.x - group.x, dy = world.y - group.y;
  return {
    x: (dx * Math.cos(angle) - dy * Math.sin(angle)) / (group.scaleX * fx),
    y: (dx * Math.sin(angle) + dy * Math.cos(angle)) / (group.scaleY * fy),
    scaleX: world.scaleX / group.scaleX, scaleY: world.scaleY / group.scaleY,
    rotation: world.rotation - group.rotation, flipX: world.flipX !== group.flipX, flipY: world.flipY !== group.flipY,
  };
}
export function composeOntoRaster(layer: RasterLayer, groups: GroupLayer[]): RasterLayer {
  let xform: Xform = layer;
  for (const group of [...groups].reverse()) xform = applyGroupXform(xform, group);
  return { ...layer, ...xform };
}
export function localFromWorld(world: Xform, groups: GroupLayer[]): Xform {
  let xform = world;
  for (const group of groups) xform = invertGroupXform(xform, group);
  return xform;
}
export function eachRaster(nodes: Layer[], visit: (layer: RasterLayer, groups: GroupLayer[]) => void, groups: GroupLayer[] = []) {
  for (const node of nodes) {
    if (isRaster(node)) visit(node, groups);
    else if (isGroup(node)) eachRaster(node.children, visit, [...groups, node]);
  }
}
export function locateNode(doc: Document, id: string): { node: Layer; parent: GroupLayer | null; siblings: Layer[]; index: number } {
  const search = (siblings: Layer[], parent: GroupLayer | null): { node: Layer; parent: GroupLayer | null; siblings: Layer[]; index: number } | undefined => {
    const index = siblings.findIndex(node => node.id === id);
    if (index >= 0) return { node: siblings[index], parent, siblings, index };
    for (const node of siblings) { if (isGroup(node)) { const hit = search(node.children, node); if (hit) return hit; } }
  };
  const hit = search(doc.layers, null);
  if (!hit) fail('图层不存在', 'NOT_FOUND');
  return hit;
}
export function ancestors(doc: Document, id: string): GroupLayer[] {
  const path: GroupLayer[] = [];
  const search = (nodes: Layer[]): boolean => {
    for (const node of nodes) {
      if (node.id === id) return true;
      if (isGroup(node) && search(node.children)) { path.unshift(node); return true; }
    }
    return false;
  };
  search(doc.layers);
  return path;
}
function containsNode(root: Layer, id: string): boolean {
  if (root.id === id) return true;
  return isGroup(root) && root.children.some(child => containsNode(child, id));
}
export function cloneNode(layer: Layer, rename = false): Layer {
  const name = rename ? `${layer.name.slice(0, 90)} 副本` : layer.name;
  const mask = layer.mask ? { ...layer.mask, strokes: layer.mask.strokes.map(stroke => ({ ...stroke, points: stroke.points.map(p => ({ ...p })) })) } : null;
  return isGroup(layer) ? { ...layer, id: crypto.randomUUID(), name, mask, children: layer.children.map(child => cloneNode(child)) } : { ...layer, id: crypto.randomUUID(), name, mask };
}
export function nodeSize(layer: Layer): number { return 1 + (isGroup(layer) ? layer.children.reduce((n, child) => n + nodeSize(child), 0) : 0); }
export function replaceSiblings(doc: Document, parentId: string | null, siblings: Layer[]): Document {
  if (parentId === null) return { ...doc, layers: siblings };
  return { ...doc, layers: mapNodes(doc.layers, parentId, layer => {
    if (!isGroup(layer)) fail('目标不是组');
    return { ...layer, children: siblings };
  }) };
}
export function groupNodes(doc: Document, ids: string[]): Document {
  if (nodeCount(doc) + 1 > LIMITS.layers) fail(`最多支持 ${LIMITS.layers} 个图层`);
  if (!ids.length) return { ...doc, layers: [...doc.layers, createGroup()] };
  const first = locateNode(doc, ids[0]);
  const picked = ids.map(id => {
    const loc = locateNode(doc, id);
    if ((loc.parent?.id ?? null) !== (first.parent?.id ?? null)) fail('只能把同一级图层编成组');
    if (loc.node.locked) fail('请先解锁图层', 'LAYER_LOCKED');
    return loc;
  }).sort((a, b) => a.index - b.index);
  const taken = new Set(ids);
  const next = first.siblings.filter(node => !taken.has(node.id));
  next.splice(picked[0].index, 0, createGroup('组', picked.map(item => item.node)));
  return replaceSiblings(doc, first.parent?.id ?? null, next);
}
export function ungroupNode(doc: Document, id: string): Document {
  const loc = locateNode(doc, id);
  if (!isGroup(loc.node)) fail('请选中组');
  const group = loc.node;
  if (group.locked) fail('请先解锁图层', 'LAYER_LOCKED');
  const baked = group.children.map(child => isRaster(child) ? composeOntoRaster(child, [group]) : { ...child, ...applyGroupXform(child, group) });
  return replaceSiblings(doc, loc.parent?.id ?? null, [...loc.siblings.slice(0, loc.index), ...baked, ...loc.siblings.slice(loc.index + 1)]);
}
export function moveNode(doc: Document, id: string, index: number, parentId?: string | null): Document {
  const loc = locateNode(doc, id);
  if (loc.node.locked) fail('请先解锁图层', 'LAYER_LOCKED');
  const destParentId = parentId === undefined ? loc.parent?.id ?? null : parentId;
  if (destParentId === id || (isGroup(loc.node) && destParentId !== null && containsNode(loc.node, destParentId))) fail('不能把组移入自身');
  if (!Number.isInteger(index) || index < 0) fail('图层位置无效');
  if (destParentId === (loc.parent?.id ?? null)) {
    if (index >= loc.siblings.length) fail('图层位置无效');
    const siblings = loc.siblings.filter(node => node.id !== id);
    siblings.splice(index, 0, loc.node);
    return replaceSiblings(doc, destParentId, siblings);
  }
  const removed = replaceSiblings(doc, loc.parent?.id ?? null, loc.siblings.filter(node => node.id !== id));
  const dest = destParentId === null ? removed.layers : (() => {
    const parent = findNode(removed, destParentId);
    if (!parent || !isGroup(parent)) fail('目标不是组');
    if (parent.locked) fail('请先解锁图层', 'LAYER_LOCKED');
    return parent.children;
  })();
  if (index > dest.length) fail('图层位置无效');
  const siblings = [...dest];
  siblings.splice(index, 0, loc.node);
  return replaceSiblings(removed, destParentId, siblings);
}
export function findNode(doc: Document, id: string): Layer | undefined {
  const search = (nodes: Layer[]): Layer | undefined => {
    for (const node of nodes) {
      if (node.id === id) return node;
      if (isGroup(node)) { const hit = search(node.children); if (hit) return hit; }
    }
  };
  return search(doc.layers);
}
export function nodeCount(doc: Document): number {
  let count = 0;
  const walk = (nodes: Layer[]) => { for (const node of nodes) { count++; if (isGroup(node)) walk(node.children); } };
  walk(doc.layers);
  return count;
}
export function walkLayers(nodes: Layer[], visit: (layer: Layer) => void) {
  for (const node of nodes) { visit(node); if (isGroup(node)) walkLayers(node.children, visit); }
}
export function rasterLayers(nodes: Layer[]): RasterLayer[] {
  const out: RasterLayer[] = [];
  walkLayers(nodes, layer => { if (isRaster(layer)) out.push(layer); });
  return out;
}
export function requireRaster(layer: Layer): RasterLayer {
  if (!isRaster(layer)) fail('请选中图像图层');
  return layer;
}
export function removeNode(nodes: Layer[], id: string): Layer[] {
  return nodes.flatMap(node => node.id === id ? [] : [isGroup(node) ? { ...node, children: removeNode(node.children, id) } : node]);
}
function mapNodes(nodes: Layer[], id: string, change: (layer: Layer) => Layer): Layer[] {
  return nodes.map(node => {
    if (node.id === id) return change(node);
    return isGroup(node) ? { ...node, children: mapNodes(node.children, id, change) } : node;
  });
}
export function editable(doc: Document, id: string): Layer {
  const layer = findNode(doc, id);
  if (!layer) fail('图层不存在', 'NOT_FOUND');
  if (layer.locked) fail('请先解锁图层', 'LAYER_LOCKED');
  return layer;
}
export function patchLayer(doc: Document, id: string, patch: LayerPatch): Document {
  const current = findNode(doc, id);
  if (!current) fail('图层不存在', 'NOT_FOUND');
  if (current.locked && !(Object.keys(patch).length === 1 && patch.locked === false)) fail('请先解锁图层', 'LAYER_LOCKED');
  if (isGroup(current)) {
    if (patch.brightness !== undefined || patch.contrast !== undefined || patch.saturation !== undefined) fail('不允许修改这个图层属性');
    if (patch.blend !== undefined && patch.blend !== GROUP_BLEND && !BLENDS.includes(patch.blend as Blend)) fail('混合模式无效');
  } else if (patch.blend === GROUP_BLEND) fail('混合模式无效');
  return { ...doc, layers: mapNodes(doc.layers, id, layer => ({ ...layer, ...patch, type: layer.type, id: layer.id, mask: layer.mask, ...(isGroup(layer) ? { children: patch.children ?? layer.children } : {}) } as Layer)) };
}
export function setLayerMask(doc: Document, id: string, mask: LayerMask | null): Document {
  editable(doc, id);
  return { ...doc, layers: mapNodes(doc.layers, id, layer => ({ ...layer, mask })) };
}
export function bakeRaster(doc: Document, id: string, assetId: string, width: number, height: number): Document {
  requireRaster(editable(doc, id));
  dimensions(width, height);
  return { ...doc, layers: mapNodes(doc.layers, id, layer => isRaster(layer) ? { ...layer, assetId, width, height, strokes: [], brightness: 0, contrast: 0, saturation: 0 } : layer) };
}
export function mergeDown(doc: Document, id: string, baked: { assetId: string; width: number; height: number; x: number; y: number }): Document {
  const loc = locateNode(doc, id);
  editable(doc, id);
  if (loc.index === 0) fail('没有可向下合并的图层');
  const below = loc.siblings[loc.index - 1];
  if (below.locked) fail('请先解锁图层', 'LAYER_LOCKED');
  const raster: RasterLayer = {
    type: 'raster', id: below.id, name: below.name, assetId: baked.assetId, width: baked.width, height: baked.height,
    x: baked.x, y: baked.y, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false,
    visible: true, locked: false, opacity: 1, blend: 'source-over',
    brightness: 0, contrast: 0, saturation: 0, strokes: [], mask: null,
  };
  const siblings = loc.siblings.filter(node => node.id !== id);
  siblings[siblings.findIndex(node => node.id === below.id)] = raster;
  return replaceSiblings(doc, loc.parent?.id ?? null, siblings);
}
export function flattenDocument(doc: Document, baked: { assetId: string; width: number; height: number }): Document {
  const layer = createLayer(doc, baked.width, baked.height, baked.assetId, '拼合');
  layer.scaleX = 1;
  layer.scaleY = 1;
  return { ...doc, layers: [layer] };
}
export function cropDocument(doc: Document, box: Box): Document {
  const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
  const width = Math.min(doc.width - x, Math.round(box.width));
  const height = Math.min(doc.height - y, Math.round(box.height));
  dimensions(width, height);
  const shift = (p: Point) => ({ x: p.x - x, y: p.y - y });
  return { ...doc, width, height, layers: doc.layers.map(layer => ({ ...layer, x: layer.x - x, y: layer.y - y })), inpaint: doc.inpaint.map(s => ({ ...s, points: s.points.map(shift), clip: s.clip?.map(shift) })) };
}
export function localPoint(p: Point, l: RasterLayer): Point {
  const a = -l.rotation * Math.PI / 180, dx = p.x - l.x, dy = p.y - l.y;
  return { x: (dx * Math.cos(a) - dy * Math.sin(a)) / (l.scaleX * (l.flipX ? -1 : 1)) + l.width / 2, y: (dx * Math.sin(a) + dy * Math.cos(a)) / (l.scaleY * (l.flipY ? -1 : 1)) + l.height / 2 };
}
export function worldPoint(p: Point, l: RasterLayer): Point {
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
  let pointCount = 0, nodeTotal = 0, pixels = 0;
  const point = (v: unknown): Point => { const p = object(v); if (++pointCount > LIMITS.points) fail('笔画过多，请拆分工程'); return { x: num(p.x,-1e6,1e6), y: num(p.y,-1e6,1e6) }; };
  const strokes = (v: unknown): Stroke[] => {
    if (!Array.isArray(v) || v.length > 10_000) fail('笔画数据无效');
    return v.map(v => { const s = object(v);
      if (!Array.isArray(s.points) || !s.points.length || !['paint','erase','restore'].includes(s.mode as string) || typeof s.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.color)) fail('笔画数据无效');
      let clip: Point[] | undefined;
      if (s.clip !== undefined) { if (!Array.isArray(s.clip) || s.clip.length !== 4) fail('选区数据无效'); clip = s.clip.map(point); }
      let spans: Span[] | undefined;
      if (s.spans !== undefined) {
        if (!Array.isArray(s.spans) || s.spans.length > LIMITS.points) fail('选区数据无效');
        spans = s.spans.map(v => { const span = object(v); return { y: num(span.y,-1e6,1e6), x0: num(span.x0,-1e6,1e6), x1: num(span.x1,-1e6,1e6) }; });
      }
      return { points: s.points.map(point), radius: num(s.radius,.01,20_000), hardness: num(s.hardness,0,1), opacity: num(s.opacity,0,1), color: s.color, mode: s.mode as Stroke['mode'], ...(clip ? {clip} : {}), ...(spans ? {spans} : {}) };
    });
  };
  const parseMask = (value: unknown): LayerMask | null => {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) { const list = strokes(value); return list.length ? { assetId: null, disabled: false, strokes: list } : null; }
    const m = object(value);
    const painted = m.strokes === undefined ? [] : strokes(m.strokes);
    return { assetId: m.assetId === null || m.assetId === undefined ? null : id(m.assetId), disabled: m.disabled === undefined ? false : bool(m.disabled), strokes: painted };
  };
  const ids = new Set<string>();
  const parseLayer = (value: unknown): Layer => {
    const l = object(value), layerId = id(l.id);
    if (ids.has(layerId)) fail('图层标识重复'); ids.add(layerId);
    if (++nodeTotal > LIMITS.layers) fail(`最多支持 ${LIMITS.layers} 个图层`);
    const kind = l.type === undefined ? 'raster' : str(l.type, 32);
    if (kind === 'group') {
      if (!Array.isArray(l.children)) fail('工程结构无效');
      if (l.blend !== GROUP_BLEND && !BLENDS.includes(l.blend as Blend)) fail('混合模式无效');
      return { type: 'group', id: layerId, name: str(l.name), children: l.children.map(parseLayer),
        x: num(l.x,-1e6,1e6), y: num(l.y,-1e6,1e6), scaleX: num(l.scaleX,.001,100), scaleY: num(l.scaleY,.001,100), rotation: num(l.rotation,-36000,36000),
        flipX: bool(l.flipX), flipY: bool(l.flipY), visible: bool(l.visible), locked: bool(l.locked), opacity: num(l.opacity,0,1), blend: l.blend as GroupBlend, mask: parseMask(l.mask) };
    }
    if (kind !== 'raster') fail('不支持这个图层类型', 'UNSUPPORTED_LAYER');
    const width = num(l.width,1,LIMITS.side), height = num(l.height,1,LIMITS.side); dimensions(width,height);
    pixels += width * height; if (pixels > LIMITS.assetPixels) fail('工程总像素超出当前内存预算');
    if (!BLENDS.includes(l.blend as Blend)) fail('混合模式无效');
    return { type: 'raster', id: layerId, name: str(l.name), assetId: l.assetId === null ? null : id(l.assetId), width, height,
      x: num(l.x,-1e6,1e6), y: num(l.y,-1e6,1e6), scaleX: num(l.scaleX,.001,100), scaleY: num(l.scaleY,.001,100), rotation: num(l.rotation,-36000,36000),
      flipX: bool(l.flipX), flipY: bool(l.flipY), visible: bool(l.visible), locked: bool(l.locked), opacity: num(l.opacity,0,1), blend: l.blend as Blend,
      brightness: num(l.brightness,-1,1), contrast: num(l.contrast,-1,1), saturation: num(l.saturation,-1,1), strokes: strokes(l.strokes), mask: parseMask(l.mask) };
  };
  const d = object(value);
  if (d.schemaVersion !== 1) fail('暂不支持这个工程版本', 'UNSUPPORTED_VERSION');
  const width = num(d.width,1,LIMITS.side), height = num(d.height,1,LIMITS.side); dimensions(width,height);
  if (!Array.isArray(d.layers) || d.layers.length > LIMITS.layers) fail(`最多支持 ${LIMITS.layers} 个图层`);
  return { schemaVersion: 1, id: id(d.id), name: str(d.name), width, height, layers: d.layers.map(parseLayer), inpaint: strokes(d.inpaint) };
}
