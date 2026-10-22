import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter,once} from 'node:events';
import {PassThrough} from 'node:stream';
import {unzipSync} from 'fflate';
import {createHash} from 'node:crypto';
import {apply} from '../lib/index.js';
import {createSnapshotStore} from '../lib/snapshot.js';
import {createTrashStore} from '../lib/trash.js';
import {createMetadataStore} from '../lib/metadata.js';
import {createRecycleService} from '../lib/recycle.js';

async function fixture(t,{images=false}={}){
 const root=await mkdtemp(join(tmpdir(),'dac-transition-'));const previous=process.env.DSH_HOME;process.env.DSH_HOME=root;
 t.after(async()=>{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;await rm(root,{recursive:true,force:true})});
 const data=join(root,'plugin-data','archived-chats'),path=join(root,'sessions','old-chat','session.jsonl');await mkdir(join(root,'sessions','old-chat'),{recursive:true});await writeFile(path,'original');
 const header={id:'old-chat',version:1,cwd:root,createdAt:42};const events=[{seq:0,type:'session/title',data:{title:'Old chat'}}];
 const imageData=new Uint8Array([1,2,3,4]);
 const imageRef={attachmentId:'image-a',mediaType:'image/png',bytes:4,width:2,height:2};
 if(images)events.push({seq:1,type:'message',data:{image:imageRef}});
 const attachments={readImage:async ref=>({ref,data:imageData})};
 const persistence={list:async()=>{try{await access(path);return [header]}catch{return []}},inspect:async()=>{await access(path);return {meta:header,events}},locate:()=>({kind:'jsonl',path})};
 const registry={state:{archivedSessionIds:['old-chat']},get archivedSessionIds(){return this.state.archivedSessionIds},list:()=>[],setState:async function(s){this.state=s},unarchiveSession:async function(id){this.state.archivedSessionIds=this.state.archivedSessionIds.filter(x=>x!==id)}};
 const snapshots=createSnapshotStore({root:join(data,'snapshots'),persistence,attachments});const trash=createTrashStore({path:join(data,'trash.json')});const metadata=createMetadataStore({filePath:join(data,'metadata.json')});
 const legacy=createRecycleService({registry,persistence,snapshotStore:snapshots,trashStore:trash,metadataStore:metadata,lifecycle:{run:fn=>fn()},disposeLive:async()=>({disposition:'cold'})});
 const routes=new Map(),effects=[];const services={attachments,workspaceRegistry:registry,sessionPersistence:persistence,sessions:{get:()=>undefined},webServer:{register({path,handler}){routes.set(path,handler)}}};
 apply({get:k=>services[k],on(){},logger:{warn(){}},effect(fn,label){effects.push(label);if(!label.includes('automatic'))fn()}});
 async function call(route,body,form=false){const req=new EventEmitter();req.method=body===undefined?'GET':'POST';req.headers={'x-dsh-archived-chats':'1',...(form?{'content-type':'application/x-www-form-urlencoded'}:{})};const res=new PassThrough();let status,headers;res.writeHead=(c,h)=>{status=c;headers=h;return res};const chunks=[];res.on('data',c=>chunks.push(c));const end=once(res,'end');queueMicrotask(()=>{if(body!==undefined)req.emit('data',Buffer.from(form?new URLSearchParams(body).toString():JSON.stringify(body)));req.emit('end')});await routes.get('/plugins/dsh-archived-chats'+route)(req,res);await end;const bytes=Buffer.concat(chunks);return {status,headers,bytes,json:()=>JSON.parse(bytes)}}
 return {root,data,path,registry,snapshots,trash,legacy,effects,call,imageData};
}
test('retirement rejects new recycle requests without converting them to permanent deletes',async t=>{const f=await fixture(t);for(const [route,body] of [['/delete',{sessionId:'old-chat'}],['/delete-all',{sessionIds:['old-chat']}]] ){const r=await f.call(route,body);assert.equal(r.status,410);assert.equal(r.json().error,'recycle-retired');await access(f.path);assert.equal(await f.trash.get('old-chat'),null)} });
test('retirement never schedules cleanup and rejects stale policy actions without modifying saved policy',async t=>{const f=await fixture(t);await mkdir(f.data,{recursive:true});const policy='{ "recycleAutoDelete": true }';await writeFile(join(f.data,'retention.json'),policy);assert.ok(!f.effects.some(x=>x.includes('automatic recycle cleanup')));for(const route of ['/retention/policy/preview','/retention/policy','/retention/preview','/retention/apply'])assert.equal((await f.call(route,{})).status,410);assert.equal(await readFile(join(f.data,'retention.json'),'utf8'),policy);await access(f.path)});
test('old recycle records remain discoverable, exportable and recoverable without auto-migration',async t=>{const f=await fixture(t);assert.deepEqual((await f.legacy.move(['old-chat'])).trashed,['old-chat']);const old=await f.trash.get('old-chat');const listed=await f.call('/trash');assert.equal(listed.json().sessions[0].sessionId,'old-chat');const exported=await f.call('/trash/export',{sessionIds:JSON.stringify(['old-chat'])},true);assert.equal(exported.status,200);const files=unzipSync(exported.bytes);assert.ok(files['manifest.json']);assert.ok(files['session.json']);assert.equal(JSON.parse(Buffer.from(files['session.json'])).source.meta.id,'old-chat');assert.deepEqual(await f.trash.get('old-chat'),old);const restored=await f.call('/trash/restore',{sessionIds:['old-chat']});assert.deepEqual(restored.json().restored,['old-chat']);assert.ok(f.registry.archivedSessionIds.includes('old-chat'));await access(f.path);assert.equal(await f.trash.get('old-chat'),null)});
test('unsupported missing-original recovery preserves legacy record and exportable snapshot',async t=>{const f=await fixture(t);await f.legacy.move(['old-chat']);const old=await f.trash.get('old-chat');await rm(f.path);const restored=await f.call('/trash/restore',{sessionIds:['old-chat']});assert.equal(restored.status,409);assert.equal(restored.json().failed[0].reason,'snapshot-restore-unsupported');assert.deepEqual(await f.trash.get('old-chat'),old);assert.equal((await f.call('/trash/export',{sessionIds:JSON.stringify(['old-chat'])},true)).status,200)});
test('explicit permanent deletion remains available during retirement',async t=>{const f=await fixture(t);const r=await f.call('/delete-all',{sessionIds:['old-chat'],permanent:true});assert.deepEqual(r.json().deleted,['old-chat']);await assert.rejects(access(f.path),{code:'ENOENT'})});

