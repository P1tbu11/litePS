import test from 'node:test';
import assert from 'node:assert/strict';
import { composeOntoRaster, createDocument, createLayer, createGroup, cropDocument, findNode, isGroup, isIdentityGroup, isIsolatedGroup, isRaster, localFromWorld, localPoint, worldPoint, nodeCount, patchLayer, validateDocument } from '../src/core/model.ts';
import type { Document } from '../src/core/model.ts';
import { applyOperation } from '../src/core/editor.ts';
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
  assert.ok(isRaster(c.layers[0]));
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
test('legacy documents without type still validate as raster layers', () => {
  const d=createDocument(); const layer=createLayer(d,20,20,null,'旧图层');
  const {type:_,...legacy}=layer;
  const doc=validateDocument({...d,layers:[legacy]});
  assert.equal(isRaster(doc.layers[0]),true);
  assert.equal(doc.layers[0].type,'raster');
});
test('nested groups validate, find children, and count every node', () => {
  const d=createDocument();
  const child=createLayer(d,20,20,null,'子层');
  const inner=createGroup('内组',[child]);
  const outer=createGroup('外组',[inner]);
  const doc=validateDocument({...d,layers:[outer]});
  assert.equal(nodeCount(doc),3);
  assert.equal(isGroup(doc.layers[0]),true);
  assert.equal(findNode(doc,child.id)?.name,'子层');
  assert.equal(createGroup('空组').blend,'pass-through');
  assert.deepEqual([createGroup('空组').x,createGroup('空组').y,createGroup('空组').scaleX],[0,0,1]);
});
test('unknown layer types are rejected so phase-two nodes cannot sneak in', () => {
  const d=createDocument(); const layer=createLayer(d,20,20,null,'A');
  assert.throws(()=>validateDocument({...d,layers:[{...layer,type:'shape'}]}),/不支持/);
  assert.throws(()=>validateDocument({...d,layers:[{...createGroup('组'),type:'fill'}]}),/不支持/);
});
test('pass-through identity groups do not isolate; other blends do', () => {
  const g=createGroup('组');
  assert.equal(isIsolatedGroup(g),false);
  assert.equal(isIdentityGroup(g),true);
  assert.equal(isIsolatedGroup({...g,blend:'multiply'}),true);
  assert.equal(isIdentityGroup({...g,x:12}),false);
});
test('group transforms compose onto nested raster centers without baking children', () => {
  const d=createDocument();
  const child=createLayer(d,100,80,null,'子层');
  child.x=40; child.y=10; child.scaleX=1; child.scaleY=1; child.rotation=0;
  const group=createGroup('组',[child]);
  group.x=100; group.y=50; group.scaleX=2; group.rotation=0;
  const world=composeOntoRaster(child,[group]);
  assert.equal(child.x,40);
  assert.equal(world.x,180);
  assert.equal(world.y,60);
  assert.equal(world.scaleX,2);
  const back=localFromWorld(world,[group]);
  assert.ok(Math.abs(back.x-40)<1e-8 && Math.abs(back.y-10)<1e-8 && Math.abs(back.scaleX-1)<1e-8);
});
test('nested group transforms apply inner then outer', () => {
  const d=createDocument();
  const child=createLayer(d,20,20,null,'子层');
  child.x=40; child.y=10;
  const inner=createGroup('内组',[child]); inner.x=10; inner.y=0;
  const outer=createGroup('外组',[inner]); outer.x=100; outer.y=50; outer.scaleX=2;
  const world=composeOntoRaster(child,[outer,inner]);
  assert.equal(world.x,200);
  assert.equal(world.y,60);
});
test('crop shifts root group origin and leaves child-local coordinates', () => {
  const d=createDocument(800,600);
  const child=createLayer(d,40,40,null,'子层');
  child.x=200; child.y=180;
  d.layers=[createGroup('组',[child])];
  const patched=patchLayer(d,child.id,{locked:true});
  assert.equal(findNode(patched,child.id)?.locked,true);
  const cropped=cropDocument(patched,{x:100,y:50,width:500,height:400});
  assert.ok(isGroup(cropped.layers[0]));
  assert.equal(cropped.layers[0].x,-100);
  assert.equal(cropped.layers[0].y,-50);
  assert.equal(findNode(cropped,child.id)?.x,200);
  assert.equal(findNode(cropped,child.id)?.y,180);
});
test('group and ungroup keep sibling order; ungroup bakes group transform', () => {
  const d=createDocument();
  const a=createLayer(d,20,20,null,'A'), b=createLayer(d,20,20,null,'B');
  b.x=40; b.y=10;
  let doc:Document={...d,layers:[a,b]};
  doc=applyOperation(doc,{type:'layer.group',ids:[b.id]});
  assert.equal(doc.layers.length,2);
  assert.equal(isGroup(doc.layers[1]),true);
  const grouped=doc.layers[1];
  if(!isGroup(grouped))throw new Error('expected group');
  assert.equal(grouped.children[0].id,b.id);
  const group=grouped;
  doc=applyOperation(doc,{type:'layer.patch',id:group.id,patch:{x:100,y:50,scaleX:2}});
  doc=applyOperation(doc,{type:'layer.ungroup',id:group.id});
  assert.equal(doc.layers.length,2);
  assert.equal(doc.layers[1].id,b.id);
  assert.ok(isRaster(doc.layers[1]));
  assert.equal(doc.layers[1].x,180);
  assert.equal(doc.layers[1].y,60);
  assert.equal(doc.layers[1].scaleX,2);
});
test('reorder can move a raster into a group and refuse a cycle', () => {
  const d=createDocument();
  const child=createLayer(d,20,20,null,'子层');
  const group=createGroup('组');
  let doc:Document={...d,layers:[child,group]};
  doc=applyOperation(doc,{type:'layer.reorder',id:child.id,index:0,parentId:group.id});
  assert.equal(doc.layers.length,1);
  assert.ok(isGroup(doc.layers[0]));
  assert.equal(isGroup(doc.layers[0])&&doc.layers[0].children[0].id,child.id);
  assert.throws(()=>applyOperation(doc,{type:'layer.reorder',id:doc.layers[0].id,index:0,parentId:child.id}),/自身/);
});
test('new layers have no mask; empty legacy arrays stay without a mask', () => {
  const d=createDocument();
  const layer=createLayer(d,20,20,null,'A');
  assert.equal(layer.mask,null);
  const doc=validateDocument({...d,layers:[{...layer,mask:[]}]});
  assert.equal(doc.layers[0].mask,null);
});
test('legacy stroke arrays become an enabled Photoshop-style layer mask', () => {
  const d=createDocument();
  const layer=createLayer(d,20,20,null,'A');
  const stroke={points:[{x:1,y:1}],radius:4,hardness:1,opacity:1,color:'#ffffff',mode:'erase' as const};
  const doc=validateDocument({...d,layers:[{...layer,mask:[stroke]}]});
  assert.ok(doc.layers[0].mask);
  assert.equal(doc.layers[0].mask?.disabled,false);
  assert.equal(doc.layers[0].mask?.strokes.length,1);
});
test('add, disable and remove layer masks on rasters and groups', () => {
  const d=createDocument();
  const layer=createLayer(d,20,20,null,'A');
  let doc:Document={...d,layers:[layer]};
  doc=applyOperation(doc,{type:'layer.mask.add',id:layer.id});
  assert.ok(doc.layers[0].mask);
  assert.equal(doc.layers[0].mask?.disabled,false);
  assert.deepEqual(doc.layers[0].mask?.strokes,[]);
  doc=applyOperation(doc,{type:'layer.mask.disable',id:layer.id,disabled:true});
  assert.equal(doc.layers[0].mask?.disabled,true);
  doc=applyOperation(doc,{type:'layer.mask.remove',id:layer.id});
  assert.equal(doc.layers[0].mask,null);
  const group=createGroup('组');
  doc={...d,layers:[group]};
  doc=applyOperation(doc,{type:'layer.mask.add',id:group.id});
  assert.ok(doc.layers[0].mask);
});
test('painting a mask requires an existing layer mask', () => {
  const d=createDocument();
  const layer=createLayer(d,20,20,null,'A');
  const doc:Document={...d,layers:[layer]};
  const stroke={points:[{x:1,y:1}],radius:4,hardness:1,opacity:1,color:'#000000',mode:'paint' as const};
  assert.throws(()=>applyOperation(doc,{type:'stroke',id:layer.id,channel:'mask',stroke}),/蒙版/);
});
