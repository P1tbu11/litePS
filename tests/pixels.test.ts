import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMaskColor, floodMask } from '../src/core/pixels.ts';

function rgba(width:number,height:number,color:[number,number,number,number]){
  const data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<width*height;i++){data[i*4]=color[0];data[i*4+1]=color[1];data[i*4+2]=color[2];data[i*4+3]=color[3];}
  return data;
}

test('contiguous flood stays inside the same color', () => {
  const src=rgba(4,4,[255,0,0,255]);
  src[(2*4+2)*4]=0;src[(2*4+2)*4+2]=255;
  const mask=floodMask(src,4,4,0,0,0,true);
  assert.equal(mask[0],255);
  assert.equal(mask[2*4+2],0);
  assert.equal(mask.filter(v=>v===255).length,15);
});
test('tolerance includes nearby colors', () => {
  const src=rgba(2,1,[10,0,0,255]);
  src[4]=20;src[5]=0;src[6]=0;src[7]=255;
  assert.equal(floodMask(src,2,1,0,0,5,true)[1],0);
  assert.equal(floodMask(src,2,1,0,0,20,true)[1],255);
});
test('non-contiguous flood selects every matching pixel', () => {
  const src=rgba(3,1,[255,0,0,255]);
  src[4]=0;src[5]=0;src[6]=255;src[7]=255;
  const mask=floodMask(src,3,1,0,0,0,false);
  assert.deepEqual([...mask],[255,0,255]);
});
test('applyMaskColor paints or erases only selected pixels', () => {
  const dest=rgba(2,1,[0,0,0,255]);
  applyMaskColor(dest,2,1,new Uint8Array([255,0]),[1,2,3,255]);
  assert.deepEqual([...dest],[1,2,3,255,0,0,0,255]);
  applyMaskColor(dest,2,1,new Uint8Array([255,0]),[0,0,0,0]);
  assert.equal(dest[3],0);
  assert.equal(dest[7],255);
});