test('legacy pending-only deletion remains visible for explicit retry without deleting on read', async t => {
  const f = await fixture(t);
  await mkdir(f.data, { recursive: true });
  const pendingPath = join(f.data, 'pending-deletions.json');
  await writeFile(pendingPath, JSON.stringify({ ids: ['old-chat'] }));
  const listed = await f.call('/trash');
  assert.equal(listed.status, 200);
  assert.equal(listed.json().summary.count, 1);
  assert.equal(listed.json().sessions[0].sessionId, 'old-chat');
  assert.equal(listed.json().sessions[0].state, 'purge-pending');
  assert.equal(listed.json().sessions[0].snapshotId, null);
  await access(f.path);
  assert.deepEqual(JSON.parse(await readFile(pendingPath, 'utf8')).ids, ['old-chat']);
  const saved = await f.trash.get('old-chat');
  await f.call('/trash');
  assert.deepEqual(await f.trash.get('old-chat'), saved);
  const restore = await f.call('/trash/restore', { sessionIds: ['old-chat'] });
  assert.equal(restore.status, 409);
  await access(f.path);
  const deleted = await f.call('/trash/purge', { sessionIds: ['old-chat'] });
  assert.deepEqual(deleted.json().purged, ['old-chat']);
  await assert.rejects(access(f.path), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(pendingPath, 'utf8')).ids, []);
  assert.equal((await f.call('/trash')).json().summary.count, 0);
});


test('legacy snapshot ZIP preserves exact validated session and image bytes', async t => {
  const f = await fixture(t, { images: true });
  await f.legacy.move(['old-chat']);
  const old = await f.trash.get('old-chat');
  const directory = join(f.data, 'snapshots', old.snapshotId);
  // Earlier snapshots can contain whitespace; reserialization must not invalidate their manifest.
  const sessionPath = join(directory, 'session.json');
  const session = JSON.parse(await readFile(sessionPath, 'utf8'));
  const sessionBytes = Buffer.from(JSON.stringify(session, null, 2));
  const manifestPath = join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.totalBytes += sessionBytes.length - manifest.session.bytes;
  manifest.session.bytes = sessionBytes.length;
  manifest.session.sha256 = createHash('sha256').update(sessionBytes).digest('hex');
  await writeFile(sessionPath, sessionBytes);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const response = await f.call('/trash/export', {sessionIds: JSON.stringify(['old-chat'])}, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/zip');
  assert.equal(response.headers['cache-control'], 'no-store');
  const files = unzipSync(response.bytes);
  assert.deepEqual(Buffer.from(files['session.json']), sessionBytes);
  const exportedManifest = JSON.parse(Buffer.from(files['manifest.json']));
  assert.equal(exportedManifest.session.sha256, createHash('sha256').update(files['session.json']).digest('hex'));
  assert.deepEqual(files[manifest.attachments[0].file], f.imageData);
  assert.deepEqual(await f.trash.get('old-chat'), old);
  await access(f.path);
});

test('legacy snapshot export refuses missing, multiple and corrupted targets without mutation', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/trash/export', {sessionIds: JSON.stringify(['old-chat'])}, true)).status, 404);
  await f.legacy.move(['old-chat']);
  const old = await f.trash.get('old-chat');
  assert.equal((await f.call('/trash/export', {sessionIds: JSON.stringify(['old-chat','another'])}, true)).status, 400);
  await writeFile(join(f.data, 'snapshots', old.snapshotId, 'session.json'), 'corrupt');
  const response = await f.call('/trash/export', {sessionIds: JSON.stringify(['old-chat'])}, true);
  assert.notEqual(response.status, 200);
  assert.equal(response.bytes.toString(), 'snapshot-hash-mismatch');
  assert.deepEqual(await f.trash.get('old-chat'), old);
  await access(f.path);
});
