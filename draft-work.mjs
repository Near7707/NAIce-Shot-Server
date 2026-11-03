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
  const out={scene:clean(work.scene),raw:retainRaw?stripReasoningBlocks(String(work.raw??'')):'',
    finalOverride:clean(work.finalOverride),optionsOverride:clean(work.optionsOverride),isRestored:work.isRestored??(!!work.restoredFinal&&work.restoredFinal===work.finalOverride),
    finalText:typeof work.finalText==='string'?work.finalText:'',target:String(work.target??''),wish:String(work.wish??''),freeText:String(work.freeText??''),
    targetSource:clean(work.targetSource??null),targetShown:Number(work.targetShown)||10,
    result:result?clean(Object.fromEntries(['id','image','seed','created','chatKey','assembled','options','snapshot'].filter(k=>result[k]!==undefined).map(k=>[k,result[k]]))):null,
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
export class DraftQueue {
  constructor({read,write,onState=()=>{},delay=650}){Object.assign(this,{read,write,onState,delay});this.entries=new Map();}
  entry(key){
    let e=this.entries.get(key);if(!e)e={loaded:false,data:null,revision:null,dirty:false,version:0,error:null};
    this.entries.delete(key);this.entries.set(key,e);
    // Keep only a few clean chats in memory. Failed/unsaved/in-flight work is never evicted.
    for(const [oldKey,old] of this.entries){if(this.entries.size<=12)break;if(oldKey!==key&&old.loaded&&!old.dirty&&!old.saving&&!old.reading&&!old.pinned)this.entries.delete(oldKey);}
    return e;
  }
  async ensure(key){
    const e=this.entry(key);if(e.loaded)return e.data;if(e.reading)return e.reading;
    e.reading=(async()=>{try{const r=await this.read(key);e.revision=r.revision??null;e.data=r.work??null;e.loaded=true;e.error=null;return e.data;}
      catch(error){e.error=error;throw error;}finally{e.reading=null;this.onState(key,e);}})();return e.reading;
  }
  put(key,data){const e=this.entry(key);if(!e.loaded)return;const json=JSON.stringify(data);if(json===JSON.stringify(e.data))return;
    e.data=JSON.parse(json);e.version++;e.dirty=true;e.error=null;clearTimeout(e.timer);e.timer=setTimeout(()=>this.flush(key),this.delay);this.onState(key,e);}
  async flush(key){
    const e=this.entry(key);clearTimeout(e.timer);if(e.saving)return e.saving;if(!e.loaded||!e.dirty)return;
    e.saving=(async()=>{while(e.dirty){const version=e.version,work=e.data;
      try{const r=await this.write(key,{work,expectedRevision:e.revision});e.revision=r.revision;e.error=null;if(version===e.version)e.dirty=false;}
      catch(error){e.error=error;break;}
    }})().finally(()=>{e.saving=null;this.onState(key,e);});this.onState(key,e);return e.saving;
  }
}
