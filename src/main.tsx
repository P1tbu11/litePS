import { createRoot } from 'react-dom/client';
import { App } from './ui.tsx';
import { Editor } from './core/editor.ts';
import { installBridge } from './bridge.ts';
import './style.css';

const editor=new Editor();
createRoot(document.getElementById('root')!).render(<App editor={editor}/>);
const ready=editor.initialize();
const removeBridge=installBridge(editor,ready,request=>{editor.hostRequest=request;editor.emit();},connection=>{editor.hostConnection=connection;editor.emit();});
window.addEventListener('beforeunload',event=>{if(editor.saveState==='saving'||editor.saveState==='error'||editor.saveState==='disabled'&&editor.doc.layers.length&&editor.lastBackupRevision!==editor.store.revision){event.preventDefault();event.returnValue='';}});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')void editor.flush();});
if(import.meta.hot)import.meta.hot.dispose(()=>{removeBridge();editor.dispose();});
