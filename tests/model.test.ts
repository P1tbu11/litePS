import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createLayer, cropDocument, localPoint, worldPoint, patchLayer, validateDocument } from '../src/core/model.ts';
import { EditorStore } from '../src/core/store.ts';

test('rotated and flipped layer coordinates round trip', () => {
  const l = { ...createLayer(createDocument(),300,200,null,'主体'), x:230, y:320, rotation:37, scaleX:.7, scaleY:1.4, flipX:true };
  const p = {x:51,y:89}, back = localPoint(worldPoint(p,l),l);
  assert.ok(Math.abs(back.x-p.x)<1e-8 && Math.abs(back.y-p.y)<1e-8);
});
test('crop keeps layer and inpaint aligned; preserves source dimensions', () => {
  let d = createDocument(800,600); d.layers.push(createLayer(d,400,300,null,'主体'));
  d.inpaint.push({points:[{x:150,y:120}],radius:10,hardness:1,opacity:1,color:'#ffffff',mode:'paint'});
  const c = cropDocument(d,{x:100,y:50,width:500,height:400});
  assert.deepEqual([c.width,c.height,c.layers[0].x,c.layers[0].y,c.layers[0].width],[500,400,300,250,400]);
  assert.deepEqual(c.inpaint[0].points,[{x:50,y:70}]); assert.equal(d.width,800);
});
test('invalid import, locked change and stale write leave document and history intact', () => {
  const s = new EditorStore(); s.commit('添加', d => ({...d,layers:[createLayer(d,20,20,null,'图层')]}));
  const id=s.document.layers[0].id;
  s.commit('锁定',d=>patchLayer(d,id,{locked:true})); const rev=s.revision;
  assert.throws(()=>s.commit('移动',d=>patchLayer(d,id,{x:100})),/解锁/);
  assert.throws(()=>s.replace({...s.document,width:NaN}));
  assert.throws(()=>s.commit('重命名',d=>({...d,name:'新名称'}),rev-1),/已变化/);
  assert.equal(s.revision,rev); assert.equal(s.document.layers[0].locked,true);
  s.commit('解锁',d=>patchLayer(d,id,{locked:false})); s.undo(); assert.equal(s.document.layers[0].locked,true);
  s.redo(); assert.equal(s.document.layers[0].locked,false);
});
test('undo revisions remain monotonic and a new edit invalidates redo', () => {
  const s=new EditorStore(); s.commit('名称',d=>({...d,name:'A'})); const r=s.revision;
  s.undo(); assert.ok(s.revision>r); s.commit('名称',d=>({...d,name:'B'})); assert.equal(s.canRedo,false);
});
test('project validation rejects oversized layers, duplicate IDs and invalid brush data', () => {
  const d=createDocument(); d.layers.push(createLayer(d,200,200,null,'A'));
  assert.throws(()=>validateDocument({...d,layers:[d.layers[0],d.layers[0]]}),/重复/);
  assert.throws(()=>validateDocument({...d,layers:[{...d.layers[0],width:9000}]}));
  assert.throws(()=>validateDocument({...d,inpaint:[{points:[],radius:1}]}));
});
