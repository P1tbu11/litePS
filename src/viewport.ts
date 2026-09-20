import { Canvas, FabricImage, Rect, Point as FabricPoint } from 'fabric';
import type { Editor } from './core/editor.ts';
import { corners, localPoint } from './core/model.ts';
import type { Layer, Point, Stroke, Box } from './core/model.ts';
import { context } from './core/raster.ts';

type Gesture = {kind:'pan';last:Point} | {kind:'box';start:Point} | {kind:'stroke';layer:Layer|null;stroke:Stroke;channel:'paint'|'mask'|'inpaint'};
export class Viewport {
  canvas:Canvas;
  private editor:Editor;private host:HTMLElement;private board:HTMLElement;private overlay:HTMLCanvasElement;
  private objects=new Map<string,FabricImage>();private gesture:Gesture|null=null;private space=false;private syncing=false;private frame=0;private disposed=false;
  private hover:Point|null=null;private maskCache:{key:string;canvas:HTMLCanvasElement}|null=null;
  private observer:ResizeObserver;private unsubscribe:()=>void;private cleanup:(()=>void)[]=[];
  constructor(host:HTMLElement,element:HTMLCanvasElement,board:HTMLElement,overlay:HTMLCanvasElement,editor:Editor){
    this.editor=editor;this.host=host;this.board=board;this.overlay=overlay;
    this.canvas=new Canvas(element,{selection:false,enableRetinaScaling:true,preserveObjectStacking:true,uniformScaling:true,altActionKey:undefined,enablePointerEvents:true,renderOnAddRemove:false,stopContextMenu:true});
    this.canvas.on('selection:created',e=>{if(!this.syncing)this.selectObject(e.selected[0]);});
    this.canvas.on('selection:updated',e=>{if(!this.syncing)this.selectObject(e.selected[0]);});
    this.canvas.on('selection:cleared',()=>{if(!this.syncing&&editor.selected!==null)editor.select(null);});
    this.canvas.on('before:transform',()=>{editor.store.busy=true;editor.emit();});
    this.canvas.on('object:modified',e=>{editor.store.busy=false;const entry=[...this.objects].find(([,v])=>v===e.target);if(entry){const o=e.target;try{editor.execute([{type:'layer.patch',id:entry[0],patch:{x:o.left,y:o.top,scaleX:o.scaleX,scaleY:o.scaleY,rotation:o.angle,flipX:o.flipX,flipY:o.flipY}}],'变换图层');}catch(err){editor.error(err);this.sync();}}editor.emit();});
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
  sync(){
    if(this.disposed||this.editor.store.busy)return;this.syncing=true;
    const {doc,tool}=this.editor;this.canvas.skipTargetFind=tool!=='move';this.canvas.defaultCursor=tool==='hand'?'grab':tool==='move'?'default':'crosshair';
    const ids=new Set(doc.layers.map(l=>l.id));for(const [id,obj] of this.objects)if(!ids.has(id)){this.canvas.remove(obj);this.objects.delete(id);}
    doc.layers.forEach((original,index)=>{
      const l=this.editor.preview?.id===original.id?{...original,...this.editor.preview.patch}:original;
      const image=this.editor.raster.layer(l);let obj=this.objects.get(l.id);
      if(!obj){obj=new FabricImage(image,{originX:'center',originY:'center',objectCaching:false,cornerColor:'#ffffff',cornerStrokeColor:'#4b8fff',borderColor:'#4b8fff',cornerSize:8,transparentCorners:false,cornerStyle:'circle',padding:0,strokeWidth:0,lockSkewingX:true,lockSkewingY:true,minScaleLimit:.001});this.objects.set(l.id,obj);this.canvas.add(obj);}
      else if(obj.getElement()!==image)obj.setElement(image);
      obj.set({left:l.x,top:l.y,scaleX:l.scaleX,scaleY:l.scaleY,angle:l.rotation,flipX:l.flipX,flipY:l.flipY,visible:l.visible,opacity:l.opacity,globalCompositeOperation:l.blend,evented:!l.locked,selectable:!l.locked&&tool==='move'});obj.setCoords();this.canvas.moveObjectTo(obj,index);
    });
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
    }else if(tool==='select'||tool==='crop')this.gesture={kind:'box',start:this.clamp(p)};
    else{
      const layer=tool==='mask'?null:editor.active;if(tool!=='mask'&&(!layer||layer.locked||!layer.visible)){editor.toast('请先选中可编辑的可见图层','error');e.stopPropagation();return;}
      const point=layer?localPoint(p,layer):p,scale=layer?Math.sqrt(layer.scaleX*layer.scaleY):1;
      const s:Stroke={points:[point],radius:editor.brush.radius/scale,hardness:editor.brush.hardness,opacity:editor.brush.opacity,color:editor.brush.color,mode:tool==='erase'?(editor.brush.restore?'restore':'erase'):tool==='mask'&&editor.brush.restore?'erase':'paint',...(editor.selection?{clip:corners(editor.selection).map(p=>layer?localPoint(p,layer):p)}:{})};
      this.gesture={kind:'stroke',layer:layer??null,stroke:s,channel:tool==='mask'?'inpaint':tool==='erase'?'mask':'paint'};
    }
    editor.store.busy=true;editor.emit();e.preventDefault();e.stopPropagation();this.host.setPointerCapture(e.pointerId);this.preview();
  };
  private move=(e:PointerEvent)=>{this.hover=this.scene(e);const g=this.gesture;if(!g){if(['brush','erase','mask'].includes(this.editor.tool))this.preview();return;}e.preventDefault();e.stopPropagation();
    if(g.kind==='pan'){const v=this.canvas.viewportTransform;v[4]+=e.clientX-g.last.x;v[5]+=e.clientY-g.last.y;g.last={x:e.clientX,y:e.clientY};this.canvas.setViewportTransform(v);this.changedView();}
    else if(g.kind==='box'){const p=this.clamp(this.scene(e));this.editor.selection={x:Math.min(g.start.x,p.x),y:Math.min(g.start.y,p.y),width:Math.abs(p.x-g.start.x),height:Math.abs(p.y-g.start.y)};this.editor.emit();this.drawOverlay();}
    else{const p=this.scene(e),point=g.layer?localPoint(p,g.layer):p,last=g.stroke.points.at(-1)!;if(Math.hypot(point.x-last.x,point.y-last.y)>.5)g.stroke.points.push(point);if(g.stroke.points.length>12000){this.up(e);return;}this.preview();}
  };
  private preview(){if(this.frame)return;this.frame=requestAnimationFrame(()=>{this.frame=0;const g=this.gesture;if(g?.kind==='stroke'&&g.layer){const key=g.channel==='paint'?'strokes':'mask';const canvas=this.editor.raster.layer({...g.layer,[key]:[...g.layer[key],g.stroke]});this.objects.get(g.layer.id)?.setElement(canvas);this.canvas.requestRenderAll();}this.drawOverlay();});}
  private up=(e:PointerEvent)=>{const g=this.gesture;if(!g)return;e.preventDefault();e.stopPropagation();if(this.host.hasPointerCapture(e.pointerId))this.host.releasePointerCapture(e.pointerId);this.gesture=null;this.editor.store.busy=false;
    if(g.kind==='stroke'){try{this.editor.execute([{type:'stroke',id:g.layer?.id,channel:g.channel,stroke:g.stroke}],g.channel==='inpaint'?'绘制重绘区域':g.channel==='mask'?'修改图层蒙版':'画笔');}catch(err){this.editor.error(err);}}
    else if(g.kind==='box'&&this.editor.selection&&(this.editor.selection.width<1||this.editor.selection.height<1))this.editor.selection=null;
    this.editor.emit();this.sync();
  };
  cancel=()=>{if(!this.gesture)return;this.gesture=null;this.editor.store.busy=false;this.editor.emit();this.sync();};
  private drawOverlay(){
    const ctx=context(this.overlay),ratio=devicePixelRatio||1,v=this.canvas.viewportTransform,editor=this.editor;ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,this.overlay.width,this.overlay.height);ctx.setTransform(ratio*v[0],0,0,ratio*v[3],ratio*v[4],ratio*v[5]);
    if(editor.tool==='mask'){
      const g=this.gesture,doc=g?.kind==='stroke'&&g.channel==='inpaint'?{...editor.doc,inpaint:[...editor.doc.inpaint,g.stroke]}:editor.doc;
      const key=JSON.stringify([doc.width,doc.height,doc.inpaint]);if(this.maskCache?.key!==key)this.maskCache={key,canvas:editor.raster.mask(doc,false,true)};
      ctx.drawImage(this.maskCache.canvas,0,0);
    }
    const box=editor.selection;if(box){ctx.lineWidth=1/v[0];ctx.strokeStyle='#fff';ctx.strokeRect(box.x,box.y,box.width,box.height);ctx.setLineDash([4/v[0],4/v[0]]);ctx.strokeStyle='#202124';ctx.strokeRect(box.x,box.y,box.width,box.height);ctx.setLineDash([]);if(editor.tool==='crop'){ctx.fillStyle='rgba(0,0,0,.48)';ctx.beginPath();ctx.rect(0,0,editor.doc.width,editor.doc.height);ctx.rect(box.x,box.y,box.width,box.height);ctx.fill('evenodd');}}
    if(this.hover&&['brush','erase','mask'].includes(editor.tool)){ctx.beginPath();ctx.arc(this.hover.x,this.hover.y,editor.brush.radius,0,Math.PI*2);ctx.strokeStyle='#0009';ctx.lineWidth=2/v[0];ctx.stroke();ctx.strokeStyle='#fff';ctx.lineWidth=1/v[0];ctx.stroke();}
  }
  dispose(){this.disposed=true;this.cleanup.forEach(fn=>fn());this.unsubscribe();this.observer.disconnect();cancelAnimationFrame(this.frame);this.editor.view=null;void this.canvas.dispose();}
}
