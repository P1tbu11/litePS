import { Canvas, FabricImage, Rect, Point as FabricPoint, filters } from 'fabric';
import type { Editor } from './core/editor.ts';
import { ancestors, composeOntoRaster, corners, eachRaster, findNode, isGroup, isRaster, localFromWorld, localPoint, needsDocumentComposite, patchLayer, setLayerMask } from './core/model.ts';
import { selectionBounds, selectionContours, selectionIsRect, spansFromMask, strokeClip } from './core/selection.ts';
import type { Selection } from './core/selection.ts';
import type { Combine } from './core/selection.ts';
import type { Document, GroupLayer, Layer, LayerPatch, Point, RasterLayer, Stroke, Box } from './core/model.ts';
import { context } from './core/raster.ts';

const LIVE_ADJUST=new Set(['opacity','brightness','contrast','saturation']);
function liveAdjust(patch:LayerPatch){return Object.keys(patch).length>0&&Object.keys(patch).every(k=>LIVE_ADJUST.has(k));}

type Gesture = {kind:'pan';last:Point} | {kind:'box';start:Point;current:Point} | {kind:'lasso';points:Point[];mode:Combine} | {kind:'stroke';layer:Layer;stroke:Stroke;channel:'paint'|'mask'};
function boxFrom(a:Point,b:Point){return {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)};}
function maskPaintColor(hex:string,erase:boolean,restore:boolean){
  if(erase)return restore?'#ffffff':'#000000';
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16),y=Math.round(.2126*r+.7152*g+.0722*b),h=y.toString(16).padStart(2,'0');
  return `#${h}${h}${h}`;
}
export class Viewport {
  canvas:Canvas;
  private editor:Editor;private host:HTMLElement;private board:HTMLElement;private overlay:HTMLCanvasElement;
  private objects=new Map<string,FabricImage>();private sheet:FabricImage|null=null;private gesture:Gesture|null=null;private space=false;private syncing=false;private frame=0;private antsTimer=0;private antsPhase=0;private disposed=false;
  private contourSel:Selection|null=null;private contours:Point[][]=[];
  private hover:Point|null=null;
  private observer:ResizeObserver;private unsubscribe:()=>void;private cleanup:(()=>void)[]=[];
  constructor(host:HTMLElement,element:HTMLCanvasElement,board:HTMLElement,overlay:HTMLCanvasElement,editor:Editor){
    this.editor=editor;this.host=host;this.board=board;this.overlay=overlay;
    this.canvas=new Canvas(element,{selection:false,enableRetinaScaling:true,preserveObjectStacking:true,uniformScaling:true,altActionKey:undefined,enablePointerEvents:true,renderOnAddRemove:false,stopContextMenu:true});
    this.canvas.on('selection:created',e=>{if(!this.syncing)this.selectObject(e.selected[0]);});
    this.canvas.on('selection:updated',e=>{if(!this.syncing)this.selectObject(e.selected[0]);});
    this.canvas.on('selection:cleared',()=>{if(!this.syncing&&editor.selected!==null)editor.select(null);});
    this.canvas.on('before:transform',()=>{editor.store.busy=true;editor.emit();});
    this.canvas.on('object:modified',e=>{editor.store.busy=false;const entry=[...this.objects].find(([,v])=>v===e.target);if(entry){const o=e.target;try{const local=localFromWorld({x:o.left,y:o.top,scaleX:o.scaleX,scaleY:o.scaleY,rotation:o.angle,flipX:o.flipX,flipY:o.flipY},ancestors(editor.doc,entry[0]));editor.execute([{type:'layer.patch',id:entry[0],patch:local}],'变换图层');}catch(err){editor.error(err);this.sync();}}editor.emit();});
    this.canvas.on('mouse:up',()=>{if(editor.store.busy&&!this.gesture){editor.store.busy=false;editor.emit();}});
    this.canvas.on('object:rotating',e=>{const event=e.e as PointerEvent;e.target.snapAngle=event.shiftKey?15:0;});
    this.canvas.on('after:render',()=>this.drawOverlay());
    const listen=(el:EventTarget,type:string,fn:EventListener,opts?:AddEventListenerOptions)=>{el.addEventListener(type,fn,opts);this.cleanup.push(()=>el.removeEventListener(type,fn,opts));};
    listen(host,'pointerdown',this.down as EventListener,{capture:true});listen(host,'pointermove',this.move as EventListener,{capture:true});listen(host,'pointerup',this.up as EventListener,{capture:true});listen(host,'pointercancel',this.cancel as EventListener,{capture:true});
    listen(host,'wheel',this.wheel as EventListener,{passive:false});
    listen(window,'keydown',((e:KeyboardEvent)=>{if(e.key==='Escape')this.cancel();if(e.code==='Space'&&!this.input(e.target)){this.space=true;this.canvas.defaultCursor='grab';e.preventDefault();}}) as EventListener);
    listen(window,'keyup',((e:KeyboardEvent)=>{if(e.code==='Space'){this.space=false;this.canvas.defaultCursor='default';}}) as EventListener);
    listen(window,'blur',(()=>{this.space=false;this.cancel();}) as EventListener);
    listen(host,'pointerleave',(()=>{if(!this.gesture){this.hover=null;this.drawOverlay();}}) as EventListener);
    this.observer=new ResizeObserver(()=>{const w=host.clientWidth,h=host.clientHeight;this.canvas.setDimensions({width:w,height:h});const ratio=devicePixelRatio||1;overlay.width=w*ratio;overlay.height=h*ratio;overlay.style.width=`${w}px`;overlay.style.height=`${h}px`;this.updateBoard();this.drawOverlay();});this.observer.observe(host);
    this.unsubscribe=editor.subscribe(()=>this.sync());editor.view=this;this.sync();requestAnimationFrame(()=>this.fit());
  }
  private input(target:EventTarget|null){return target instanceof HTMLElement&&!!target.closest('input,textarea,select,[contenteditable]');}
  private selectObject(object:unknown){const id=[...this.objects].find(([,o])=>o===object)?.[0]??null;if(id!==this.editor.selected)this.editor.select(id);}
  private scene(e:PointerEvent){const rect=this.host.getBoundingClientRect(),v=this.canvas.viewportTransform;return {x:(e.clientX-rect.left-v[4])/v[0],y:(e.clientY-rect.top-v[5])/v[3]};}
  private clamp(p:Point){return {x:Math.max(0,Math.min(this.editor.doc.width,p.x)),y:Math.max(0,Math.min(this.editor.doc.height,p.y))};}
  private setAdjustFilters(obj:FabricImage,brightness:number,contrast:number,saturation:number){
    if(!brightness&&!contrast&&!saturation){if(obj.filters.length){obj.filters=[];obj.applyFilters();}return;}
    const existing=obj.filters;
    if(existing[0] instanceof filters.Brightness&&existing[1] instanceof filters.Contrast&&existing[2] instanceof filters.Saturation){
      existing[0].brightness=brightness;existing[1].contrast=contrast;existing[2].saturation=saturation;
    }else obj.filters=[new filters.Brightness({brightness}),new filters.Contrast({contrast}),new filters.Saturation({saturation})];
    obj.applyFilters();
  }
  private previewAdjust(id:string,patch:LayerPatch){
    const layer=findNode(this.editor.doc,id),obj=this.objects.get(id);if(!layer||!isRaster(layer)||!obj)return;
    const visual={...layer,...patch};
    obj.set({opacity:visual.opacity});
    this.setAdjustFilters(obj,visual.brightness-layer.brightness,visual.contrast-layer.contrast,visual.saturation-layer.saturation);
  }
  private displayDoc(){
    let doc=this.editor.doc;
    const preview=this.editor.preview;
    if(preview&&findNode(doc,preview.id))doc=patchLayer(doc,preview.id,preview.patch);
    const g=this.gesture;
    if(g?.kind==='stroke'){
      if(g.channel==='paint'&&isRaster(g.layer))doc=patchLayer(doc,g.layer.id,{strokes:[...g.layer.strokes,g.stroke]});
      else if(g.channel==='mask'&&g.layer.mask)doc=setLayerMask(doc,g.layer.id,{...g.layer.mask,strokes:[...g.layer.mask.strokes,g.stroke]});
    }
    return doc;
  }
  private blit(doc:Document){
    const active=this.editor.active;
    const image=this.editor.viewMask&&this.editor.editingMask&&active?.mask
      ?this.editor.raster.maskImage(active.mask,isRaster(active)?active.width:doc.width,isRaster(active)?active.height:doc.height)
      :this.editor.raster.composite(doc);
    if(!this.sheet){this.sheet=new FabricImage(image,{originX:'left',originY:'top',left:0,top:0,selectable:false,evented:false,objectCaching:false});this.canvas.add(this.sheet);}
    else this.sheet.setElement(image);
    this.sheet.set({left:0,top:0,visible:true});this.sheet.setCoords();this.canvas.sendObjectToBack(this.sheet);
  }
  sync(){
    const preview=this.editor.preview;
    if(this.disposed)return;
    if(preview&&liveAdjust(preview.patch)&&this.objects.has(preview.id)&&!needsDocumentComposite(this.editor.doc.layers)){this.previewAdjust(preview.id,preview.patch);this.canvas.requestRenderAll();return;}
    if(this.editor.store.busy)return;this.syncing=true;
    const doc=this.displayDoc(),{tool}=this.editor,compose=needsDocumentComposite(doc.layers)||(this.editor.editingMask&&!!this.editor.active&&isGroup(this.editor.active));
    this.canvas.skipTargetFind=tool!=='move'||compose;this.canvas.defaultCursor=tool==='hand'?'grab':tool==='move'?'default':'crosshair';
    const rasters:RasterLayer[]=[];const stacked:GroupLayer[][]=[];
    eachRaster(doc.layers,(original,groups)=>{rasters.push(original);stacked.push(groups);});
    const ids=new Set(rasters.map(l=>l.id));for(const [id,obj] of this.objects)if(!ids.has(id)){this.canvas.remove(obj);this.objects.delete(id);}
    rasters.forEach((original,index)=>{
      const groups=stacked[index];
      const l=composeOntoRaster(original,groups);
      const image=this.editor.viewMask&&this.editor.editingMask&&original.mask?this.editor.raster.maskImage(original.mask,original.width,original.height):this.editor.raster.layer(original);let obj=this.objects.get(l.id);
      if(!obj){obj=new FabricImage(image,{originX:'center',originY:'center',objectCaching:false,cornerColor:'#ffffff',cornerStrokeColor:'#4b8fff',borderColor:'#4b8fff',cornerSize:8,transparentCorners:false,cornerStyle:'circle',padding:0,strokeWidth:0,lockSkewingX:true,lockSkewingY:true,minScaleLimit:.001});this.objects.set(l.id,obj);this.canvas.add(obj);}
      else if(!compose&&obj.getElement()!==image)obj.setElement(image);
      this.setAdjustFilters(obj,0,0,0);
      const locked=original.locked||groups.some(g=>g.locked);
      obj.set({left:l.x,top:l.y,scaleX:l.scaleX,scaleY:l.scaleY,angle:l.rotation,flipX:l.flipX,flipY:l.flipY,visible:!compose&&original.visible&&groups.every(g=>g.visible),opacity:groups.reduce((n,g)=>n*g.opacity,original.opacity),globalCompositeOperation:original.blend,evented:!compose&&!locked,selectable:!compose&&!locked&&tool==='move'});obj.setCoords();this.canvas.moveObjectTo(obj,index);
    });
    if(compose)this.blit(doc);else if(this.sheet)this.sheet.visible=false;
    this.canvas.clipPath=new Rect({left:0,top:0,width:doc.width,height:doc.height,originX:'left',originY:'top',absolutePositioned:true});
    const active=this.editor.selected?this.objects.get(this.editor.selected):undefined;
    if(active&&active.selectable&&active.visible){if(this.canvas.getActiveObject()!==active)this.canvas.setActiveObject(active);}else this.canvas.discardActiveObject();
    this.syncing=false;this.updateBoard();this.canvas.requestRenderAll();
  }
  fit(){const d=this.editor.doc,w=this.host.clientWidth,h=this.host.clientHeight;const scale=Math.min((w-88)/d.width,(h-88)/d.height,1);this.canvas.setViewportTransform([Math.max(.025,scale),0,0,Math.max(.025,scale),(w-d.width*scale)/2,(h-d.height*scale)/2]);this.changedView();}
  zoomTo(n:number){this.canvas.zoomToPoint(new FabricPoint(this.host.clientWidth/2,this.host.clientHeight/2),Math.min(8,Math.max(.025,n)));this.changedView();}
  private changedView(){this.editor.zoom=this.canvas.getZoom();this.updateBoard();this.canvas.requestRenderAll();this.editor.emit();}
  private updateBoard(){const v=this.canvas.viewportTransform,d=this.editor.doc;this.board.style.width=`${d.width}px`;this.board.style.height=`${d.height}px`;this.board.style.transform=`translate(${v[4]}px,${v[5]}px) scale(${v[0]})`;}
  private wheel=(e:WheelEvent)=>{if(this.gesture||this.editor.busy)return;e.preventDefault();const v=this.canvas.viewportTransform;if(e.ctrlKey||e.metaKey||e.altKey){const r=this.host.getBoundingClientRect();this.canvas.zoomToPoint(new FabricPoint(e.clientX-r.left,e.clientY-r.top),Math.min(8,Math.max(.025,this.canvas.getZoom()*Math.exp(-e.deltaY*.003))));}else{v[4]-=e.deltaX;v[5]-=e.deltaY;this.canvas.setViewportTransform(v);}this.changedView();};
  private down=(e:PointerEvent)=>{
    if(e.button!==0&&e.button!==1)return;
    if(this.editor.busy||!this.editor.ready){e.stopPropagation();return;}
    const editor=this.editor,p=this.scene(e),tool=editor.tool;
    if(this.space||e.button===1||tool==='hand')this.gesture={kind:'pan',last:{x:e.clientX,y:e.clientY}};
    else if(tool==='move')return;
    else if(tool==='eyedropper'){
      if(p.x>=0&&p.y>=0&&p.x<editor.doc.width&&p.y<editor.doc.height){const pixel=context(editor.raster.composite(editor.doc)).getImageData(Math.floor(p.x),Math.floor(p.y),1,1).data;editor.brush.color=`#${[...pixel.slice(0,3)].map(x=>x.toString(16).padStart(2,'0')).join('')}`;editor.emit();}e.preventDefault();e.stopPropagation();return;
    }else if(tool==='wand'){
      try{editor.pickWand(p,e.shiftKey?'add':e.altKey?'subtract':'replace');}catch(err){editor.error(err);}e.preventDefault();e.stopPropagation();return;
    }else if(tool==='fill'){
      void editor.bucket(p).catch(err=>editor.error(err));e.preventDefault();e.stopPropagation();return;
    }else if(tool==='lasso')this.gesture={kind:'lasso',points:[this.clamp(p)],mode:e.shiftKey?'add':e.altKey?'subtract':'replace'};
    else if(tool==='select'||tool==='crop')this.gesture={kind:'box',start:this.clamp(p),current:this.clamp(p)};
    else{
      const layer=editor.active;const onMask=!!(editor.editingMask&&layer?.mask);
      if(!layer||layer.locked||!layer.visible){editor.toast('请先选中可编辑的可见图层','error');e.stopPropagation();return;}
      if(!onMask&&!isRaster(layer)){editor.toast('请先选中图像图层','error');e.stopPropagation();return;}
      if(onMask&&!layer.mask){editor.toast('请先添加图层蒙版','error');e.stopPropagation();return;}
      const world=isRaster(layer)?composeOntoRaster(layer,ancestors(editor.doc,layer.id)):null;
      const point=world?localPoint(p,world):p,scale=world?Math.sqrt(world.scaleX*world.scaleY):1;
      const color=onMask?maskPaintColor(editor.brush.color,tool==='erase',editor.brush.restore):editor.brush.color;
      const clip=!editor.selection?{}:isRaster(layer)?strokeClip(editor.selection,layer,ancestors(editor.doc,layer.id)):selectionIsRect(editor.selection)&&selectionBounds(editor.selection)?{clip:corners(selectionBounds(editor.selection)!)}:{spans:spansFromMask(editor.selection.data,editor.selection.width,editor.selection.height)};
      const s:Stroke={points:[point],radius:editor.brush.radius/scale,hardness:editor.brush.hardness,opacity:editor.brush.opacity,color,mode:tool==='erase'?(editor.brush.restore?'restore':'erase'):'paint',...clip};
      this.gesture={kind:'stroke',layer,stroke:s,channel:onMask?'mask':'paint'};
    }
    editor.store.busy=true;editor.emit();e.preventDefault();e.stopPropagation();this.host.setPointerCapture(e.pointerId);this.preview();
  };
  private move=(e:PointerEvent)=>{this.hover=this.scene(e);const g=this.gesture;if(!g){if(['brush','erase'].includes(this.editor.tool))this.preview();return;}e.preventDefault();e.stopPropagation();
    if(g.kind==='pan'){const v=this.canvas.viewportTransform;v[4]+=e.clientX-g.last.x;v[5]+=e.clientY-g.last.y;g.last={x:e.clientX,y:e.clientY};this.canvas.setViewportTransform(v);this.changedView();}
    else if(g.kind==='box'){g.current=this.clamp(this.scene(e));this.drawOverlay();}
    else if(g.kind==='lasso'){const p=this.clamp(this.scene(e)),last=g.points.at(-1)!;if(Math.hypot(p.x-last.x,p.y-last.y)>.8){g.points.push(p);if(g.points.length>12000){this.up(e);return;}this.drawOverlay();}}
    else{const p=this.scene(e),world=isRaster(g.layer)?composeOntoRaster(g.layer,ancestors(this.editor.doc,g.layer.id)):null,point=world?localPoint(p,world):p,last=g.stroke.points.at(-1)!;if(Math.hypot(point.x-last.x,point.y-last.y)>.5)g.stroke.points.push(point);if(g.stroke.points.length>12000){this.up(e);return;}this.preview();}
  };
  private preview(){if(this.frame)return;this.frame=requestAnimationFrame(()=>{this.frame=0;const g=this.gesture;if(g?.kind==='stroke'){const doc=this.displayDoc();if(needsDocumentComposite(doc.layers)||isGroup(g.layer))this.blit(doc);else if(isRaster(g.layer)){const next=g.channel==='mask'&&g.layer.mask?{...g.layer,mask:{...g.layer.mask,strokes:[...g.layer.mask.strokes,g.stroke]}}:{...g.layer,strokes:[...g.layer.strokes,g.stroke]};this.objects.get(g.layer.id)?.setElement(this.editor.raster.layer(next));}this.canvas.requestRenderAll();}this.drawOverlay();});}
  private up=(e:PointerEvent)=>{const g=this.gesture;if(!g)return;e.preventDefault();e.stopPropagation();if(this.host.hasPointerCapture(e.pointerId))this.host.releasePointerCapture(e.pointerId);this.gesture=null;this.editor.store.busy=false;
    if(g.kind==='stroke'){try{this.editor.execute([{type:'stroke',id:g.layer?.id,channel:g.channel,stroke:g.stroke}],g.channel==='mask'?'修改图层蒙版':'画笔');}catch(err){this.editor.error(err);}}
    else if(g.kind==='box'){const box=boxFrom(g.start,g.current);this.editor.setSelection(box.width<1||box.height<1?null:box);}
    else if(g.kind==='lasso')this.editor.closeLasso(g.points,g.mode);
    this.editor.emit();this.sync();
  };
  cancel=()=>{if(!this.gesture)return;this.gesture=null;this.editor.store.busy=false;this.editor.emit();this.sync();};
  private drawOverlay(){
    const ctx=context(this.overlay),ratio=devicePixelRatio||1,v=this.canvas.viewportTransform,editor=this.editor;ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,this.overlay.width,this.overlay.height);ctx.setTransform(ratio*v[0],0,0,ratio*v[3],ratio*v[4],ratio*v[5]);
    const zoom=v[0],dash=4/zoom,ants=()=>{ctx.lineWidth=1/zoom;ctx.setLineDash([]);ctx.lineDashOffset=0;ctx.strokeStyle='#fff';ctx.stroke();ctx.setLineDash([dash,dash]);ctx.lineDashOffset=-this.antsPhase/zoom;ctx.strokeStyle='#202124';ctx.stroke();ctx.setLineDash([]);ctx.lineDashOffset=0;};
    const lasso=this.gesture?.kind==='lasso'?this.gesture.points:null;
    if(lasso&&lasso.length){ctx.beginPath();ctx.moveTo(lasso[0].x,lasso[0].y);for(const p of lasso.slice(1))ctx.lineTo(p.x,p.y);ctx.closePath();ants();}
    const drag=this.gesture?.kind==='box'?boxFrom(this.gesture.start,this.gesture.current):null;
    const sel=editor.selection,box=drag??(sel&&!lasso&&selectionIsRect(sel)?selectionBounds(sel):null);
    if(sel&&!drag&&!lasso){
      if(sel!==this.contourSel){this.contourSel=sel;this.contours=selectionIsRect(sel)?[]:selectionContours(sel);}
      for(const ring of this.contours){ctx.beginPath();ctx.moveTo(ring[0].x,ring[0].y);for(const p of ring.slice(1))ctx.lineTo(p.x,p.y);ants();}
    }else if(sel!==this.contourSel){this.contourSel=null;this.contours=[];}
    if(box){ctx.beginPath();ctx.rect(box.x,box.y,box.width,box.height);ants();if(editor.tool==='crop'){ctx.fillStyle='rgba(0,0,0,.48)';ctx.beginPath();ctx.rect(0,0,editor.doc.width,editor.doc.height);ctx.rect(box.x,box.y,box.width,box.height);ctx.fill('evenodd');}}
    if(this.hover&&['brush','erase'].includes(editor.tool)){ctx.beginPath();ctx.arc(this.hover.x,this.hover.y,editor.brush.radius,0,Math.PI*2);ctx.strokeStyle='#0009';ctx.lineWidth=2/v[0];ctx.stroke();ctx.strokeStyle='#fff';ctx.lineWidth=1/v[0];ctx.stroke();}
    if((sel||lasso||drag)&&!this.antsTimer)this.antsTimer=window.setTimeout(()=>{this.antsTimer=0;if(this.disposed||!(this.editor.selection||this.gesture))return;this.antsPhase=(this.antsPhase+1)%8;this.drawOverlay();},80);
  }
  dispose(){this.disposed=true;this.cleanup.forEach(fn=>fn());this.unsubscribe();this.observer.disconnect();cancelAnimationFrame(this.frame);clearTimeout(this.antsTimer);this.editor.view=null;void this.canvas.dispose();}
}
