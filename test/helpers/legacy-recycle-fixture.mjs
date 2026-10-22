// Test-only fixture builder for data produced by earlier releases. Never shipped.
// New public /delete requests are tested separately and must return 410 without permanent:true.
import { join } from 'node:path';
import { createRecycleService } from '../../lib/recycle.js';
import { createSnapshotStore } from '../../lib/snapshot.js';
import { createTrashStore } from '../../lib/trash.js';
import { createMetadataStore } from '../../lib/metadata.js';
import { resolvePersistenceCompat } from '../../lib/persistence-compat.js';
export function withLegacyFixtures(apply) {
 return ctx => {
  let seeded=false;
  const bind=()=>{
   const server=ctx.get('webServer');const registry=ctx.get('workspaceRegistry');const raw=ctx.get('sessionPersistence');
   if(seeded||!server||!registry||!raw)return;seeded=true;
   const persistence=resolvePersistenceCompat(raw);const root=join(process.env.DSH_HOME,'plugin-data','archived-chats');
   const service=createRecycleService({registry,persistence,attachments:ctx.get('attachments'),
    snapshotStore:createSnapshotStore({root:join(root,'snapshots'),persistence,attachments:ctx.get('attachments')}),
    trashStore:createTrashStore({path:join(root,'trash.json')}),metadataStore:createMetadataStore({filePath:join(root,'metadata.json')}),
    lifecycle:{run:fn=>fn()},disposeLive:async()=>({disposition:'cold'})});
   server.register({path:'/plugins/dsh-archived-chats/__test_seed_legacy_trash',handler:async(req,res)=>{
    const body=await new Promise((resolve,reject)=>{const parts=[];req.on('data',c=>parts.push(c));req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString()))}catch(e){reject(e)}});req.on('error',reject)});
    const result=await service.move(body.sessionIds??[body.sessionId]);res.writeHead(result.failed.length?409:200);res.end(JSON.stringify({ok:!result.failed.length,...result}));
   }});
  };
  apply({...ctx,on(event,callback){ctx.on(event,(...args)=>{callback(...args);bind()})}});bind();
 };
}
