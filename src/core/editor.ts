import { EditorStore } from './store.ts';
import { Assets, Rasterizer, context, surface, toBlob } from './raster.ts';
import { assetIds, download, loadRecovery, projectBlob, readProject, saveRecovery } from './persistence.ts';
import { cloneNode, createDocument, createLayer, createMask, cropDocument, editable, EditorError, fail, findNode, groupNodes, isGroup, LIMITS, locateNode, moveNode, nodeCount, nodeSize, patchLayer, rasterLayers, removeNode, replaceSiblings, requireRaster, setLayerMask, ungroupNode, validateDocument, walkLayers } from './model.ts';
import type { Box, Document, LayerPatch, RasterLayer, Stroke, Tool } from './model.ts';
import type { HostConnection, HostRequest } from '../bridge.ts';

export type Operation =
  | {type:'layer.patch';id:string;patch:LayerPatch}
  | {type:'layer.remove'|'layer.duplicate'|'layer.ungroup';id:string}
  | {type:'layer.reorder';id:string;index:number;parentId?:string|null}
  | {type:'layer.group';ids?:string[]}
  | {type:'layer.blank';name?:string}
  | {type:'layer.mask.add'|'layer.mask.remove';id:string}
  | {type:'layer.mask.disable';id:string;disabled:boolean}
  | {type:'stroke';id?:string;channel:'paint'|'mask'|'inpaint';stroke:Stroke}
  | {type:'mask.clear'} | {type:'document.crop';box:Box} | {type:'document.rename';name:string};
const properties=new Set(['name','x','y','scaleX','scaleY','rotation','flipX','flipY','visible','locked','opacity','blend','brightness','contrast','saturation']);
export function applyOperation(doc:Document,op:Operation):Document{
  if(!op||typeof op!=='object')fail('操作无效');
  switch(op.type){
    case 'layer.patch': if(!op.patch||Object.keys(op.patch).some(k=>!properties.has(k)))fail('不允许修改这个图层属性'); return patchLayer(doc,op.id,op.patch);
    case 'layer.remove': editable(doc,op.id);return {...doc,layers:removeNode(doc.layers,op.id)};
    case 'layer.duplicate': {const loc=locateNode(doc,op.id);editable(doc,op.id);if(nodeCount(doc)+nodeSize(loc.node)>LIMITS.layers)fail(`最多支持 ${LIMITS.layers} 个图层`);return replaceSiblings(doc,loc.parent?.id??null,[...loc.siblings.slice(0,loc.index+1),cloneNode(loc.node,true),...loc.siblings.slice(loc.index+1)]); }
    case 'layer.reorder': editable(doc,op.id);return moveNode(doc,op.id,op.index,op.parentId);
    case 'layer.group': return groupNodes(doc,op.ids??[]);
    case 'layer.ungroup': editable(doc,op.id);return ungroupNode(doc,op.id);
    case 'layer.blank':return {...doc,layers:[...doc.layers,createLayer(doc,doc.width,doc.height,null,op.name??'空白图层')]};
    case 'layer.mask.add': {const layer=editable(doc,op.id);if(layer.mask)fail('图层已有蒙版');return setLayerMask(doc,op.id,createMask());}
    case 'layer.mask.remove': {editable(doc,op.id);return setLayerMask(doc,op.id,null);}
    case 'layer.mask.disable': {const layer=editable(doc,op.id);if(!layer.mask)fail('请先添加图层蒙版');return setLayerMask(doc,op.id,{...layer.mask,disabled:op.disabled});}
    case 'stroke':{
      if(!['paint','mask','inpaint'].includes(op.channel))fail('笔画通道无效');
      if(op.channel==='inpaint')return {...doc,inpaint:[...doc.inpaint,op.stroke]};
      const l=editable(doc,op.id??'');
      if(op.channel==='paint'){const raster=requireRaster(l);return patchLayer(doc,raster.id,{strokes:[...raster.strokes,op.stroke]});}
      if(!l.mask)fail('请先添加图层蒙版');
      return setLayerMask(doc,l.id,{...l.mask,strokes:[...l.mask.strokes,op.stroke]});
    }
    case 'mask.clear':return {...doc,inpaint:[]};
    case 'document.crop':return cropDocument(doc,op.box);
    case 'document.rename':return {...doc,name:op.name};
    default:fail('不支持这个操作','UNSUPPORTED_COMMAND');
  }
}

