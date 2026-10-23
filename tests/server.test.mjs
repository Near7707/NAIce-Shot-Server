import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHandlers,extractPng} from '../handlers.mjs';
import {DEFAULTS} from '../core.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz8AAAAASUVORK5CYII=','base64');
function archive(data) {
  const name=Buffer.from('image_0.png'),packed=deflateRawSync(data),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(8,8);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(8,10);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
  const start=local.length+name.length+packed.length;end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(start,16);
  return Buffer.concat([local,name,packed,central,name,end]);
}
function response() {return {statusCode:200,body:null,status(n){this.statusCode=n;return this;},json(data){this.body=data;return this;}};}
async function setup(t,fetcher) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'naice-shot-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const user={directories:{root,userImages:path.join(root,'images')}};
  const req={user,body:{requestId:randomUUID(),chatKey:'chat-A',allowAnlas:true,options:{...DEFAULTS.options,seed:123},assembled:{base:'1boy',negative:'bad quality',characters:[{id:'leo',name:'Leo',prompt:'boy, brown hair',negative:'black hair',position:'auto',outfit:'shirt'}]},snapshot:{scene:{location:'cafe'}}}};
  let calls=0;const requests=[];
  const handlers=createHandlers({readKey:()=> 'test-secret-do-not-leak',fetcher:async(url,options)=>{
    requests.push({url,options});
    if(url.endsWith('/subscription'))return new Response(JSON.stringify({tier:3,perks:{unlimitedImageGeneration:true},trainingStepsLeft:{fixedTrainingStepsLeft:10000}}));
    calls++;return fetcher?fetcher(url,options):new Response(archive(png));
  }});
  return {handlers,req,requests,calls:()=>calls,root};
}
test('ZIP PNG extraction accepts deflated files and rejects malformed archives',()=>{
  assert.deepEqual(extractPng(archive(png)),png);assert.throws(()=>extractPng(Buffer.from('not a zip')));assert.throws(()=>extractPng(archive(Buffer.from('not png'))));
});
test('server sends individual positive/negative slots, stores PNG and exact request, and deduplicates completed IDs',async t=>{
  const s=await setup(t);const res=response();await s.handlers.generate(s.req,res);assert.equal(res.statusCode,200);assert.equal(s.calls(),1);
  assert.deepEqual(await fs.readFile(path.join(s.root,'images','naice-shot',`${res.body.id}.png`)),png);
  assert.equal(res.body.payload.parameters.v4_negative_prompt.caption.char_captions[0].char_caption,'black hair');
  assert.doesNotMatch(JSON.stringify(res.body),/test-secret/);
  const again=response();await s.handlers.generate(s.req,again);assert.equal(again.body.id,res.body.id);assert.equal(s.calls(),1);
});
test('unknown V5 free eligibility is blocked on the server before image request',async t=>{
  const s=await setup(t);s.req.body.allowAnlas=false;const res=response();await s.handlers.generate(s.req,res);assert.equal(res.statusCode,402);assert.equal(s.calls(),0);
  s.req.body.allowAnlas=true;const next=response();await s.handlers.generate(s.req,next);assert.equal(next.statusCode,200);
});
test('concurrent rejection does not release another request’s lock; completion does release it',async t=>{
  let finish;const blocked=new Promise(resolve=>{finish=resolve;});let started;const ready=new Promise(resolve=>{started=resolve;});
  const s=await setup(t,async()=>{started();await blocked;return new Response(archive(png));});
  const first=response();const pending=s.handlers.generate(s.req,first);await ready;
  const another=()=>({...s.req,body:{...s.req.body,requestId:randomUUID()}});
  const second=response();await s.handlers.generate(another(),second);assert.equal(second.statusCode,409);
  const third=response();await s.handlers.generate(another(),third);assert.equal(third.statusCode,409);assert.equal(s.calls(),1);
  finish();await pending;const next=response();await s.handlers.generate(another(),next);assert.equal(next.statusCode,200);assert.equal(s.calls(),2);
});
test('generation errors are never automatically retried, and request IDs cannot be paths',async t=>{
  const s=await setup(t,()=>new Response('busy',{status:429}));const res=response();await s.handlers.generate(s.req,res);assert.equal(res.statusCode,429);assert.equal(s.calls(),1);
  s.req.body.requestId='../../secrets';const bad=response();await s.handlers.generate(s.req,bad);assert.equal(bad.statusCode,400);assert.equal(s.calls(),1);
});
test('history filters by originating chat and returns no other user’s data',async t=>{
  const s=await setup(t);await s.handlers.generate(s.req,response());
  const a=response();await s.handlers.history({...s.req,query:{chatKey:'chat-A'}},a);assert.equal(a.body.items.length,1);
  const b=response();await s.handlers.history({...s.req,query:{chatKey:'chat-B'}},b);assert.equal(b.body.items.length,0);
  const other=response();await s.handlers.history({user:{directories:{root:path.join(s.root,'other'),userImages:path.join(s.root,'other','images')}},query:{chatKey:'chat-A'}},other);assert.equal(other.body.items.length,0);
});
test('missing key is reported without exposing an account token',async t=>{
  const s=await setup(t),handlers=createHandlers({readKey:()=>null});const res=response();await handlers.status(s.req,res);assert.equal(res.body.keyConfigured,false);
  const bad=response();await handlers.generate(s.req,bad);assert.equal(bad.statusCode,400);
});
test('server entry imports at the actual ST plugin depth and registers the documented routes',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'naice-shot-host-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'src','endpoints'),{recursive:true});
  await fs.writeFile(path.join(root,'package.json'),'\{"type":"module"\}');
  await fs.writeFile(path.join(root,'src','endpoints','secrets.js'),'export const SECRET_KEYS={NOVEL:"novel"}; export function readSecret(){return null;}');
  const target=path.join(root,'plugins','naice-shot-server');await fs.cp(new URL('../',import.meta.url),target,{recursive:true,filter:src=>!/[\\/](\.git|tests|node_modules)([\\/]|$)/.test(path.relative(fileURLToPath(new URL('../',import.meta.url)),src)?'/'+path.relative(fileURLToPath(new URL('../',import.meta.url)),src):'')});
  const plugin=await import(pathToFileURL(path.join(target,'index.mjs')).href);const routes=[];
  await plugin.init({get:(route,handler)=>routes.push(['GET',route,handler]),post:(route,handler)=>routes.push(['POST',route,handler])});
  assert.equal(plugin.info.id,'naice-shot');assert.deepEqual(routes.map(r=>r.slice(0,2)),[['GET','/status'],['GET','/history'],['POST','/generate'],['POST','/delete']]);
});

