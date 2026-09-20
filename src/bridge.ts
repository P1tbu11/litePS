import type { Editor, Operation } from './core/editor.ts';
import { EditorError, LIMITS, fail } from './core/model.ts';
import { projectBlob } from './core/persistence.ts';

type Request={id:string;method:string;params?:Record<string,unknown>};
export type HostRequest={origin:string;accept:()=>void;reject:()=>void};
export type HostConnection={origin:string;disconnect:()=>void};
const writes=new Set(['transaction.apply','layers.import','history.undo','history.redo']);
function bytesOf(value:unknown){
  if(value instanceof ArrayBuffer)return new Uint8Array(value.slice(0));
  if(ArrayBuffer.isView(value)){const out=new Uint8Array(value.byteLength);out.set(new Uint8Array(value.buffer,value.byteOffset,value.byteLength));return out;}
  return null;
}
export function installBridge(editor:Editor,ready:Promise<void>,onRequest:(request:HostRequest|null)=>void,onConnection:(connection:HostConnection|null)=>void){
  const cache=new Map<string,{digest:string;result:unknown}>();
  const capabilities={apiVersion:'1.0',formats:['image/png','image/jpeg','image/webp','lightps'],limits:LIMITS,methods:['capabilities','document.get','transaction.apply','layers.import','history.undo','history.redo','export.composite','export.mask','export.project']};
  const state=()=>({revision:editor.store.revision,document:structuredClone(editor.doc),busy:editor.busy||editor.store.busy||!!editor.preview,durability:editor.saveState==='saved'?'browser-cache':'memory',flags:{editorBusy:editor.busy,storeBusy:editor.store.busy,preview:!!editor.preview,ready:editor.ready}});
  async function request(input:Request){
    await ready;
    if(!input||typeof input.id!=='string'||!input.id.length||input.id.length>100||typeof input.method!=='string')fail('请求格式无效');
    const {method,id}=input,p=input.params??{};
    if(!p||typeof p!=='object'||Array.isArray(p))fail('请求参数无效');
    let digest='';
    if(writes.has(method)){
      const bytes=bytesOf(p.bytes)??new Uint8Array();
      if(bytes.length>LIMITS.fileBytes)fail('素材超过 80 MB');
      const assetHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).join(',');
      digest=JSON.stringify({method,params:{...p,bytes:assetHash}});
      const previous=cache.get(id);if(previous){if(previous.digest!==digest)throw new EditorError('REQUEST_ID_REUSED','相同请求 ID 不能用于不同内容');return previous.result;}
      if(!Number.isInteger(p.expectedRevision))fail('写入必须指定 expectedRevision');
      if(p.expectedRevision!==editor.store.revision)throw new EditorError('REVISION_CONFLICT','工程版本已变化，请重新读取');
    }
    let result:unknown;
    switch(method){
      case 'capabilities':return capabilities;
      case 'document.get':return state();
      case 'transaction.apply':editor.execute(p.operations as Operation[],'外部编辑',p.expectedRevision as number);result={revision:editor.store.revision};break;
      case 'layers.import':{const bytes=bytesOf(p.bytes);if(!bytes||typeof p.type!=='string'||typeof p.name!=='string')fail('图片参数无效');await editor.importImages([new Blob([bytes],{type:p.type})],[p.name]);result={revision:editor.store.revision,layerId:editor.selected};break;}
      case 'history.undo':editor.undo();result={revision:editor.store.revision};break;
      case 'history.redo':editor.redo();result={revision:editor.store.revision};break;
      case 'export.composite':case 'export.mask':{const r=await editor.exportImage(typeof p.type==='string'?p.type:'image/png',method==='export.mask');return {bytes:await r.file.arrayBuffer(),type:r.file.type,width:r.width,height:r.height,revision:r.revision};}
      case 'export.project':{editor.checkIdle();const revision=editor.store.revision,file=await projectBlob(editor.doc,editor.assets);return {bytes:await file.arrayBuffer(),type:'application/zip',revision};}
      default:fail('不支持这个接口','UNSUPPORTED_METHOD');
    }
    if(writes.has(method)){cache.set(id,{digest,result});if(cache.size>64)cache.delete(cache.keys().next().value!);}
    return result;
  }
  const api={ready,capabilities:()=>capabilities,getState:state,request};
  Object.defineProperty(window,'__LIGHT_PS__',{value:api,configurable:true});
  let port:MessagePort|null=null,unsubscribe:(()=>void)|null=null,pendingOrigin:string|null=null;
  const disconnect=()=>{port?.close();port=null;unsubscribe?.();unsubscribe=null;onConnection(null);};
  const listen=(event:MessageEvent)=>{
    if(event.data?.type!=='lightps:connect'||event.data?.version!==1||event.origin==='null')return;
    if(event.source!==window.parent&&event.source!==window.opener)return;
    if(event.source===window||pendingOrigin)return;
    if(port)return;
    const source=event.source as Window,origin=event.origin;
    pendingOrigin=origin;
    onRequest({origin,accept:()=>{
      const channel=new MessageChannel();port=channel.port1;let chain=Promise.resolve();
      port.onmessage=evt=>{const req=evt.data;const connection=port;chain=chain.then(async()=>{if(port!==connection)return;try{const result=await request(req);connection?.postMessage({id:req.id,ok:true,result});}catch(error){connection?.postMessage({id:req?.id,ok:false,error:{code:error instanceof EditorError?error.code:'INTERNAL_ERROR',message:error instanceof Error?error.message:'操作失败'}});}});};
      port.start();unsubscribe=editor.store.subscribe(()=>port?.postMessage({type:'document.changed',revision:editor.store.revision}));
      source.postMessage({type:'lightps:connected',version:1},origin,[channel.port2]);pendingOrigin=null;onRequest(null);onConnection({origin,disconnect});
    },reject:()=>{source.postMessage({type:'lightps:rejected',version:1},origin);pendingOrigin=null;onRequest(null);}});
  };
  window.addEventListener('message',listen);
  return()=>{window.removeEventListener('message',listen);disconnect();delete (window as unknown as Record<string,unknown>).__LIGHT_PS__;};
}
declare global{interface Window{__LIGHT_PS__: {ready:Promise<void>;capabilities:()=>unknown;getState:()=>unknown;request:(input:Request)=>Promise<unknown>}}}
