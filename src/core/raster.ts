import { LIMITS, dimensions, fail, isIsolatedGroup, isRaster, maskEnabled, rasterLayers } from './model.ts';
import type { Asset, Document, GroupLayer, Layer, LayerMask, RasterLayer, Stroke } from './model.ts';

export function surface(width: number, height: number) { const c = document.createElement('canvas'); c.width = width; c.height = height; return c; }
export function context(c: HTMLCanvasElement) { const ctx = c.getContext('2d'); if (!ctx) fail('浏览器无法创建画布'); return ctx; }
export function toBlob(c: HTMLCanvasElement, type = 'image/png', quality = .92): Promise<Blob> {
  return new Promise((resolve,reject) => c.toBlob(b => b ? resolve(b) : reject(new Error('图片导出失败')),type,quality));
}
export class Assets {
  private entries = new Map<string, Asset>();
  private decoded = new Map<string, ImageBitmap>();
  get(id: string) { const a=this.entries.get(id); if (!a) fail('工程素材缺失','MISSING_ASSET'); return a; }
  bitmap(id: string) { const b=this.decoded.get(id); if (!b) fail('图片尚未加载','NOT_READY'); return b; }
  async prepare(blob: Blob, id: string = crypto.randomUUID()): Promise<{asset:Asset;bitmap:ImageBitmap}> {
    if (blob.size > LIMITS.fileBytes || !['image/png','image/jpeg','image/webp'].includes(blob.type)) fail('请选择 PNG、JPEG 或 WebP 图片（不超过 80 MB）');
    let bitmap: ImageBitmap;
    try { bitmap=await createImageBitmap(blob); } catch { fail('图片无法解码，请检查文件'); }
    try { dimensions(bitmap.width,bitmap.height); } catch(e) { bitmap.close(); throw e; }
    return {asset:{id,blob,width:bitmap.width,height:bitmap.height},bitmap};
  }
  accept(items: {asset:Asset;bitmap:ImageBitmap}[]) {
    for (const {asset,bitmap} of items) { this.decoded.get(asset.id)?.close(); this.entries.set(asset.id,asset); this.decoded.set(asset.id,bitmap); }
  }
  values(ids: Set<string>) { return [...ids].map(id=>this.get(id)); }
  collect(ids: Set<string>) { for (const [id,b] of this.decoded) if (!ids.has(id)) { b.close(); this.decoded.delete(id); this.entries.delete(id); } }
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, channel: 'paint' | 'mask' | 'inpaint' = 'paint') {
  if (!s.points.length) return;
  ctx.save();
  if (s.clip?.length) { ctx.beginPath(); s.clip.forEach((p,i)=> i ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y)); ctx.closePath(); ctx.clip(); }
  ctx.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : 'source-over';
  ctx.globalAlpha = s.opacity;
  const color=channel==='inpaint' ? '#ffffff' : s.color;
  if (s.hardness>=.999) {
    ctx.strokeStyle=color; ctx.fillStyle=color; ctx.lineWidth=s.radius*2; ctx.lineJoin='round';ctx.lineCap='round';
    ctx.beginPath();ctx.moveTo(s.points[0].x,s.points[0].y);for(const p of s.points.slice(1))ctx.lineTo(p.x,p.y);
    if(s.points.length===1){ctx.arc(s.points[0].x,s.points[0].y,s.radius,0,Math.PI*2);ctx.fill();}else ctx.stroke();
  } else {
    const r=parseInt(color.slice(1,3),16),g=parseInt(color.slice(3,5),16),b=parseInt(color.slice(5,7),16);
    const dab=(x:number,y:number)=>{ const gradient=ctx.createRadialGradient(x,y,s.radius*s.hardness,x,y,s.radius);gradient.addColorStop(0,color);gradient.addColorStop(1,`rgba(${r},${g},${b},0)`);ctx.fillStyle=gradient;ctx.fillRect(x-s.radius,y-s.radius,s.radius*2,s.radius*2); };
    dab(s.points[0].x,s.points[0].y);
    for(let i=1;i<s.points.length;i++){const a=s.points[i-1],b=s.points[i];const steps=Math.min(4096,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/Math.max(1,s.radius*.25)));for(let j=1;j<=steps;j++)dab(a.x+(b.x-a.x)*j/steps,a.y+(b.y-a.y)*j/steps);}
  }
  ctx.restore();
}