const gen=async(s,chatKey='chat-A')=>{const res=response();await s.handlers.generate({...s.req,body:{...s.req.body,requestId:randomUUID(),chatKey}},res);assert.equal(res.statusCode,200);return res.body;};
const hist=async(s,query)=>{const res=response();await s.handlers.history({...s.req,query},res);return res.body;};
const del=async(s,body)=>{const res=response();await s.handlers.delete({...s.req,body},res);return res;};
test('records are kept out of the web-served images folder; only the PNG is public',async t=>{
  const s=await setup(t);const item=await gen(s);
  const publicFiles=await fs.readdir(path.join(s.root,'images','naice-shot'));
  assert.deepEqual(publicFiles,[`${item.id}.png`]);
  const record=JSON.parse(await fs.readFile(path.join(s.root,'naice-shot-records',`${item.id}.json`),'utf8'));
  assert.equal(record.assembled.base,'1boy');
});
test('v0.3 records in the images folder are migrated once and stay readable',async t=>{
  const s=await setup(t);const folder=path.join(s.root,'images','naice-shot');await fs.mkdir(folder,{recursive:true});
  const id=randomUUID(),old={id,created:'2026-10-01T00:00:00.000Z',chatKey:'chat-A',image:`/user/images/naice-shot/${id}.png`,seed:7,options:{model:'nai-diffusion-5-full'},assembled:{base:'',negative:'',characters:[]}};
  await fs.writeFile(path.join(folder,`${id}.json`),JSON.stringify(old));await fs.writeFile(path.join(folder,`${id}.png`),png);
  const page=await hist(s,{chatKey:'chat-A'});
  assert.equal(page.total,1);assert.equal(page.items[0].id,id);
  assert.equal(await fs.access(path.join(folder,`${id}.json`)).then(()=>true,()=>false),false,'public JSON removed');
  assert.equal(await fs.access(path.join(s.root,'naice-shot-records',`${id}.json`)).then(()=>true,()=>false),true);
});
test('history pages newest first and reports the per-chat total',async t=>{
  const s=await setup(t);const ids=[];for(let i=0;i<5;i++){ids.push((await gen(s)).id);await new Promise(r=>setTimeout(r,3));}
  await gen(s,'chat-B');
  const first=await hist(s,{chatKey:'chat-A',limit:'2'});
  assert.equal(first.total,5);assert.equal(first.hasMore,true);assert.deepEqual(first.items.map(x=>x.id),[ids[4],ids[3]]);
  const last=await hist(s,{chatKey:'chat-A',limit:'2',offset:'4'});
  assert.deepEqual(last.items.map(x=>x.id),[ids[0]]);assert.equal(last.hasMore,false);
});
test('delete removes PNG and record for the given ids, never another chat’s image',async t=>{
  const s=await setup(t);const a1=await gen(s),a2=await gen(s),b1=await gen(s,'chat-B');
  const res=await del(s,{chatKey:'chat-A',ids:[a1.id,b1.id]});
  assert.equal(res.statusCode,200);assert.deepEqual(res.body.deleted,[a1.id]);assert.deepEqual(res.body.skipped,[b1.id]);
  const files=await fs.readdir(path.join(s.root,'images','naice-shot'));
  assert.ok(!files.includes(`${a1.id}.png`));assert.ok(files.includes(`${a2.id}.png`)&&files.includes(`${b1.id}.png`));
  assert.equal((await hist(s,{chatKey:'chat-A'})).total,1);assert.equal((await hist(s,{chatKey:'chat-B'})).total,1);
});
test('delete all clears only the requesting chat and validates input',async t=>{
  const s=await setup(t);await gen(s);await gen(s);const b=await gen(s,'chat-B');
  const res=await del(s,{chatKey:'chat-A',all:true});assert.equal(res.body.deleted.length,2);
  assert.equal((await hist(s,{chatKey:'chat-A'})).total,0);assert.deepEqual((await hist(s,{chatKey:'chat-B'})).items.map(x=>x.id),[b.id]);
  for(const body of [{chatKey:'chat-A'},{chatKey:'chat-A',ids:[]},{chatKey:'chat-A',ids:['../../secrets']},{ids:[b.id]},{chatKey:'chat-A',all:'yes'}]){
    const bad=await del(s,body);assert.equal(bad.statusCode,400,JSON.stringify(body));
  }
  assert.equal((await hist(s,{chatKey:'chat-B'})).total,1,'invalid requests delete nothing');
});
test('a corrupted or stale index rebuilds itself from the records',async t=>{
  const s=await setup(t);const a=await gen(s);await gen(s);
  await fs.writeFile(path.join(s.root,'naice-shot-records','index.json'),'{broken');
  assert.equal((await hist(s,{chatKey:'chat-A'})).total,2);
  await fs.unlink(path.join(s.root,'naice-shot-records',`${a.id}.json`)); // removed by hand
  assert.equal((await hist(s,{chatKey:'chat-A'})).total,1);
});
test('deleting while another request writes keeps both changes',async t=>{
  const s=await setup(t);const a=await gen(s);
  const [gone,fresh]=await Promise.all([del(s,{chatKey:'chat-A',ids:[a.id]}),gen(s)]);
  assert.deepEqual(gone.body.deleted,[a.id]);
  assert.deepEqual((await hist(s,{chatKey:'chat-A'})).items.map(x=>x.id),[fresh.id]);
});

