import test from 'node:test';
import assert from 'node:assert/strict';
import { combineSelections, invertSelection, selectionBounds, selectionContours, selectionFromPolygon, selectionFromRect, selectionIsEmpty } from '../src/core/selection.ts';

test('a rect selection covers its box and reports bounds', () => {
  const s=selectionFromRect(10,8,{x:2,y:1,width:4,height:3});
  assert.equal(selectionIsEmpty(s),false);
  assert.deepEqual(selectionBounds(s),{x:2,y:1,width:4,height:3});
  assert.equal(s.data[1*10+2],255);
  assert.equal(s.data[0],0);
});
test('invert selection reveals every unselected document pixel', () => {
  const s=selectionFromRect(4,2,{x:0,y:0,width:2,height:1});
  const inv=invertSelection(s);
  assert.equal(inv.data[0],0);
  assert.equal(inv.data[2],255);
  assert.equal(inv.data[4],255);
  assert.deepEqual(selectionBounds(inv),{x:0,y:0,width:4,height:2});
});
test('a closed lasso polygon fills its interior', () => {
  const s=selectionFromPolygon(6,6,[{x:1,y:1},{x:5,y:1},{x:5,y:5},{x:1,y:5}]);
  assert.equal(selectionIsEmpty(s),false);
  assert.equal(s.data[2*6+2],255);
  assert.equal(s.data[0],0);
  assert.deepEqual(selectionBounds(s),{x:1,y:1,width:4,height:4});
});
function sameRing(a:{x:number;y:number}[],b:{x:number;y:number}[]){
  const as=a[0].x===a.at(-1)!.x&&a[0].y===a.at(-1)!.y?a.slice(0,-1):a;
  const bs=b[0].x===b.at(-1)!.x&&b[0].y===b.at(-1)!.y?b.slice(0,-1):b;
  if(as.length!==bs.length)return false;
  const i=as.findIndex(p=>p.x===bs[0].x&&p.y===bs[0].y);if(i<0)return false;
  const rot=[...as.slice(i),...as.slice(0,i)];
  const rev=[rot[0],...rot.slice(1).reverse()];
  return rot.every((p,n)=>p.x===bs[n].x&&p.y===bs[n].y)||rev.every((p,n)=>p.x===bs[n].x&&p.y===bs[n].y);
}
test('lasso contours follow the filled outline, including holes', () => {
  const box=selectionFromPolygon(6,6,[{x:1,y:1},{x:5,y:1},{x:5,y:5},{x:1,y:5}]);
  const rings=selectionContours(box);
  assert.equal(rings.length,1);
  assert.equal(sameRing(rings[0],[{x:1,y:1},{x:5,y:1},{x:5,y:5},{x:1,y:5}]),true);
  const punched=selectionFromRect(5,5,{x:0,y:0,width:5,height:5});
  punched.data[2*5+2]=0;
  assert.equal(selectionContours(punched).length,2);
});
test('selections combine with add subtract and intersect', () => {
  const a=selectionFromRect(8,8,{x:0,y:0,width:4,height:4});
  const b=selectionFromRect(8,8,{x:2,y:2,width:4,height:4});
  const add=combineSelections(a,b,'add');
  assert.equal(add.data[0],255);
  assert.equal(add.data[5*8+5],255);
  const sub=combineSelections(a,b,'subtract');
  assert.equal(sub.data[0],255);
  assert.equal(sub.data[3*8+3],0);
  const hit=combineSelections(a,b,'intersect');
  assert.equal(hit.data[0],0);
  assert.equal(hit.data[2*8+2],255);
});
