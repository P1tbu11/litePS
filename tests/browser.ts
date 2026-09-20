import { Assets, Rasterizer, context, surface, toBlob } from '../src/core/raster.ts';
import { createDocument, createLayer } from '../src/core/model.ts';
import { projectBlob, readProject } from '../src/core/persistence.ts';
export async function runRasterTests(){
  const results:string[]=[];
  const check=(v:unknown,label:string)=>{if(!v)throw new Error(label);results.push(label);};
  const pixel=(c:HTMLCanvasElement,x=2,y=2)=>[...context(c).getImageData(x,y,1,1).data];
  const assets=new Assets(),raster=new Rasterizer(assets),doc=createDocument(8,8);
  const red=surface(8,8);context(red).fillStyle='#ff0000';context(red).fillRect(0,0,8,8);
  const prepared=await assets.prepare(await toBlob(red));assets.accept([prepared]);
  const layer=createLayer(doc,8,8,prepared.asset.id,'red');doc.layers=[layer];
  check(pixel(raster.composite(doc)).join(',')==='255,0,0,255','native-resolution red pixels');
  layer.mask=[{points:[{x:2.5,y:2.5}],radius:2,hardness:1,opacity:1,color:'#ffffff',mode:'erase'}];
  check(pixel(raster.composite(doc))[3]===0,'erase affects source alpha');
  layer.mask.push({...layer.mask[0],mode:'restore'});
  check(pixel(raster.composite(doc))[3]===255,'restoring mask recovers original pixels');
  const blue=surface(8,8);context(blue).fillStyle='#0000ff';context(blue).fillRect(0,0,8,8);
  const p2=await assets.prepare(await toBlob(blue));assets.accept([p2]);const l2=createLayer(doc,8,8,p2.asset.id,'blue');l2.blend='multiply';doc.layers.push(l2);
  check(pixel(raster.composite(doc)).join(',')==='0,0,0,255','multiply works across independent layers');
  doc.inpaint=[{points:[{x:4,y:4}],radius:3,hardness:0,opacity:1,color:'#ffffff',mode:'paint'}];
  const mask=context(raster.mask(doc)).getImageData(0,0,8,8).data;
  check(mask.every((v,i)=>i%4===3?v===255:v===0||v===255),'binary mask has only black/white opaque pixels');
  check(pixel(raster.composite(doc)).join(',')==='0,0,0,255','inpaint overlay is absent from composite');
  const file=await projectBlob(doc,assets),target=new Assets(),loaded=await readProject(file,target);target.accept(loaded.prepared);
  check(JSON.stringify(doc)===JSON.stringify(loaded.doc),'project preserves edit parameters and source IDs');
  check([...context(raster.composite(doc)).getImageData(0,0,8,8).data].join(',')===[...context(new Rasterizer(target).composite(loaded.doc)).getImageData(0,0,8,8).data].join(','),'project round trip preserves exact rendered pixels');
  let rejected=false;try{await readProject(new Blob(['bad zip']),target);}catch{rejected=true;}check(rejected,'corrupt archives are rejected');
  assets.collect(new Set());target.collect(new Set());document.getElementById('results')!.textContent=results.join('\n');return results;
}
