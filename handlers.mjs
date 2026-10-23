import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { buildPayload, costGuard, MODELS, stripReasoningBlocks } from './core.mjs';

class PublicError extends Error {
  constructor(message,status=400){super(message);this.status=status;}
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
const SERVER_VERSION='0.1.7';
// Oldest UI that works with this server. Raise it when a server change needs a newer UI.
const MIN_CLIENT_VERSION='0.1.0';
const RECORDS_DIR='naice-shot-records',INDEX_FILE='index.json';
const fail400=message=>new PublicError(message,400);
const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};
async function unlinkQuiet(file){try{await fs.unlink(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function writeAtomic(file,text){const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;await fs.writeFile(tmp,text);await fs.rename(tmp,file);}
async function moveFile(from,to){try{await fs.rename(from,to);}catch(e){if(e.code!=='EXDEV')throw e;await fs.copyFile(from,to,fs.constants.COPYFILE_EXCL);await fs.unlink(from);}}
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
  const active=new Set(),queues=new Map();
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
  const subscription=async key=>{
    if(!key)throw new PublicError('실리태번 API 연결 화면에 NAI 키를 먼저 저장해 주세요.',400);
    const response=await fetcher(`${ORIGIN}/user/subscription`,{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new PublicError(`NAI 계정 확인 실패 (${response.status}).`,response.status===401?401:502);
    const data=JSON.parse((await readLimited(response,100000)).toString());
    // Forward only fields necessary for eligibility; never expose keys or full account data.
    return {tier:data.tier,perks:{unlimitedImageGeneration:data.perks?.unlimitedImageGeneration===true},
      anlas:{subscription:data.trainingStepsLeft?.fixedTrainingStepsLeft??null,purchased:data.trainingStepsLeft?.purchasedTrainingSteps??null}};
  };
  const fail=(res,e)=>res.status(e instanceof PublicError?e.status:500).json({error:e instanceof PublicError?e.message:'요청 처리 중 내부 오류가 발생했어요. 설치 경로와 파일 접근 권한을 확인해 주세요.'});
  const chatKeyOf=value=>{if(typeof value!=='string'||!value||value.length>1000)throw fail400('채팅 정보가 잘못됐어요.');return value;};
  const features=['paged-history','delete','private-records','all-history','privacy-controls'];
  return {
    // quick=1: version check only, without calling NovelAI (used by the UI on panel open).
    status:async(req,res)=>{try{const {key}=context(req),secret=key();
      if(req.query?.quick==='1'||!secret)return res.json({keyConfigured:!!secret,version:SERVER_VERSION,features,minClient:MIN_CLIENT_VERSION});
      res.json({keyConfigured:true,version:SERVER_VERSION,features,minClient:MIN_CLIENT_VERSION,subscription:await subscription(secret)});}catch(e){fail(res,e);}},
    history:async(req,res)=>{try{
      const {user,store}=context(req),chatKey=String(req.query?.chatKey??''),all=req.query?.scope==='all';
      const offset=Math.max(0,Number.parseInt(req.query?.offset??'0',10)||0),limit=Math.min(100,Math.max(1,Number.parseInt(req.query?.limit??'20',10)||20));
      const page=await serial(user,async()=>{
        const every=await store.ready();
        // scope=all lists every chat (optionally one chat via chatKey) so images of deleted or renamed chats can be cleaned up.
        const entries=every.filter(e=>all?(!chatKey||e.chatKey===chatKey):e.chatKey===chatKey).sort((a,b)=>b.created.localeCompare(a.created));
        const items=[];
        for(const entry of entries.slice(offset,offset+limit)){const item=await store.readRecord(entry.id);if(item)items.push(item);}
        const page={items,total:entries.length,offset,limit,hasMore:offset+limit<entries.length};
        if(!all)return page;
        const chats=new Map();
        for(const e of every){const c=chats.get(e.chatKey)??{chatKey:e.chatKey,count:0,latest:''};c.count++;if(e.created>c.latest)c.latest=e.created;chats.set(e.chatKey,c);}
        let bytes=0;
        for(const e of every){try{bytes+=(await fs.stat(store.png(e.id))).size;}catch{}}
        return {...page,scope:'all',chats:[...chats.values()].sort((a,b)=>b.latest.localeCompare(a.latest)),imageCount:every.length,bytes};
      });
      res.json(page);
    }catch(e){fail(res,e);}},
    delete:async(req,res)=>{try{
      const {user,store}=context(req),b=req.body??{},chatKey=chatKeyOf(b.chatKey),all=b.all===true;
      const ids=all?[]:b.ids;
      if(!all&&(!Array.isArray(ids)||!ids.length||ids.length>500||ids.some(id=>typeof id!=='string'||!ID.test(id))))throw fail400('삭제할 이미지 ID가 잘못됐어요.');
      const result=await serial(user,async()=>{
        const entries=await store.ready(),wanted=new Set(ids),deleted=[],skipped=[],keep=[];
        for(const entry of entries){
          // Only images generated in the requesting chat can be deleted from that chat.
          if(entry.chatKey===chatKey&&(all||wanted.has(entry.id))){await unlinkQuiet(store.png(entry.id));await unlinkQuiet(store.record(entry.id));deleted.push(entry.id);wanted.delete(entry.id);}
          else keep.push(entry);
        }
        for(const id of wanted)skipped.push(id);
        if(deleted.length)await store.save(keep);
        return {deleted,skipped};
      });
      res.json(result);
    }catch(e){fail(res,e);}},
    generate:async(req,res)=>{
      let user,requestId,ownsLock=false;
      try {
        const ctx=context(req);user=ctx.user;const b=req.body;
        if(!b || !ID.test(b.requestId) || typeof b.chatKey!=='string'||b.chatKey.length>1000)throw new PublicError('요청 ID 또는 채팅 정보가 잘못됐어요.',400);
        requestId=b.requestId;
        if(JSON.stringify(b).length>250000)throw new PublicError('요청 크기가 너무 커요.',400);
        await serial(user,()=>ctx.store.ready());
        const old=await ctx.store.readRecord(requestId);if(old)return res.json(old);
        if(active.has(user))throw new PublicError('이 계정에서 이미 생성 중이에요. 완료 후 다시 시도해 주세요.',409);
        active.add(user);
        ownsLock=true;
        let assembled,payload;
        try{assembled=validateAssembled(b.assembled,b.options?.model);payload=buildPayload(assembled,b.options);}catch(e){throw fail400(e.message);}
        const secret=ctx.key();
        let sub=null;
        try{sub=await subscription(secret);}catch(e){if(b.allowAnlas!==true)throw e;}
        if(!secret)throw new PublicError('NAI 키가 없어요.',400);
        const guard=costGuard(b.options,sub);
        if(!guard.free && b.allowAnlas!==true)throw new PublicError(guard.message,402);
        const upstream=await fetcher(`${ORIGIN}/ai/generate-image`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},
          body:JSON.stringify(payload),signal:AbortSignal.timeout(timeoutMs)});
        if(!upstream.ok) {
          // Do not return or log upstream account details or submitted RP text.
          throw new PublicError(`NAI 생성 실패 (${upstream.status}). 자동 재요청하지 않았어요.`,upstream.status===429?429:502);
        }
        const png=extractPng(await readLimited(upstream,30*1024*1024));
        const item={id:requestId,created:new Date().toISOString(),chatKey:b.chatKey,
          image:`/user/images/naice-shot/${requestId}.png`,seed:b.options.seed,options:b.options,assembled,
          snapshot:b.snapshot&&typeof b.snapshot==='object'?{scene:b.snapshot.scene??null,
            ...(b.retainRawExtraction===true&&typeof b.snapshot.rawExtraction==='string'?{rawExtraction:stripReasoningBlocks(b.snapshot.rawExtraction)}:{})}:null,payload,version:SERVER_VERSION};
        await serial(user,async()=>{
          const entries=await ctx.store.ready();
          await fs.writeFile(ctx.store.png(requestId),png,{flag:'wx'});
          await fs.writeFile(ctx.store.record(requestId),JSON.stringify(item),{flag:'wx'});
          await ctx.store.save([...entries,metaOf(item)]);
        });
        res.json(item);
      }catch(e){
        if(e.name==='TimeoutError'||e.name==='AbortError')e=new PublicError('NAI 응답 시간이 초과됐어요. 실제 생성·차감 여부는 NAI에서 확인해 주세요. 자동 재요청하지 않았어요.',504);
        fail(res,e);
      }finally{if(ownsLock)active.delete(user);}
    },
  };
}
