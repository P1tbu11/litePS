# Phase 1 Editor Implementation Plan

> **For agentic workers:** Implement task-by-task. Do not add stub tools. Do not expand Agent/Figma protocol.

**Goal:** A human can open an image and finish compositing with PS-correct groups, masks, selections, and adjustment layers.

**Architecture:** Document tree in `model.ts`. Fabric is viewport only. Pixel export goes through `raster.ts`. Unknown layer types are rejected.

**Tech Stack:** TypeScript, React, Fabric 7, existing node:test + browser tests.

---

### Task 1: Document model — done

Layer tree, groups, validation, legacy documents.

### Task 2: Group compositor

**Files:** `src/core/model.ts`, `src/core/raster.ts`, `src/viewport.ts`, `tests/model.test.ts`

- [x] World-transform helpers + tests
- [x] Recursive composite: pass-through, isolate, group opacity/mask
- [x] Viewport uses composed world transform for nested rasters
- [x] Create/ungroup operations; nested layer list

### Task 3: Layer masks and clipping

- [x] Photoshop-style layer / group masks (thumbnail, add/disable/delete, black hides)
- [ ] Clipping masks (clip-to-below)

### Task 4: Selection tools

Rect, ellipse, lasso, polygon lasso, wand (active layer only), boolean ops, feather, selection → mask.

### Task 5: Adjustment layers

Hue/sat, levels, curves, exposure. Clip-able. Remove baked brightness/contrast/saturation.

### Task 6: Clone stamp and blur

Real algorithms only. No healing or content-aware in this phase.
