import { LIMITS, dimensions, fail } from './model.ts';
import type { Asset, Document, Layer, Stroke } from './model.ts';

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
  const color=channel==='paint' ? s.color : '#ffffff';
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
  layer(l:Layer) {
    const key=JSON.stringify([l.assetId,l.width,l.height,l.brightness,l.contrast,l.saturation,l.strokes,l.mask]);
    const cached=this.cache.get(l.id); if(cached?.key===key)return cached.canvas;
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
    if(l.mask.length){const m=surface(l.width,l.height),mc=context(m);mc.fillStyle='#fff';mc.fillRect(0,0,l.width,l.height);for(const s of l.mask)drawStroke(mc,s,'mask');ctx.globalCompositeOperation='destination-in';ctx.drawImage(m,0,0);ctx.globalCompositeOperation='source-over';}
    this.cache.set(l.id,{key,canvas:c}); return c;
  }
  composite(doc:Document, background?:string) {
    const c=surface(doc.width,doc.height),ctx=context(c);
    if(background){ctx.fillStyle=background;ctx.fillRect(0,0,c.width,c.height);}
    for(const l of doc.layers){if(!l.visible)continue;ctx.save();ctx.translate(l.x,l.y);ctx.rotate(l.rotation*Math.PI/180);ctx.scale(l.scaleX*(l.flipX?-1:1),l.scaleY*(l.flipY?-1:1));ctx.globalAlpha=l.opacity;ctx.globalCompositeOperation=l.blend;ctx.drawImage(this.layer(l),-l.width/2,-l.height/2);ctx.restore();}
    return c;
  }
  mask(doc:Document, binary=true, overlay=false) {
    const c=surface(doc.width,doc.height),ctx=context(c);for(const s of doc.inpaint)drawStroke(ctx,s,'inpaint');
    const image=ctx.getImageData(0,0,c.width,c.height),p=image.data;
    for(let i=0;i<p.length;i+=4){const a=p[i+3];if(overlay){p[i]=255;p[i+1]=82;p[i+2]=103;p[i+3]=Math.round(a*.5);}else {const v=binary?(a>=128?255:0):a;p[i]=p[i+1]=p[i+2]=v;p[i+3]=255;}}
    ctx.putImageData(image,0,0);return c;
  }
  collect(doc:Document){const ids=new Set(doc.layers.map(l=>l.id));for(const id of this.cache.keys())if(!ids.has(id))this.cache.delete(id);}
  clear(){this.cache.clear();}
}
