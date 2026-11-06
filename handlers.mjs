import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {createHash, randomUUID} from 'node:crypto';
import { buildPayload, costGuard, usageOf, MODELS, stripReasoningBlocks } from './core.mjs';
import {packWork} from './draft-work.mjs';

class PublicError extends Error {
  constructor(message,status=400,code=''){super(message);this.status=status;this.code=code;}
}
const ORIGIN='https://image.novelai.net';
const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function extractPng(buffer) {
  if(buffer.subarray(0,8).equals(PNG)) return buffer;
  // Read ZIP central-directory metadata, including archives with data descriptors.
  let end=-1;
  for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--)if(buffer.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0)throw new Error('NAI 응답에서 ZIP을 찾지 못했어요.');
  let offset=buffer.readUInt32LE(end+16);
  const entries=buffer.readUInt16LE(end+10);
  if(entries>100)throw new Error('NAI ZIP 파일 수가 너무 많아요.');
  for(let n=0;n<entries;n++) {
    if(offset+46>buffer.length || buffer.readUInt32LE(offset)!==0x02014b50)throw new Error('ZIP 헤더가 잘못됐어요.');
    const flags=buffer.readUInt16LE(offset+8),method=buffer.readUInt16LE(offset+10),size=buffer.readUInt32LE(offset+20),rawSize=buffer.readUInt32LE(offset+24);
    const nameSize=buffer.readUInt16LE(offset+28),extra=buffer.readUInt16LE(offset+30),comment=buffer.readUInt16LE(offset+32),local=buffer.readUInt32LE(offset+42);
    const name=buffer.subarray(offset+46,offset+46+nameSize).toString('utf8');
    offset+=46+nameSize+extra+comment;
    if(!name.toLowerCase().endsWith('.png'))continue;
    if(flags&1 || rawSize>25*1024*1024 || size>25*1024*1024)throw new Error('PNG 크기 또는 ZIP 암호화를 확인해 주세요.');
    if(local+30>buffer.length || buffer.readUInt32LE(local)!==0x04034b50)throw new Error('ZIP 데이터가 잘못됐어요.');
    const begin=local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28);
    if(begin+size>buffer.length)throw new Error('ZIP 데이터가 잘렸어요.');
    const packed=buffer.subarray(begin,begin+size);
    const png=method===0?packed:method===8?inflateRawSync(packed,{maxOutputLength:25*1024*1024}):null;
    if(!png || !png.subarray(0,8).equals(PNG) || png.length!==rawSize)throw new Error('ZIP에서 유효한 PNG를 찾지 못했어요.');
    return png;
  }
  throw new Error('NAI ZIP에 PNG가 없어요.');
}
function validateAssembled(a,model) {
  if(!a || typeof a!=='object' || !Array.isArray(a.characters) || a.characters.length>MODELS[model]?.limit)throw new Error('최종 프롬프트 구조가 잘못됐어요.');
  const text=(v,max=20000)=>{if(typeof v!=='string'||v.length>max)throw new Error('프롬프트 길이 또는 형식을 확인해 주세요.');return v;};
  const ids=new Set();
  const characters=a.characters.map(c=>{
    if(!c || typeof c.id!=='string' || !/^[\w-]{1,80}$/.test(c.id)||ids.has(c.id))throw new Error('슬롯 ID가 중복되거나 잘못됐어요.');
    ids.add(c.id);
    if(!['auto','left','center','right'].includes(c.position))throw new Error('슬롯 위치가 잘못됐어요.');
    return {id:c.id,name:text(c.name,200),prompt:text(c.prompt),negative:text(c.negative),position:c.position,outfit:typeof c.outfit==='string'?text(c.outfit):''};
  });
  return {base:text(a.base),negative:text(a.negative),characters,warnings:[]};
}
async function readLimited(response,limit) {
  if(!response.body)return Buffer.alloc(0);
  let total=0;const chunks=[];
  for await(const chunk of response.body){total+=chunk.length;if(total>limit)throw new Error('NAI 응답 크기 한도를 넘었어요.');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
const SERVER_VERSION='0.1.23';
// Oldest UI that works with this server. Raise it when a server change needs a newer UI.
const MIN_CLIENT_VERSION='0.1.44'; // 0.1.44 re-reads saved work after deleting it (deletion markers)
const RECORDS_DIR='naice-shot-records',INDEX_FILE='index.json';
const fail400=message=>new PublicError(message,400);
const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};
const fileStat=file=>fs.stat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
async function unlinkQuiet(file){try{await fs.unlink(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function writeAtomic(file,text){const tmp=`${file}.${randomUUID()}.tmp`;try{await fs.writeFile(tmp,text);await fs.rename(tmp,file);}finally{await unlinkQuiet(tmp);}}
async function moveFile(from,to){try{await fs.rename(from,to);}catch(e){if(e.code!=='EXDEV')throw e;await fs.copyFile(from,to,fs.constants.COPYFILE_EXCL);await fs.unlink(from);}}
const workFolder=dirs=>path.join(dirs.root,'naice-shot-work');
const workFile=(dirs,chatKey)=>path.join(workFolder(dirs),createHash('sha256').update(chatKey).digest('hex')+'.json');
const FREE_TEXT_LIMIT=4000; // characters a person sees (a @profile chip counts as @name)
const FREE_TEXT_STORED_LIMIT=180000; // the stored text form: a chip is @[name](ref:ID)
const visibleLength=t=>t.replace(/@\[([^\]\n]{0,200})\]\(ref:[A-Za-z0-9_-]*\)/gu,(m,n)=>`@${n}`).length;
// NovelAI's own short explanation, cleaned for display: one line, no credentials, at most 120 characters.
export function naiNote(body){
  let text=String(body??'');try{const j=JSON.parse(text);text=typeof j==='string'?j:j?.message??j?.error??j?.detail??text;}catch{}
  text=String(text).replace(/Bearer\s+\S+/gi,'Bearer ***').replace(/pst-[A-Za-z0-9_-]+/g,'***').replace(/<[^>]*>/g,' ').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim();
  return text.length>120?text.slice(0,119)+'…':text;
}
// Names a NovelAI generation failure only when the reply makes the cause clear; otherwise says so and
// shows NovelAI's own note. A status number alone never becomes "not enough Anlas".
export function naiError(status,body){
  const note=naiNote(body),tail='자동 재요청하지 않았어요.',with_=note?` (NovelAI ${status}: ${note})`:` (NovelAI ${status})`;
  if(status===401)return new PublicError(`NAI 키를 확인해 주세요. ${tail}`,401,'nai-auth');
  if(/anlas|training ?steps|(?:insufficient|not enough) (?:funds|balance|anlas|steps)/i.test(note)&&status>=400&&status<500)return new PublicError(`Anlas가 부족해요. ${tail}${with_}`,402,'nai-anlas');
  if(status===403&&/permission|not allowed|subscription|tier|access|forbidden/i.test(note))return new PublicError(`이 모델의 사용 권한을 확인해 주세요. ${tail}${with_}`,403,'nai-permission');
  if(status===429)return new PublicError(`NovelAI 요청이 많아요. 잠시 후 다시 시도해 주세요. ${tail}${with_}`,429,'nai-busy');
  if(status>=500)return new PublicError(`NovelAI 쪽에 문제가 있어요. 잠시 후 다시 시도해 주세요. ${tail}${with_}`,502,'nai-down');
  return new PublicError(`NovelAI가 요청을 거절했어요. 계정 상태와 생성 설정을 확인해 주세요. ${tail}${with_}`,502,'nai-rejected');
}
// Deleting saved work leaves a marker with a fresh revision and no content. A save prepared before the
// deletion (in another window or device) still carries an older revision, so it is refused with 409
// instead of quietly bringing the work back. Returns whether real work was removed.
async function tombstone(file){
  let old=null;try{old=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {had:false,revision:null};old={};}
  const revision=randomUUID();await writeAtomic(file,JSON.stringify({revision,work:null,deleted:true}));
  return {had:!!old?.work,revision};
}
const metaOf=item=>({id:item.id,created:String(item.created??''),chatKey:String(item.chatKey??''),seed:item.seed??null,model:item.options?.model??''});

// Per-user storage. PNGs stay in the web-served user images folder (they are shown in chat).
// Generation records (prompts, payload, extraction text) live in a private folder ST does not serve.
function createStore(dirs) {
  const images=path.join(dirs.userImages,'naice-shot'),records=path.join(dirs.root,RECORDS_DIR),indexFile=path.join(records,INDEX_FILE);
  const png=id=>path.join(images,`${id}.png`),record=id=>path.join(records,`${id}.json`);
  async function recordNames(){try{return (await fs.readdir(records)).filter(n=>n.endsWith('.json')&&ID.test(n.slice(0,-5)));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
  async function readRecord(id){try{return JSON.parse(await fs.readFile(record(id),'utf8'));}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return null;throw e;}}
  async function rebuild(names){
    const entries=[];
    for(const name of names){const item=await readRecord(name.slice(0,-5));if(item?.id===name.slice(0,-5))entries.push(metaOf(item));}
    await writeAtomic(indexFile,JSON.stringify({version:1,entries}));return entries;
  }
  // Moves v0.3 records out of the public images folder, then returns a consistent index.
  async function ready(){
    await fs.mkdir(records,{recursive:true});await fs.mkdir(images,{recursive:true});
    let moved=0;
    for(const name of await fs.readdir(images)){
      if(!name.endsWith('.json')||!ID.test(name.slice(0,-5)))continue;
      const target=path.join(records,name);
      if(await exists(target))await unlinkQuiet(path.join(images,name));else await moveFile(path.join(images,name),target);
      moved++;
    }
    const names=await recordNames();
    let entries=null;
    if(!moved){try{const index=JSON.parse(await fs.readFile(indexFile,'utf8'));if(index?.version===1&&Array.isArray(index.entries))entries=index.entries;}catch{}}
    // Self-heal when a write was interrupted or files were removed by hand.
    if(!entries||entries.length!==names.length)entries=await rebuild(names);
    return entries;
  }
  const save=entries=>writeAtomic(indexFile,JSON.stringify({version:1,entries}));
  return {images,records,png,record,readRecord,ready,save};
}
export function createHandlers({readKey,fetcher=globalThis.fetch,timeoutMs=180000}) {
  const active=new Map(),queues=new Map(),unsaved=new Map();
  // Index reads/writes for one user never interleave (generate, delete, history, migration).
  const serial=(user,fn)=>{
    const run=(queues.get(user)??Promise.resolve()).then(()=>fn());
    const tail=run.catch(()=>{});queues.set(user,tail);
    tail.then(()=>{if(queues.get(user)===tail)queues.delete(user);});
    return run;
  };
  const context=req=>{
    const dirs=req.user?.directories;
    if(!dirs?.userImages || !dirs?.root)throw new PublicError('실리태번 사용자 경로를 찾지 못했어요.',401);
    return {dirs,user:dirs.root,store:createStore(dirs),key:()=>readKey(dirs)};
  };
  // [NAI 연결 확인] → the account reply's field NAMES and kinds only, never a value (0.1.14). Used to check which
  // fields NovelAI really sends before the free/usage rules depend on them.
  const shapeOf=data=>{
    const out=[],kind=v=>v===null?'null':Array.isArray(v)?'array':typeof v,safe=k=>/^[A-Za-z0-9_$-]{1,60}$/.test(k)?k:'(이름 생략)';
    const walk=(v,path,depth)=>{
      if(out.length>=150)return;const k=kind(v);
      if(path)out.push(k==='array'?`${path}: array (${v.length}개)`:`${path}: ${k}`);
      if(depth>=4)return;
      if(k==='array'){if(v.length&&kind(v[0])==='object')walk(v[0],`${path}[]`,depth+1);return;}
      if(k==='object')for(const key of Object.keys(v).sort())walk(v[key],path?`${path}.${safe(key)}`:safe(key),depth+1);
    };
    walk(data,'',0);if(out.length>=150)out.push('… (150개까지만 보여요)');return out;
  };
  const subscription=async(key,{shape=false}={})=>{
    if(!key)throw new PublicError('실리태번 API 연결 화면에 NAI 키를 먼저 저장해 주세요.',400);
    // code nai-account: the UI drops its last free verdict and checks again (UI-067-01). Every failure of this step
    // carries it — an HTTP error, no connection, a timeout, a reply that cannot be read (0.1.17, UI-068-02). Nothing
    // has been sent to the image API yet, so a timeout here says so.
    let data;
    try{
      const response=await fetcher(`${ORIGIN}/user/subscription`,{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new PublicError(`NAI 계정 확인 실패 (${response.status}).`,response.status===401?401:502,'nai-account');
      data=JSON.parse((await readLimited(response,100000)).toString());
      if(!data||typeof data!=='object')throw new SyntaxError('not an object');
    }catch(e){
      if(e instanceof PublicError&&e.code==='nai-account')throw e;
      if(e?.name==='TimeoutError'||e?.name==='AbortError')throw new PublicError('NAI 계정 확인 시간이 초과됐어요. 생성 요청은 보내지 않았어요.',504,'nai-account');
      throw new PublicError(e instanceof SyntaxError?'NAI 계정 확인 실패 (응답을 읽지 못했어요). 생성 요청은 보내지 않았어요.':'NAI 계정 확인 실패 (연결하지 못했어요). 생성 요청은 보내지 않았어요.',502,'nai-account');
    }
    // Forward only fields necessary for eligibility; never expose keys or full account data. A missing or odd field
    // stays null (never false or 0), so the shared costGuard can tell "not active" from "not known" (0.1.15).
    const bool=v=>typeof v==='boolean'?v:null;
    return {tier:typeof data.tier==='number'?data.tier:null,active:bool(data.active),isGracePeriod:bool(data.isGracePeriod),
      perks:{unlimitedImageGeneration:bool(data.perks?.unlimitedImageGeneration)},usage:usageOf(data),
      anlas:{subscription:data.trainingStepsLeft?.fixedTrainingStepsLeft??null,purchased:data.trainingStepsLeft?.purchasedTrainingSteps??null},
      ...(shape?{shape:shapeOf(data)}:{})};
  };
  const fail=(res,e)=>res.status(e instanceof PublicError?e.status:500).json({error:e instanceof PublicError?e.message:'요청 처리 중 내부 오류가 발생했어요. 설치 경로와 파일 접근 권한을 확인해 주세요.',...(e instanceof PublicError&&e.code?{code:e.code}:{})});
  const chatKeyOf=value=>{if(typeof value!=='string'||!value||value.length>1000)throw fail400('채팅 정보가 잘못됐어요.');return value;};
  // Old versions accepted an empty chat key. Allow explicit ID cleanup for those records only.
  const deletionKey=(value,all)=>value===''&&!all?'':chatKeyOf(value);
  const requestFolder=dirs=>path.join(dirs.root,'naice-shot-requests');
  const requestFile=(dirs,id)=>path.join(requestFolder(dirs),id+'.json');
  const validId=id=>typeof id==='string'&&ID.test(id);
  async function readRequest(dirs,id){
    try{return JSON.parse(await fs.readFile(requestFile(dirs,id),'utf8'));}
    catch(e){if(e.code==='ENOENT')return null;throw e;}
  }
  async function pendingRequests(ctx,{includeUncertain=false}={}){
    const {dirs,user,store}=ctx,volatile=unsaved.get(user);
    let names=[];
    try{names=await fs.readdir(requestFolder(dirs));}catch(e){if(e.code!=='ENOENT')throw e;}
    const ids=new Set(names.filter(name=>name.endsWith('.json')&&validId(name.slice(0,-5))).map(name=>name.slice(0,-5)));
    if(volatile)ids.add(volatile.item.id);
    const pending=[];
    for(const id of ids){
      const memory=volatile?.item.id===id,request=memory?volatile:await readRequest(dirs,id).catch(e=>{
        if(e instanceof SyntaxError)return null;throw e;
      });
      if(request?.state==='received'&&request.item?.id===id&&typeof request.item.chatKey==='string'){
        if(await store.readRecord(id)&&await exists(store.png(id)))continue;
        const bytes=memory?request.png.length:(await fs.stat(requestFile(dirs,id))).size;
        const pngBytes=await fs.stat(store.png(id)).then(x=>x.size,e=>{if(e.code==='ENOENT')return 0;throw e;});
        pending.push({id,chatKey:request.item.chatKey,created:request.item.created,bytes:bytes+pngBytes});
      }else if(['submitted','rejected'].includes(request?.state)&&typeof request.chatKey==='string'){
        // A failed recovery can leave files even if the journal still says "submitted".
        const [png,record]=await Promise.all([fileStat(store.png(id)),fileStat(store.record(id))]);
        if((png||record)&&!(png&&record&&await store.readRecord(id))){
          pending.push({id,chatKey:request.chatKey,request:request.state,orphaned:true,
            created:(png??record).mtime.toISOString(),bytes:(png?.size??0)+(record?.size??0)});
        }else if(includeUncertain)pending.push({id,chatKey:request.chatKey,request:request.state});
      }
    }
    return pending;
  }
  async function readDraftState(dirs,key){
    try{
      const value=JSON.parse(await fs.readFile(workFile(dirs,key),'utf8'));
      return {revision:value?.revision??null,work:value?.deleted?null:value?.work??null,deleted:value?.deleted===true};
    }catch(e){if(e.code==='ENOENT')return {revision:null,work:null,deleted:false};throw e;}
  }
  async function finishGeneration(ctx,item,png){
    const {store,dirs}=ctx,id=item.id;
    const entries=await store.ready();
    await writeAtomic(store.png(id),png);
    await writeAtomic(store.record(id),JSON.stringify(item));
    await store.save([...entries.filter(entry=>entry.id!==id),metaOf(item)]);
    // If cleanup fails, the completed record still wins. Deletion removes any recovery data first.
    await unlinkQuiet(requestFile(dirs,id)).catch(()=>{});
  }
  async function generationState(ctx,id,{recover=false}={}){
    if(active.get(ctx.user)?.id===id)return {state:'processing'};
    return serial(ctx.user,async()=>{
      if(active.get(ctx.user)?.id===id)return {state:'processing'};
      const item=await ctx.store.readRecord(id);
      if(item&&await exists(ctx.store.png(id)))return {state:'complete',item};
      const volatile=unsaved.get(ctx.user);
      const pending=volatile?.item.id===id?volatile:await readRequest(ctx.dirs,id);
      // 0.1.22: a request discarded before its result was known stays "unconfirmed" — it may still have been charged.
      if(['rejected','discarded'].includes(pending?.state))return {state:pending.state,...(pending.state==='discarded'&&pending.unconfirmed===true?{unconfirmed:true}:{})};
      if(pending?.state!=='received')return {state:pending||item?'unknown':'missing'};
      if(!recover)return {state:'save-failed'};
      try{
        await finishGeneration(ctx,pending.item,Buffer.isBuffer(pending.png)?pending.png:Buffer.from(pending.png,'base64'));
        if(volatile===pending)unsaved.delete(ctx.user);
        return {state:'complete',item:pending.item};
      }catch{return {state:'save-failed'};}
    });
  }
  const features=['paged-history','delete','private-records','all-history','history-kinds','privacy-controls','draft-work','draft-delete','free-text','draft-tombstone','nai-error-codes','account-shape','generation-recovery','pending-history','delete-check','history-ids','delete-cleared'];
  return {
    generation:async(req,res)=>{try{
      const ctx=context(req),recover=req.method==='POST',id=recover?req.body?.requestId:req.query?.requestId;
      if(!recover&&req.query?.chatKey!==undefined){
        const key=chatKeyOf(req.query.chatKey);
        return res.json(await serial(ctx.user,async()=>({pending:(await pendingRequests(ctx)).filter(entry=>entry.chatKey===key)})));
      }
      if(!validId(id))throw fail400('요청 ID가 잘못됐어요.');
      res.json(await generationState(ctx,id,{recover}));
    }catch(e){fail(res,e);}},
    deleteCheck:async(req,res)=>{try{
      const ctx=context(req),{dirs,user,store}=ctx,b=req.body??{},all=b.all===true,chatKey=deletionKey(b.chatKey,all),ids=b.ids??[];
      if(!Array.isArray(ids)||ids.length>500||ids.some(id=>!validId(id)))throw fail400('확인할 이미지 ID가 잘못됐어요.');
      const result=await serial(user,async()=>{
        const entries=await store.ready(),pending=await pendingRequests(ctx),pictures=[...entries,...pending];
        const present=new Set(pictures.map(entry=>entry.id)),absent=[],unconfirmed=[];
        for(const id of new Set(ids)){
          if(present.has(id)||active.get(user)?.id===id)continue;
          const files=[store.png(id),store.record(id)];
          if((await Promise.all(files.map(fileStat))).some(Boolean))continue;
          absent.push(id);
          const request=await readRequest(dirs,id).catch(e=>{if(e instanceof SyntaxError)return null;throw e;});
          if(request?.state==='submitted'||request?.state==='discarded'&&request.unconfirmed===true)unconfirmed.push(id);
        }
        const draft=all?await readDraftState(dirs,chatKey):null;
        const remaining=pictures.some(entry=>entry.chatKey===chatKey)||active.get(user)?.chatKey===chatKey;
        return {absent,remaining,...(unconfirmed.length?{unconfirmed}:{}),...(draft?{draftDeleted:draft.deleted,draftRevision:draft.revision}:{})};
      });
      res.json(result);
    }catch(e){fail(res,e);}},
    draft:async(req,res)=>{try{
      const {dirs,user}=context(req),body=req.body??{};
      // delete+all removes every saved work of this user (settings → 저장된 작업 모두 지우기).
      if(req.method==='POST'&&body.delete===true&&body.all===true){
        const count=await serial(user,async()=>{let names=[];try{names=await fs.readdir(workFolder(dirs));}catch(e){if(e.code!=='ENOENT')throw e;}
          let n=0;for(const name of names)if(/^[0-9a-f]{64}\.json$/.test(name)&&(await tombstone(path.join(workFolder(dirs),name))).had)n++;return n;});
        return res.json({deleted:count});
      }
      const chatKey=chatKeyOf(req.method==='POST'?body.chatKey:req.query?.chatKey);
      const folder=workFolder(dirs),file=workFile(dirs,chatKey);
      const value=await serial(user,async()=>{
        if(req.method==='POST'&&body.delete===true){const t=await tombstone(file);return {revision:t.revision,deleted:t.had};}
        let old=null;try{old=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
        if(req.method!=='POST')return {revision:old?.revision??null,work:old?.deleted?null:old?.work??null,...(old?.deleted?{deleted:true}:{})};
        if(body.expectedRevision!==(old?.revision??null))throw new PublicError('다른 창이나 기기에서 작업이 바뀌었어요. 현재 작업은 화면에 유지했어요.',409);
        if(JSON.stringify(body).length>1100000)throw fail400('작업 내용이 너무 커요.');
        let work;try{work=packWork(body.work,{retainRaw:body.retainRawExtraction===true});}catch(e){throw fail400(e.message);}
        const next={revision:randomUUID(),work};await fs.mkdir(folder,{recursive:true});await writeAtomic(file,JSON.stringify(next));return {revision:next.revision};
      });res.json(value);
    }catch(e){fail(res,e);}},
    // quick=1: version check only, without calling NovelAI (used by the UI on panel open).
    status:async(req,res)=>{try{const {key}=context(req),secret=key();
      if(req.query?.quick==='1'||!secret)return res.json({keyConfigured:!!secret,version:SERVER_VERSION,features,minClient:MIN_CLIENT_VERSION});
      res.json({keyConfigured:true,version:SERVER_VERSION,features,minClient:MIN_CLIENT_VERSION,subscription:await subscription(secret,{shape:req.query?.shape==='1'})});}catch(e){fail(res,e);}},
    history:async(req,res)=>{try{
      // 0.1.22: POST takes the same fields in the body, plus `ids` (only these pictures, e.g. the extension's favorites).
      const q=req.method==='POST'?(req.body&&typeof req.body==='object'?req.body:{}):(req.query??{});
      const ctx=context(req),{user,store}=ctx,chatKey=String(q.chatKey??''),all=q.scope==='all';
      const offset=Math.max(0,Number.parseInt(q.offset??'0',10)||0),limit=Math.min(100,Math.max(1,Number.parseInt(q.limit??'20',10)||20));
      let only=null;
      if(req.method==='POST'&&q.ids!==undefined){
        if(!Array.isArray(q.ids)||q.ids.length>5000||q.ids.some(id=>!validId(id)))throw fail400('이미지 ID 목록이 잘못됐어요.');
        only=new Set(q.ids);
      }
      const page=await serial(user,async()=>{
        const records=await store.ready();
        // Filter before pagination and summaries; drawing mode never changes history scope.
        const every=q.kind==='chat'?records.filter(e=>e.chatKey!==JSON.stringify({free:true})):records;
        // scope=all lists every chat (optionally one chat via chatKey) so images of deleted or renamed chats can be cleaned up.
        const inScope=every.filter(e=>all?(!chatKey||e.chatKey===chatKey):e.chatKey===chatKey);
        const entries=(only?inScope.filter(e=>only.has(e.id)):inScope).sort((a,b)=>b.created.localeCompare(a.created));
        const items=[];
        for(const entry of entries.slice(offset,offset+limit)){const item=await store.readRecord(entry.id);if(item)items.push(item);}
        const pending=(await pendingRequests(ctx)).filter(e=>q.kind!=='chat'||e.chatKey!==JSON.stringify({free:true}));
        const scopedPending=pending.filter(e=>all?(!chatKey||e.chatKey===chatKey):e.chatKey===chatKey).sort((a,b)=>String(b.created).localeCompare(String(a.created)));
        // An ID list shows saved pictures only; the unfiltered count stays for "delete all" questions.
        const pendingItems=only?[]:scopedPending;
        const pendingBytes=pendingItems.reduce((sum,e)=>sum+e.bytes,0);
        const page={items,total:entries.length,offset,limit,hasMore:offset+limit<entries.length,pending:pendingItems,pendingBytes,
          ...(only?{filtered:true,unfilteredCount:inScope.length+scopedPending.length}:{})};
        if(!all)return page;
        const chats=new Map();
        for(const e of [...every,...pending]){const c=chats.get(e.chatKey)??{chatKey:e.chatKey,count:0,latest:''};c.count++;if(e.created>c.latest)c.latest=e.created;chats.set(e.chatKey,c);}
        let bytes=pending.reduce((sum,e)=>sum+e.bytes,0);
        for(const e of every){try{bytes+=(await fs.stat(store.png(e.id))).size;}catch{}}
        return {...page,scope:'all',kind:q.kind==='chat'?'chat':'all',chats:[...chats.values()].sort((a,b)=>b.latest.localeCompare(a.latest)),imageCount:every.length+pending.length,bytes};
      });
      res.json(page);
    }catch(e){fail(res,e);}},
    delete:async(req,res)=>{try{
      const ctx=context(req),{user,store,dirs}=ctx,b=req.body??{},all=b.all===true,chatKey=deletionKey(b.chatKey,all);
      const ids=all?[]:b.ids;
      if(!all&&(!Array.isArray(ids)||!ids.length||ids.length>500||ids.some(id=>typeof id!=='string'||!ID.test(id))))throw fail400('삭제할 이미지 ID가 잘못됐어요.');
      const result=await serial(user,async()=>{
        const entries=await store.ready(),pending=await pendingRequests(ctx,{includeUncertain:all}),wanted=new Set(ids),deleted=[],skipped=[],failed=[],keep=[],cleared=[],unconfirmed=[];
        for(const entry of entries){
          if(entry.chatKey!==chatKey||(!all&&!wanted.has(entry.id))){keep.push(entry);continue;}
          wanted.delete(entry.id);
          try{
            await unlinkQuiet(store.png(entry.id));
            await unlinkQuiet(store.record(entry.id));
            await unlinkQuiet(requestFile(dirs,entry.id));
            deleted.push(entry.id);
          }catch{failed.push(entry.id);keep.push(entry);}
        }
        const indexed=new Set(entries.map(entry=>entry.id));
        for(const entry of pending){
          if(indexed.has(entry.id)||entry.chatKey!==chatKey||(!all&&!wanted.has(entry.id)))continue;
          wanted.delete(entry.id);
          if(active.get(user)?.id===entry.id){failed.push(entry.id);continue;}
          // The journal state describes the upstream result. Count local file removal separately.
          const sentUnknown=entry.request==='submitted';
          try{
            const removedPng=await unlinkQuiet(store.png(entry.id));
            const removedRecord=await unlinkQuiet(store.record(entry.id));
            // Keep only the ID marker so a delayed retry can't send the discarded request again.
            await writeAtomic(requestFile(dirs,entry.id),JSON.stringify({state:'discarded',...(sentUnknown?{unconfirmed:true}:{})}));
            if(unsaved.get(user)?.item.id===entry.id)unsaved.delete(user);
            if(entry.request&&!removedPng&&!removedRecord)cleared.push(entry.id);
            else deleted.push(entry.id);
            if(sentUnknown)unconfirmed.push(entry.id);
          }catch{failed.push(entry.id);}
        }
        const current=active.get(user);
        if(all&&current?.chatKey===chatKey&&!failed.includes(current.id))failed.push(current.id);
        for(const id of wanted)skipped.push(id);
        if(deleted.length)await store.save(keep).catch(()=>{}); // ready() rebuilds after record removal
        let workDeleted=false,workDeleteFailed=false;
        if(all&&!failed.length){try{workDeleted=(await tombstone(workFile(dirs,chatKey))).had;}catch{workDeleteFailed=true;}}
        return {deleted,skipped,workDeleted,...(cleared.length||unconfirmed.length?{cleared,unconfirmed}:{}),...(failed.length?{failed}:{}),...(workDeleteFailed?{workDeleteFailed:true}:{})};
      });
      res.json(result);
    }catch(e){fail(res,e);}},
    generate:async(req,res)=>{
      let user,requestId,ownsLock=false,submitted=false;
      try {
        const ctx=context(req);user=ctx.user;const b=req.body;
        if(!b || !validId(b.requestId))throw fail400('요청 ID 또는 채팅 정보가 잘못됐어요.');
        chatKeyOf(b.chatKey);
        requestId=b.requestId;
        // 0.1.18: the situation text is checked on its own, before NovelAI is called, and is never dropped silently.
        const free=b.snapshot?.freeText;
        if(free!==undefined&&free!==null){
          if(typeof free!=='string')throw new PublicError('상황 글 형식이 잘못됐어요.',400);
          if(free.length>FREE_TEXT_STORED_LIMIT||visibleLength(free)>FREE_TEXT_LIMIT)throw new PublicError(`상황 글이 너무 길어요. 화면에 보이는 글자 기준 ${FREE_TEXT_LIMIT.toLocaleString('en-US')}자까지예요.`,400);
        }
        const {freeText:_free,...restSnapshot}=b.snapshot&&typeof b.snapshot==='object'?b.snapshot:{};
        if(JSON.stringify({...b,snapshot:b.snapshot&&typeof b.snapshot==='object'?restSnapshot:b.snapshot}).length>250000)throw new PublicError('요청 크기가 너무 커요.',400);
        await serial(user,()=>ctx.store.ready());
        if(active.has(user))throw new PublicError('이 계정에서 이미 생성 중이에요. 완료 후 다시 시도해 주세요.',409);
        active.set(user,{id:requestId,chatKey:b.chatKey});
        ownsLock=true;
        const old=await ctx.store.readRecord(requestId);
        if(old){
          if(await exists(ctx.store.png(requestId)))return res.json(old);
          throw new PublicError('이 요청의 그림 파일을 확인하지 못했어요. 같은 요청의 상태를 확인해 주세요.',409,'generation-check');
        }
        if(await readRequest(ctx.dirs,requestId))throw new PublicError('이미 보낸 요청이에요. 같은 요청의 결과를 확인해 주세요.',409,'generation-check');
        let assembled,payload;
        try{assembled=validateAssembled(b.assembled,b.options?.model);payload=buildPayload(assembled,b.options);}catch(e){throw fail400(e.message);}
        const secret=ctx.key();
        let sub=null;
        try{sub=await subscription(secret);}catch(e){if(b.allowAnlas!==true)throw e;}
        if(!secret)throw new PublicError('NAI 키가 없어요.',400);
        const guard=costGuard(b.options,sub);
        // The extension's own consent block, distinct from NovelAI's errors (428, code anlas-consent).
        if(!guard.free && b.allowAnlas!==true)throw new PublicError(`${guard.message} Anlas 사용 허용이 꺼져 있어서 보내지 않았어요.`,428,'anlas-consent');
        const item={id:requestId,created:new Date().toISOString(),chatKey:b.chatKey,
          image:`/user/images/naice-shot/${requestId}.png`,seed:b.options.seed,options:b.options,assembled,
          snapshot:b.snapshot&&typeof b.snapshot==='object'?{scene:b.snapshot.scene??null,
            // 프리샷 images keep their situation text so restoring from history brings it back.
            ...(b.snapshot.mode==='free'?{mode:'free',...(typeof b.snapshot.freeText==='string'&&b.snapshot.freeText.length<=FREE_TEXT_STORED_LIMIT&&visibleLength(b.snapshot.freeText)<=FREE_TEXT_LIMIT?{freeText:b.snapshot.freeText}:{})}:{}),
            ...(b.retainRawExtraction===true&&typeof b.snapshot.rawExtraction==='string'?{rawExtraction:stripReasoningBlocks(b.snapshot.rawExtraction)}:{})}:null,payload,version:SERVER_VERSION};
        const journal=requestFile(ctx.dirs,requestId);
        await fs.mkdir(requestFolder(ctx.dirs),{recursive:true});
        // Persist the ID before calling NovelAI. A restart or ambiguous response never resends this ID.
        try{await fs.writeFile(journal,JSON.stringify({state:'submitted',chatKey:b.chatKey}),{flag:'wx'});}
        catch(e){if(e.code==='EEXIST')throw new PublicError('이미 보낸 요청이에요. 같은 요청의 결과를 확인해 주세요.',409,'generation-check');throw e;}
        submitted=true;
        const upstream=await fetcher(`${ORIGIN}/ai/generate-image`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},
          body:JSON.stringify(payload),signal:AbortSignal.timeout(timeoutMs)});
        if(!upstream.ok) {
          // Do not return or log upstream account details or submitted RP text; only NovelAI's short note.
          let body='';try{body=(await readLimited(upstream,4096)).toString();}catch{}
          const definite=[400,401,402,403,404,405,413,415,422,429].includes(upstream.status);
          if(definite)await writeAtomic(journal,JSON.stringify({state:'rejected',chatKey:b.chatKey})).catch(()=>{});
          const error=naiError(upstream.status,body);
          if(!definite&&upstream.status<500)throw new PublicError('NovelAI 생성 결과를 확인하지 못했어요. 같은 요청의 상태를 확인해 주세요.',502,'generation-check');
          throw error;
        }
        const png=extractPng(await readLimited(upstream,30*1024*1024));
        const pending={state:'received',item,png};
        let recorded=false;
        try{
          await writeAtomic(journal,JSON.stringify({...pending,png:png.toString('base64')}));
          recorded=true;
          await serial(user,()=>finishGeneration(ctx,item,png));
        }catch{
          // Keep the last result in memory if the disk could not stage it at all.
          if(!recorded)unsaved.set(user,pending);
          throw new PublicError('그림은 받았지만 서버에 저장하지 못했어요. 같은 요청으로 저장을 다시 시도해 주세요.',500,'generation-save');
        }
        res.json(item);
      }catch(e){
        if(e.name==='TimeoutError'||e.name==='AbortError')e=new PublicError('NAI 응답 시간이 초과됐어요. 실제 생성·차감 여부는 NAI에서 확인해 주세요. 자동 재요청하지 않았어요.',504,'generation-check');
        if(!(e instanceof PublicError))e=submitted?new PublicError('NovelAI 생성 결과를 확인하지 못했어요. 같은 요청의 상태를 확인해 주세요.',502,'generation-check'):new PublicError('서버에 요청을 준비하지 못했어요. NovelAI로 보내지 않았어요.',500,'generation-not-sent');
        fail(res,e);
      }finally{if(ownsLock)active.delete(user);}
    },
  };
}