export class Editor {
  store=new EditorStore();assets=new Assets();raster=new Rasterizer(this.assets);
  tool:Tool='move';selected:string|null=null;selection:Box|null=null;editingMask=false;viewMask=false;
  brush={radius:24,hardness:.75,opacity:1,color:'#ffffff',restore:false};
  preview: {id:string;patch:LayerPatch}|null=null;
  hostRequest:HostRequest|null=null;hostConnection:HostConnection|null=null;
  busy=false;ready=false;saveState:'loading'|'saving'|'saved'|'error'|'disabled'='loading';
  message='';messageKind:'info'|'error'='info'; zoom=1;view: {fit():void;zoomTo(n:number):void}|null=null;
  private tick=0;private listeners=new Set<()=>void>();private timer:ReturnType<typeof setTimeout>|undefined;
  private saveChain=Promise.resolve();private autoSize=true;private writer=false; private releaseWriter:(()=>void)|undefined;
  private messageTimer:ReturnType<typeof setTimeout>|undefined;
  lastBackupRevision=-1;
  subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};
  snapshot=()=>this.tick;
  emit=()=>{this.tick++;for(const f of this.listeners)f();};
  constructor(){this.store.subscribe(()=>{const d=this.store.document;if(this.selected&&!findNode(d,this.selected)){this.selected=d.layers.at(-1)?.id??null;this.editingMask=false;this.viewMask=false;}if(this.editingMask&&this.selected&&!findNode(d,this.selected)?.mask)this.editingMask=false;this.assets.collect(this.store.referencedAssets());this.raster.collect(d);this.queueSave();this.emit();});}
  get doc(){return this.store.document;}
  get active(){return this.selected?findNode(this.doc,this.selected):undefined;}
  toast(message:string,kind:'info'|'error'='info'){this.message=message;this.messageKind=kind;this.emit();clearTimeout(this.messageTimer);this.messageTimer=setTimeout(()=>{this.message='';this.emit();},kind==='error'?8000:3000);}
  error(e:unknown){this.toast(e instanceof Error?e.message:'操作失败，请重试','error');}
  checkIdle(){if(this.busy||this.store.busy||this.preview||!this.ready)throw new EditorError('BUSY','请等待当前操作完成');}
  async initialize(){
    this.busy=true;this.emit();
    if(navigator.locks){await new Promise<void>(resolve=>{void navigator.locks.request('light-ps-recovery-writer',{ifAvailable:true},async lock=>{this.writer=!!lock;resolve();if(lock)await new Promise<void>(r=>{this.releaseWriter=r;});}).catch(()=>resolve());});}
    else this.writer=false;
    try{const checkpoint=await loadRecovery();if(checkpoint){const doc=validateDocument(checkpoint.document),items:Awaited<ReturnType<Assets['prepare']>>[]=[];
      try{for(const id of assetIds(doc)){const a=checkpoint.assets.find(x=>x.id===id);if(!a)fail('恢复素材缺失');const p=await this.assets.prepare(a.blob,id);if(rasterLayers(doc.layers).some(l=>l.assetId===id&&(l.width!==p.asset.width||l.height!==p.asset.height))){p.bitmap.close();fail('恢复素材尺寸不一致');}items.push(p);}
        this.assets.accept(items);this.store.replace(doc);this.autoSize=false;this.selected=doc.layers.at(-1)?.id??null;this.toast('已恢复上次编辑');
      }catch(e){for(const p of items)p.bitmap.close();throw e;}
    }this.saveState=this.writer?'saved':'disabled';}
    catch(e){this.saveState='error';this.error(e);}
    this.ready=true;this.busy=false;this.emit();this.view?.fit();
  }
  dispose(){clearTimeout(this.timer);clearTimeout(this.messageTimer);this.releaseWriter?.();}
  private queueSave(){if(!this.writer){this.saveState='disabled';return;}this.saveState='saving';clearTimeout(this.timer);this.timer=setTimeout(()=>void this.flush(),450);}
  async flush(){clearTimeout(this.timer);if(!this.writer)return;const revision=this.store.revision,doc=this.doc;
    // Snapshot asset references before a following operation can garbage-collect them.
    const needed=this.assets.values(assetIds(doc));
    const proxy={values:()=>needed} as unknown as Assets;
    this.saveChain=this.saveChain.then(async()=>{try{await saveRecovery(doc,proxy);if(this.store.revision===revision)this.saveState='saved';}catch{this.saveState='error';this.toast('自动保存失败，请下载工程备份','error');}this.emit();});
    return this.saveChain;
  }
  select(id:string|null,editMask=false){this.selected=id;this.editingMask=!!id&&editMask&&!!findNode(this.doc,id)?.mask;if(!this.editingMask)this.viewMask=false;this.emit();}
  setTool(tool:Tool){if(this.busy||this.store.busy)return;this.tool=tool;this.emit();}
  setSelection(box:Box|null){this.selection=box;this.emit();}
  execute(operations:Operation[],label='编辑',expectedRevision?:number){this.checkIdle();if(!Array.isArray(operations)||!operations.length||operations.length>100)fail('操作数量无效');const ids=new Set<string>();walkLayers(this.doc.layers,layer=>ids.add(layer.id));this.store.commit(label,d=>operations.reduce(applyOperation,d),expectedRevision);let created:string|undefined;walkLayers(this.doc.layers,layer=>{if(!ids.has(layer.id))created=layer.id;});if(created){this.selected=created;this.emit();}}
  patch(patch:LayerPatch){if(!this.selected)return;this.execute([{type:'layer.patch',id:this.selected,patch}],'修改图层');}
  previewPatch(patch:LayerPatch){if(!this.active||this.active.locked)return;this.preview={id:this.active.id,patch};this.emit();}
  commitPreview(){const p=this.preview;this.preview=null;if(p)this.execute([{type:'layer.patch',id:p.id,patch:p.patch}],'调整图层');this.emit();}
  undo(){this.checkIdle();this.store.undo();this.selection=null;this.emit();}
  redo(){this.checkIdle();this.store.redo();this.selection=null;this.emit();}
  newDocument(width:number,height:number,name='未命名'){this.checkIdle();const doc=createDocument(width,height,name);this.store.replace(doc);this.autoSize=false;this.selected=null;this.selection=null;this.view?.fit();this.emit();}
  async importImages(files:Blob[],names:string[]=[]){
    this.checkIdle();this.busy=true;this.emit();const prepared:Awaited<ReturnType<Assets['prepare']>>[]=[];
    try{
      if(nodeCount(this.doc)+files.length>LIMITS.layers)fail(`最多支持 ${LIMITS.layers} 个图层`);
      let retainedPixels=this.assets.values(this.store.referencedAssets()).reduce((n,a)=>n+a.width*a.height,0);
      for(const file of files){const p=await this.assets.prepare(file);prepared.push(p);retainedPixels+=p.asset.width*p.asset.height;if(retainedPixels>LIMITS.assetPixels)fail('素材与撤销历史已达到内存预算，请保存工程后重开再添加图片');}
      if(!prepared.length)return;
      let doc=this.doc;
      if(this.autoSize&&!doc.layers.length&&!doc.inpaint.length)doc={...doc,width:prepared[0].asset.width,height:prepared[0].asset.height,name:(names[0]??'未命名').replace(/\.[^.]+$/,'').slice(0,100)||'未命名'};
      const added=prepared.map((p,i)=>createLayer(doc,p.asset.width,p.asset.height,p.asset.id,(names[i]??`图层 ${doc.layers.length+i+1}`).slice(0,100)));
      const next=validateDocument({...doc,layers:[...doc.layers,...added]});
      this.assets.accept(prepared);this.store.commit('导入图片',()=>next);this.selected=added.at(-1)!.id;this.autoSize=false;this.view?.fit();this.toast(`已添加 ${added.length} 个图层`);
    }catch(e){for(const p of prepared)if(!this.store.referencedAssets().has(p.asset.id))p.bitmap.close();this.assets.collect(this.store.referencedAssets());throw e;}
    finally{this.busy=false;this.emit();}
  }
  async openProject(file:Blob){this.checkIdle();this.busy=true;this.emit();try{const {doc,prepared}=await readProject(file,this.assets);this.assets.accept(prepared);this.raster.clear();this.store.replace(doc);this.selected=doc.layers.at(-1)?.id??null;this.autoSize=false;this.selection=null;this.view?.fit();this.toast('工程已打开');}finally{this.busy=false;this.emit();}}
  async saveProject(){this.checkIdle();const doc=this.doc,revision=this.store.revision;const file=await projectBlob(doc,this.assets);download(file,`${doc.name}.lightps`);this.lastBackupRevision=revision;this.toast('工程已导出，请保留下载文件');}
  async exportImage(type='image/png',mask=false){this.checkIdle();if(!['image/png','image/jpeg','image/webp'].includes(type)||mask&&type!=='image/png')fail('导出格式不支持；遮罩必须使用 PNG');const snapshot=this.doc,revision=this.store.revision;const canvas=mask?this.raster.mask(snapshot):this.raster.composite(snapshot,type==='image/jpeg'?'#ffffff':undefined);const file=await toBlob(canvas,type);if(file.type!==type)fail('浏览器不支持此导出格式，请选择 PNG');return {file,width:snapshot.width,height:snapshot.height,revision,name:snapshot.name};}
  async downloadImage(type='image/png',mask=false){const r=await this.exportImage(type,mask);download(r.file,`${r.name}${mask?'-mask':''}.${type==='image/jpeg'?'jpg':type.split('/')[1]}`);this.toast(mask?'黑白遮罩已导出':'图片已导出');}
  async copyImage(){const {file}=await this.exportImage();if(!navigator.clipboard?.write)fail('浏览器不支持复制图片，请使用导出');await navigator.clipboard.write([new ClipboardItem({'image/png':file})]);this.toast('图片已复制');}
  addBlank(){this.execute([{type:'layer.blank'}],'添加空白图层');this.selected=this.doc.layers.at(-1)!.id;this.editingMask=false;this.emit();}
  addMask(){if(!this.selected)fail('请先选中图层');this.execute([{type:'layer.mask.add',id:this.selected}],'添加图层蒙版');this.editingMask=true;this.tool='brush';this.brush.color='#000000';this.emit();}
  removeMask(){if(!this.selected)return;this.execute([{type:'layer.mask.remove',id:this.selected}],'删除图层蒙版');this.editingMask=false;this.viewMask=false;this.emit();}
  disableMask(disabled:boolean){if(!this.selected)return;this.execute([{type:'layer.mask.disable',id:this.selected,disabled}],disabled?'停用图层蒙版':'启用图层蒙版');}
  group(){this.execute([{type:'layer.group',ids:this.selected?[this.selected]:[]}],this.selected?'编组':'新建组');}
  ungroup(){
    const node=this.active;if(!node||!isGroup(node))fail('请选中组');
    const keep=node.children[0]?.id??locateNode(this.doc,node.id).parent?.id??null;
    this.execute([{type:'layer.ungroup',id:node.id}],'解散组');
    if(keep&&findNode(this.doc,keep)){this.selected=keep;this.emit();}
  }
  crop(){if(!this.selection)fail('请先拖出裁切范围');this.execute([{type:'document.crop',box:this.selection}],'裁切画布');this.selection=null;this.tool='move';this.view?.fit();this.emit();}
  async example(){
    this.checkIdle();const bg=surface(1200,900),b=context(bg);b.fillStyle='#e7e4dc';b.fillRect(0,0,1200,900);b.fillStyle='#c3c4b8';b.fillRect(0,600,1200,300);b.fillStyle='#74776a';b.font='500 28px system-ui';b.fillText('S T U D I O   /   0 1',75,90);
    const art=surface(680,680),a=context(art);a.fillStyle='#78866b';a.beginPath();a.roundRect(160,110,360,510,[160,160,24,24]);a.fill();a.fillStyle='#c9cebf';a.beginPath();a.ellipse(340,110,180,62,0,0,Math.PI*2);a.fill();a.fillStyle='#4b5843';a.beginPath();a.ellipse(340,110,110,31,0,0,Math.PI*2);a.fill();
    this.newDocument(1200,900,'静物练习');await this.importImages([await toBlob(bg),await toBlob(art)],['背景','陶器']);this.execute([{type:'layer.patch',id:this.doc.layers[0].id,patch:{locked:true}}],'锁定背景');this.view?.fit();
  }
}
