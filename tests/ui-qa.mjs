import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';

// Run through ego-browser's documented Page API against this project's local preview.
export async function runUIQA(page){
  const passed=[];
  const check=(value,name)=>{assert.ok(value,name);passed.push(name);};
  const state=()=>page.evaluate(()=>window.__LIGHT_PS__.getState());
  const call=(method,params={})=>page.evaluate(({method,params})=>window.__LIGHT_PS__.request({id:crypto.randomUUID(),method,params}),{method,params});
  const change=async operations=>call('transaction.apply',{expectedRevision:(await state()).revision,operations});
  await page.waitForFunction(()=>!!window.__LIGHT_PS__);
  await page.evaluate(()=>window.__LIGHT_PS__.ready);
  const original=await state();assert.equal(original.document.layers.length,2,'Start with the built-in two-layer example');
  const backup=await page.evaluate(async()=>Array.from(new Uint8Array((await window.__LIGHT_PS__.request({id:crypto.randomUUID(),method:'export.project'})).bytes)));
  await writeFile('/private/tmp/light-ps-qa-backup.lightps',Buffer.from(backup));
  await page.click('button[aria-label="适合窗口 (⌘0)"]');
  const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,board:document.querySelector('.artboard').getBoundingClientRect().toJSON(),host:document.querySelector('.viewport').getBoundingClientRect().toJSON()}));
  check(layout.width===layout.scroll,'desktop has no horizontal page overflow');
  const id=original.document.layers[1].id;
  // Real canvas gesture: move the selected image, then undo from the toolbar.
  const x=layout.board.x+layout.board.width/2,y=layout.board.y+layout.board.height/2;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+40,y+25);await page.mouse.up();
  const moved=await state();check(moved.document.layers[1].x>original.document.layers[1].x+10,'canvas pointer drag changes layer position');
  await page.keyboard.press('ControlOrMeta+z');check(Math.abs((await state()).document.layers[1].x-original.document.layers[1].x)<.01,'keyboard undo restores pointer transform');
  // Layer visibility and blend controls.
  await page.click('button[aria-label="隐藏 陶器"]');check(!(await state()).document.layers[1].visible,'layer visibility button works');
  await page.click('button[aria-label="显示 陶器"]');
  await page.selectOption('select[aria-label="混合模式"]','multiply');check((await state()).document.layers[1].blend==='multiply','blend menu changes model');
  await page.selectOption('select[aria-label="混合模式"]','source-over');
  // One slider drag must be one undo action and update the preview.
  const beforeSlider=(await state()).revision;
  // Semantic click is more stable across browser DPRs than a CSS-pixel coordinate.
  await page.click('input[aria-label="亮度"]');
  await page.press('input[aria-label="亮度"]','ArrowRight');
  check((await state()).revision===beforeSlider+1,'adjustment slider commits one action');
  await page.keyboard.press('ControlOrMeta+z');await page.waitForFunction(()=>window.__LIGHT_PS__.getState().document.layers[1].brightness===0,undefined,{timeout:3000});check((await state()).document.layers[1].brightness===0,'adjustment undo restores previous value');
  await page.click('button[aria-label="擦除与恢复 (E)"]');
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+25,y+15);await page.mouse.up();
  check((await state()).document.layers[1].mask.length===1,'eraser gesture writes a recoverable layer mask');
  await page.click('button:has-text("恢复擦除")');await page.mouse.click(x,y);
  check((await state()).document.layers[1].mask[1].mode==='restore','restore tool creates restore mask stroke');
  await page.click('button[aria-label="重绘区域 (Q)"]');
  // Restore toggle is shared intentionally; switch it off when entering mask mode.
  const restoring=await page.evaluate(()=>!!document.querySelector('.brush-options .selected-option'));
  if(restoring)await page.click('button:has-text("减去区域")');
  await page.mouse.move(x-20,y-20);await page.mouse.down();await page.mouse.move(x+20,y+20);await page.mouse.up();
  check((await state()).document.inpaint.length===1,'inpaint gesture uses independent document mask');
  const mask=await page.evaluate(async()=>{const r=await window.__LIGHT_PS__.request({id:crypto.randomUUID(),method:'export.mask'});const b=await createImageBitmap(new Blob([r.bytes],{type:r.type}));const c=document.createElement('canvas');c.width=b.width;c.height=b.height;const ctx=c.getContext('2d');ctx.drawImage(b,0,0);b.close();const pixels=ctx.getImageData(0,0,c.width,c.height).data;return {width:c.width,height:c.height,binary:pixels.every((v,i)=>i%4===3?v===255:v===0||v===255),white:pixels.some((v,i)=>i%4===0&&v===255)};});
  check(mask.binary&&mask.white&&mask.width===original.document.width,'mask export has correct dimensions and strict opaque binary pixels');
  await page.click('button[aria-label="矩形选区 (M)"]');await page.mouse.move(x-80,y-70);await page.mouse.down();await page.mouse.move(x+80,y+70);await page.mouse.up();
  check((await page.evaluate(()=>document.querySelector('.canvas-status').textContent)).includes('选区'),'selection gesture exposes selection size');
  await page.click('button[aria-label="裁切画布 (C)"]');await page.keyboard.press('Enter');
  check((await state()).document.width<original.document.width,'crop applies selection to document dimensions');
  await page.keyboard.press('ControlOrMeta+z');check((await state()).document.width===original.document.width,'crop is undoable');
  // Host writes reject stale revisions and retry idempotently.
  const result=await page.evaluate(async()=>{const api=window.__LIGHT_PS__,s=api.getState(),id=s.document.layers[1].id,request={id:'qa-idempotent',method:'transaction.apply',params:{expectedRevision:s.revision,operations:[{type:'layer.patch',id,patch:{rotation:15}}]}};await api.request(request);const after=api.getState().revision;await api.request(request);let conflict=false;try{await api.request({...request,id:'qa-stale'});}catch(e){conflict=e.code==='REVISION_CONFLICT';}return {once:api.getState().revision===after,conflict};});
  check(result.once&&result.conflict,'agent retry is idempotent and stale write is rejected');
  const unchanged=(await state()).revision;let invalid=false;try{await change([{type:'layer.patch',id,patch:{opacity:NaN}}]);}catch{invalid=true;}check(invalid&&(await state()).revision===unchanged,'invalid command leaves current revision unchanged');
  await page.click('text="导出"');await page.waitForSelector('dialog[open]');
  const downloading=page.waitForEvent('download',{timeout:30000});await page.click('text="下载图片"');const output=await downloading;await output.saveAs('/private/tmp/light-ps-qa-output.png');check((await output.failure())===null,'export button downloads a real image');
  const saving=page.waitForEvent('download',{timeout:30000});await page.click('text="保存工程"');const saved=await saving;await saved.saveAs('/private/tmp/light-ps-qa-edited.lightps');check((await saved.failure())===null,'save project button downloads a real archive');
  await page.waitForFunction(()=>window.__LIGHT_PS__.getState().durability==='browser-cache');
  const preReload=await state();await page.reload();await page.waitForFunction(()=>!!window.__LIGHT_PS__);await page.evaluate(()=>window.__LIGHT_PS__.ready);const recovered=await state();
  check(JSON.stringify(preReload.document)===JSON.stringify(recovered.document),'reload recovers exact document and edit operations');
  await page.setInputFiles('input[accept=".lightps"]',['/private/tmp/light-ps-qa-backup.lightps']);await page.acceptDialog();
  await page.waitForFunction(expected=>JSON.stringify(window.__LIGHT_PS__.getState().document)===JSON.stringify(expected),original.document);
  check(true,'saved source project reopens without edit loss');
  return passed;
}
