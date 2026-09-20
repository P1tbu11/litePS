import { zip, unzip, strToU8, strFromU8 } from 'fflate';
import { LIMITS, validateDocument, fail } from './model.ts';
import type { Document, Asset } from './model.ts';
import type { Assets } from './raster.ts';

export const assetIds = (doc:Document) => new Set(doc.layers.flatMap(l=>l.assetId?[l.assetId]:[]));
export async function projectBlob(doc:Document, assets:Assets):Promise<Blob>{
  const entries:Record<string,Uint8Array>={};
  const list=await Promise.all(assets.values(assetIds(doc)).map(async a=>{const path=`assets/${a.id}`;entries[path]=new Uint8Array(await a.blob.arrayBuffer());return {id:a.id,path,type:a.blob.type,width:a.width,height:a.height};}));
  entries['project.json']=strToU8(JSON.stringify({format:'light-ps',version:1,document:doc,assets:list}));
  return new Promise((resolve,reject)=>zip(entries,{level:0},(err,data)=>err?reject(err):resolve(new Blob([data as Uint8Array<ArrayBuffer>],{type:'application/zip'}))));
}
export async function readProject(file:Blob, assets:Assets){
  if(file.size>LIMITS.fileBytes)fail('工程超过 80 MB，请拆分保存');
  const bytes=new Uint8Array(await file.arrayBuffer());let total=0;
  const entries=await new Promise<Record<string,Uint8Array>>((resolve,reject)=>unzip(bytes,{filter:f=>{
    total+=f.originalSize;
    if(total>LIMITS.fileBytes || f.originalSize>LIMITS.fileBytes || (f.name!=='project.json' && !/^assets\/[a-zA-Z0-9_-]+$/.test(f.name)))return false;
    return true;
  }},(err,result)=>err?reject(new Error('工程文件损坏或格式不正确')):resolve(result)));
  if(total>LIMITS.fileBytes || !entries['project.json'])fail('工程无效或解压后过大');
  let manifest;
  try{manifest=JSON.parse(strFromU8(entries['project.json']));}catch{fail('工程清单无法读取');}
  if(manifest.format!=='light-ps'||manifest.version!==1||!Array.isArray(manifest.assets))fail('不支持这个工程格式');
  const doc=validateDocument(manifest.document), needed=assetIds(doc), prepared:Awaited<ReturnType<Assets['prepare']>>[]=[];
  try{
    for(const id of needed){const descriptions=manifest.assets.filter((a:{id?:string})=>a?.id===id);if(descriptions.length!==1)fail('工程素材清单缺失或重复');const a=descriptions[0];if(a.path!==`assets/${id}`||!entries[a.path])fail('工程素材缺失');
      const p=await assets.prepare(new Blob([entries[a.path] as Uint8Array<ArrayBuffer>],{type:a.type}),id);
      if(doc.layers.some(l=>l.assetId===id&&(l.width!==p.asset.width||l.height!==p.asset.height))){p.bitmap.close();fail('图层尺寸与素材不一致');}prepared.push(p);
    }
    return {doc,prepared};
  }catch(e){for(const p of prepared)p.bitmap.close();throw e;}
}

type Checkpoint={ document:Document; assets:Asset[]; savedAt:number };
const DATABASE='light-ps-local-v1';
function database():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{const req=indexedDB.open(DATABASE,1);req.onupgradeneeded=()=>req.result.createObjectStore('recovery');req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('自动恢复数据库被其他窗口占用'));req.onsuccess=()=>resolve(req.result);});}
export async function saveRecovery(doc:Document,assets:Assets){
  const db=await database();try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('recovery','readwrite');tx.objectStore('recovery').put({document:doc,assets:assets.values(assetIds(doc)),savedAt:Date.now()} satisfies Checkpoint,'latest');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new Error('自动保存已中断'));});}finally{db.close();}
}
export async function loadRecovery():Promise<Checkpoint|undefined>{const db=await database();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('recovery','readonly'),req=tx.objectStore('recovery').get('latest');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}finally{db.close();}}
export function download(blob:Blob,name:string){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10_000);}
