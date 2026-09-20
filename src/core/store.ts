import { createDocument, validateDocument, LIMITS, EditorError, isRaster, walkLayers } from './model.ts';
import type { Document } from './model.ts';

type Entry = { before: Document; after: Document; label: string; bytes: number };
export class EditorStore {
  private doc: Document = createDocument();
  private history: Entry[] = [];
  private cursor = 0;
  private listeners = new Set<() => void>();
  revision = 0;
  busy = false;
  get document() { return this.doc; }
  get canUndo() { return this.cursor > 0; }
  get canRedo() { return this.cursor < this.history.length; }
  get undoLabel() { return this.history[this.cursor - 1]?.label; }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private emit() { this.revision++; for (const fn of this.listeners) fn(); }
  commit(label: string, change: (doc: Document) => Document, expectedRevision?: number) {
    if (expectedRevision !== undefined && expectedRevision !== this.revision) throw new EditorError('REVISION_CONFLICT', '工程已变化，请重新读取后再修改');
    const before = this.doc;
    const candidate = change(before);
    if (candidate === before || JSON.stringify(candidate) === JSON.stringify(before)) return false;
    const after = validateDocument(candidate);
    const bytes = JSON.stringify(before).length * 2 + JSON.stringify(after).length * 2;
    if (bytes > LIMITS.historyBytes) throw new EditorError('HISTORY_LIMIT', '本次编辑超出历史预算，请拆分工程');
    this.history = this.history.slice(0, this.cursor);
    this.history.push({ before, after, label, bytes });
    while (this.history.length > 1 && (this.history.length > LIMITS.history || this.history.reduce((n,e) => n+e.bytes,0) > LIMITS.historyBytes)) this.history.shift();
    this.cursor = this.history.length; this.doc = after; this.emit(); return true;
  }
  replace(doc: Document) { const valid = validateDocument(doc); this.doc = valid; this.history = []; this.cursor = 0; this.emit(); }
  undo() { if (!this.canUndo) return; this.doc = this.history[--this.cursor].before; this.emit(); }
  redo() { if (!this.canRedo) return; this.doc = this.history[this.cursor++].after; this.emit(); }
  // Includes undo/redo assets, so garbage collection cannot break a retained action.
  referencedAssets() {
    return new Set([this.doc, ...this.history.flatMap(e => [e.before,e.after])].flatMap(d => {
      const ids: string[] = [];
      walkLayers(d.layers, layer => { if (isRaster(layer) && layer.assetId) ids.push(layer.assetId); if (layer.mask?.assetId) ids.push(layer.mask.assetId); });
      return ids;
    }));
  }
}
