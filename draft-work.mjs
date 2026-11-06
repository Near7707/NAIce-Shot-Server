import {blankScene, stripReasoningBlocks, textSignature} from './core.mjs';

// Drafts contain editable work, never request headers, API keys or a second copy of the chat text.
export function packWork(work,{retainRaw=false,undo=true}={}) {
  const clean=(value,depth=0)=>{
    if(depth>24)throw new Error('작업 구조가 너무 깊어서 저장하지 못했어요.');
    if(value===null||typeof value==='boolean'||typeof value==='number')return value;
    if(typeof value==='string'){if(value.length>200000)throw new Error('작업 내용이 너무 길어요.');return value;}
    if(Array.isArray(value)){if(value.length>200)throw new Error('작업 항목이 너무 많아요.');return value.map(v=>clean(v,depth+1));}
    if(!value||typeof value!=='object')return null;
    const out={};
    for(const [key,v] of Object.entries(value)){
      if(['__proto__','constructor','prototype','payload','headers','rawExtraction'].includes(key))continue;
      if(key==='fingerprints'){out[key]=(Array.isArray(v)?v:[]).map(f=>({index:f.index,swipeId:f.swipeId,signature:f.signature??textSignature(String(f.text??''))}));continue;}
      out[key]=clean(v,depth+1);
    }
    return out;
  };
  if(!work?.scene||!Array.isArray(work.scene.characters))throw new Error('저장된 작업 형식을 확인해 주세요.');
  const result=work.result;
  const validResult=typeof result?.id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.id)&&
    result.image===`/user/images/naice-shot/${result.id}.png`&&Number.isInteger(result.seed)&&result.seed>=0&&result.seed<=4294967295;
  const out={scene:clean(work.scene),raw:retainRaw?stripReasoningBlocks(String(work.raw??'')):'',
    finalOverride:clean(work.finalOverride),optionsOverride:clean(work.optionsOverride),isRestored:work.isRestored??(!!work.restoredFinal&&work.restoredFinal===work.finalOverride),
    finalText:typeof work.finalText==='string'?work.finalText:'',target:String(work.target??''),wish:String(work.wish??''),freeText:String(work.freeText??''),
    targetSource:clean(work.targetSource??null),targetShown:Number(work.targetShown)||10,
    result:validResult?clean(Object.fromEntries(['id','image','seed','created','chatKey','assembled','options','snapshot'].filter(k=>result[k]!==undefined).map(k=>[k,result[k]]))):null,
    undoClear:undo&&work.undoClear?packWork(work.undoClear,{retainRaw,undo:false}):null};
  if(work.label)out.label=String(work.label);
  if(JSON.stringify(out).length>1000000)throw new Error('작업 내용이 너무 커서 저장하지 못했어요.');
  return out;
}

export function unpackWork(data){
  const out={...data,scene:{...blankScene(),...data.scene}};
  out.restoredFinal=out.isRestored?out.finalOverride:null;
  out.undoClear=out.undoClear?unpackWork(out.undoClear):null;
  return out;
}

// A per-key queue: changes during a save get their own following save; a failed save keeps its data.
// Each entry has a generation. Deleting the saved work starts a new generation, and replies to reads or
// writes sent before it are ignored, so they can never bring back deleted work or an old revision.
export class DraftQueue {
  constructor({read,write,onState=()=>{},delay=650}){Object.assign(this,{read,write,onState,delay});this.entries=new Map();this.paused=false;}
  entry(key){
    let e=this.entries.get(key);if(!e)e={loaded:false,data:null,revision:null,dirty:false,version:0,error:null,gen:0};
    this.entries.delete(key);this.entries.set(key,e);
    // Keep only a few clean chats in memory. Failed/unsaved/in-flight work is never evicted.
    for(const [oldKey,old] of this.entries){if(this.entries.size<=12)break;if(oldKey!==key&&old.loaded&&!old.dirty&&!old.saving&&!old.reading&&!old.pinned)this.entries.delete(oldKey);}
    return e;
  }
  // Before deleting on the server: hold every save (pending edits stay dirty and keep their data) and wait
  // for requests already on their way, so no older request can reach the server after the deletion.
  // If the deletion fails, resume() sends the held edits; if it succeeds, reset() drops them for deleted chats.
  async pause(keys=null){
    this.paused=true;
    const list=[...this.entries].filter(([key])=>!keys||keys.includes(key)).map(([,e])=>e);
    for(const [,e] of this.entries){clearTimeout(e.timer);e.timer=null;}
    await Promise.all(list.flatMap(e=>[e.saving,e.reading]).filter(Boolean).map(p=>p.catch(()=>{})));
  }
  resume(){
    this.paused=false;
    // A snapshot: onState may touch entries, which reorders the Map while it is being walked.
    for(const [key,e] of [...this.entries])if(e.loaded&&e.dirty&&!e.saving){clearTimeout(e.timer);e.timer=setTimeout(()=>this.flush(key),this.delay);this.onState(key,e);}
  }
  // After the server deleted a saved work: start a new generation and read again. The server leaves a
  // marker with a fresh revision, so the next save must be based on that read, never on an older one.
  reset(key){const e=this.entry(key);clearTimeout(e.timer);e.gen++;
    Object.assign(e,{loaded:false,data:null,revision:null,dirty:false,error:null,saving:null,reading:null});this.onState(key,e);}
  async ensure(key){
    const e=this.entry(key);if(e.loaded)return e.data;if(e.reading)return e.reading;
    const gen=e.gen;
    const reading=(async()=>{try{const r=await this.read(key);if(gen!==e.gen)return e.data;e.revision=r.revision??null;e.data=r.work??null;e.loaded=true;e.error=null;return e.data;}
      catch(error){if(gen!==e.gen)return e.data;e.error=error;throw error;}finally{if(e.reading===reading)e.reading=null;this.onState(key,e);}})();
    e.reading=reading;return reading;
  }
  put(key,data){const e=this.entry(key);if(!e.loaded)return;const json=JSON.stringify(data);if(json===JSON.stringify(e.data))return;
    e.data=JSON.parse(json);e.version++;e.dirty=true;e.error=null;clearTimeout(e.timer);if(!this.paused)e.timer=setTimeout(()=>this.flush(key),this.delay);this.onState(key,e);}
  async flush(key){
    const e=this.entry(key);clearTimeout(e.timer);if(e.saving)return e.saving;if(!e.loaded||!e.dirty||this.paused)return;
    const gen=e.gen;
    const saving=(async()=>{while(e.dirty&&gen===e.gen&&!this.paused){const version=e.version,work=e.data;
      try{const r=await this.write(key,{work,expectedRevision:e.revision});if(gen!==e.gen)return;e.revision=r.revision;e.error=null;if(version===e.version)e.dirty=false;}
      catch(error){if(gen===e.gen)e.error=error;break;}
    }})().finally(()=>{if(e.saving===saving)e.saving=null;this.onState(key,e);});
    e.saving=saving;this.onState(key,e);return saving;
  }
}