export class Rasterizer {
  private cache = new Map<string,{key:string;canvas:HTMLCanvasElement}>();
  assets: Assets;
  constructor(assets:Assets){this.assets=assets;}
  layer(l:RasterLayer) {
    const key=JSON.stringify([l.assetId,l.width,l.height,l.brightness,l.contrast,l.saturation,l.strokes,l.mask]);
    const cached=this.cache.get(l.id); if(cached?.key===key)return cached.canvas;
    const c=this.pixels(l);
    if(maskEnabled(l))this.applyMask(context(c),l.mask!,l.width,l.height);
    this.cache.set(l.id,{key,canvas:c}); return c;
  }
  pixels(l:RasterLayer) {
    const c=surface(l.width,l.height),ctx=context(c);
    if(l.assetId)ctx.drawImage(this.assets.bitmap(l.assetId),0,0,l.width,l.height);
    for(const s of l.strokes)drawStroke(ctx,s);
    if(l.brightness || l.contrast || l.saturation){
      const data=ctx.getImageData(0,0,l.width,l.height),p=data.data;
      const contrast=Math.pow(2,l.contrast*2), saturation=1+l.saturation;
      for(let i=0;i<p.length;i+=4){
        const gray=.2126*p[i]+.7152*p[i+1]+.0722*p[i+2];
        for(let ch=0;ch<3;ch++)p[i+ch]=((gray+(p[i+ch]-gray)*saturation)/255-.5)*contrast*255+127.5+l.brightness*255;
      }
      ctx.putImageData(data,0,0);
    }
    return c;
  }
  maskImage(mask:LayerMask,width:number,height:number){
    const m=surface(width,height),mc=context(m);mc.fillStyle='#fff';mc.fillRect(0,0,width,height);
    if(mask.assetId){mc.globalCompositeOperation='multiply';mc.drawImage(this.assets.bitmap(mask.assetId),0,0,width,height);mc.globalCompositeOperation='source-over';}
    for(const s of mask.strokes)drawStroke(mc,s,'mask');
    return m;
  }
  private applyMask(ctx:CanvasRenderingContext2D,mask:LayerMask,width:number,height:number){
    const m=this.maskImage(mask,width,height),image=context(m).getImageData(0,0,width,height),p=image.data;
    for(let i=0;i<p.length;i+=4){const a=.2126*p[i]+.7152*p[i+1]+.0722*p[i+2];p[i]=p[i+1]=p[i+2]=255;p[i+3]=a;}
    context(m).putImageData(image,0,0);
    ctx.globalCompositeOperation='destination-in';ctx.drawImage(m,0,0,width,height);ctx.globalCompositeOperation='source-over';
  }
  composite(doc:Document, background?:string) {
    const c=surface(doc.width,doc.height),ctx=context(c);
    if(background){ctx.fillStyle=background;ctx.fillRect(0,0,c.width,c.height);}
    this.drawNodes(doc.layers,ctx,doc.width,doc.height);
    return c;
  }
  private drawRaster(l:RasterLayer,ctx:CanvasRenderingContext2D){
    ctx.save();
    ctx.translate(l.x,l.y);ctx.rotate(l.rotation*Math.PI/180);ctx.scale(l.scaleX*(l.flipX?-1:1),l.scaleY*(l.flipY?-1:1));
    ctx.globalAlpha=l.opacity;ctx.globalCompositeOperation=l.blend;
    ctx.drawImage(this.layer(l),-l.width/2,-l.height/2);
    ctx.restore();
  }
  private applyGroupXform(ctx:CanvasRenderingContext2D,g:GroupLayer){
    ctx.translate(g.x,g.y);ctx.rotate(g.rotation*Math.PI/180);ctx.scale(g.scaleX*(g.flipX?-1:1),g.scaleY*(g.flipY?-1:1));
  }
  private mixGroup(current:HTMLCanvasElement,below:HTMLCanvasElement,opacity:number,mask:LayerMask|null,width:number,height:number){
    const mixed=surface(width,height),ctx=context(mixed);
    const c=context(current).getImageData(0,0,width,height).data;
    const b=context(below).getImageData(0,0,width,height).data;
    const m=mask&&!mask.disabled?context(this.maskImage(mask,width,height)).getImageData(0,0,width,height).data:null;
    const out=ctx.createImageData(width,height),p=out.data;
    for(let i=0;i<p.length;i+=4){
      const a=opacity*(m?(.2126*m[i]+.7152*m[i+1]+.0722*m[i+2])/255:1);
      p[i]=b[i]*(1-a)+c[i]*a;p[i+1]=b[i+1]*(1-a)+c[i+1]*a;p[i+2]=b[i+2]*(1-a)+c[i+2]*a;p[i+3]=b[i+3]*(1-a)+c[i+3]*a;
    }
    ctx.putImageData(out,0,0);
    const dest=context(current);dest.setTransform(1,0,0,1,0,0);dest.clearRect(0,0,width,height);dest.drawImage(mixed,0,0);
  }
  private drawNodes(nodes:Layer[],ctx:CanvasRenderingContext2D,width:number,height:number){
    for(const node of nodes){
      if(!node.visible)continue;
      if(isRaster(node)){this.drawRaster(node,ctx);continue;}
      const isolate=isIsolatedGroup(node),needsMix=node.opacity<1||maskEnabled(node);
      if(isolate){
        const buffer=surface(width,height),bctx=context(buffer);
        bctx.save();this.applyGroupXform(bctx,node);this.drawNodes(node.children,bctx,width,height);bctx.restore();
        if(maskEnabled(node))this.applyMask(bctx,node.mask!,width,height);
        ctx.save();ctx.globalAlpha=node.opacity;ctx.globalCompositeOperation=node.blend as GlobalCompositeOperation;ctx.drawImage(buffer,0,0);ctx.restore();
        continue;
      }
      const below=needsMix?surface(width,height):null;
      if(below)context(below).drawImage(ctx.canvas,0,0);
      ctx.save();this.applyGroupXform(ctx,node);this.drawNodes(node.children,ctx,width,height);ctx.restore();
      if(below)this.mixGroup(ctx.canvas,below,node.opacity,node.mask,width,height);
    }
  }
  mask(doc:Document, binary=true, overlay=false) {
    const c=surface(doc.width,doc.height),ctx=context(c);for(const s of doc.inpaint)drawStroke(ctx,s,'inpaint');
    const image=ctx.getImageData(0,0,c.width,c.height),p=image.data;
    for(let i=0;i<p.length;i+=4){const a=p[i+3];if(overlay){p[i]=255;p[i+1]=82;p[i+2]=103;p[i+3]=Math.round(a*.5);}else {const v=binary?(a>=128?255:0):a;p[i]=p[i+1]=p[i+2]=v;p[i+3]=255;}}
    ctx.putImageData(image,0,0);return c;
  }
  collect(doc:Document){const ids=new Set(rasterLayers(doc.layers).map(l=>l.id));for(const id of this.cache.keys())if(!ids.has(id))this.cache.delete(id);}
  clear(){this.cache.clear();}
}