test('scope=all lists every chat with per-chat counts and total size, and can filter one chat',async t=>{
  const s=await setup(t);const a1=await gen(s),a2=await gen(s);await new Promise(r=>setTimeout(r,3));const b1=await gen(s,'chat-B');
  const all=await hist(s,{scope:'all',limit:'100'});
  assert.equal(all.total,3);assert.equal(all.imageCount,3);assert.equal(all.scope,'all');
  assert.equal(all.items[0].id,b1.id,'newest first across chats');
  assert.deepEqual(all.chats.map(c=>[c.chatKey,c.count]),[['chat-B',1],['chat-A',2]]);
  assert.equal(all.bytes,png.length*3);
  const onlyA=await hist(s,{scope:'all',chatKey:'chat-A'});assert.equal(onlyA.total,2);assert.equal(onlyA.chats.length,2,'summary still covers every chat');
  const plain=await hist(s,{chatKey:'chat-A'});assert.equal(plain.chats,undefined,'per-chat history unchanged');
  await fs.unlink(path.join(s.root,'images','naice-shot',`${a1.id}.png`));
  assert.equal((await hist(s,{scope:'all'})).bytes,png.length*2,'missing files count as zero bytes but stay listed for cleanup');
  assert.equal((await hist(s,{scope:'all'})).total,3);
});


test('server requires explicit raw-retention consent and strips reasoning in persisted records',async t=>{
  const s=await setup(t);
  const raw='<think>PRIVATE_REASONING</think>{"location":"cafe"}<analysis>SECOND_SECRET</analysis>';
  for(const flag of [undefined,false,'true',true]){
    const body={...s.req.body,requestId:randomUUID(),retainRawExtraction:flag,snapshot:{scene:{location:'cafe'},rawExtraction:raw}};
    const res=response();await s.handlers.generate({...s.req,body},res);assert.equal(res.statusCode,200);
    const stored=JSON.parse(await fs.readFile(path.join(s.root,'naice-shot-records',body.requestId+'.json'),'utf8'));
    if(flag===true){assert.equal(stored.snapshot.rawExtraction,'{"location":"cafe"}');assert.equal(res.body.snapshot.rawExtraction,stored.snapshot.rawExtraction);}
    else assert.equal('rawExtraction' in stored.snapshot,false);
    assert.equal(JSON.stringify(stored).includes('PRIVATE_REASONING'),false);
  }
});

test('filesystem and unexpected provider errors never expose paths, keys or arbitrary status/messages',async t=>{
  const s=await setup(t),file=path.join(s.root,'private-user-folder');await fs.writeFile(file,'not a directory');
  const res=response();await s.handlers.history({user:{directories:{root:s.root,userImages:file}},query:{}},res);
  assert.equal(res.statusCode,500);assert.doesNotMatch(JSON.stringify(res.body),/private-user-folder|ENOTDIR|\/tmp\//);
  const handlers=createHandlers({readKey:()=>{throw Object.assign(new Error('C:\\Users\\PrivateName secret-token'),{status:403});}});
  const unexpected=response();await handlers.status(s.req,unexpected);
  assert.equal(unexpected.statusCode,500);assert.doesNotMatch(JSON.stringify(unexpected.body),/PrivateName|secret-token/);
});
