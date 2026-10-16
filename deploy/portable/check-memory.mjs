// Isolated runtime gate: synthetic SQLite only, no config, network, AI, or worker loop.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../backend/db.ts';
import {runWorkerTick} from '../../backend/worker.ts';
import {todayCN} from '../../shared/model.ts';
import {formatDateTime} from '../../shared/datetime.ts';
import {usageSummary} from '../../backend/usage.ts';
import {recruitmentReader} from '../../backend/recruitment-reader.ts';

const dataDir=mkdtempSync(join(tmpdir(),'jindu-memory-')),store=new Store(dataDir);
const config={dataDir,origin:'http://127.0.0.1:8788'};
const Original=Intl.DateTimeFormat;let formatterConstructions=0;
try{
  store.setSetting('sources',{autoEnabled:false,sites:[]});
  store.setSetting('last-auto-follow',todayCN());store.setSetting('last-auto-backup',todayCN());
  Intl.DateTimeFormat=new Proxy(Original,{construct(target,args,newTarget){formatterConstructions++;return Reflect.construct(target,args,newTarget);}});
  const initial=process.memoryUsage();
  for(let i=0;i<2000;i++){
    await runWorkerTick(store,config);
    if(i%100===0){usageSummary(store);formatDateTime(new Date().toISOString());await new Promise(r=>setImmediate(r));}
  }
  assert.equal(formatterConstructions,0);
  assert.equal(todayCN(new Date('2026-12-31T16:00:00Z')),'2027-01-01');
  assert.equal(formatDateTime('2026-12-31T16:00:00Z'),'2027-01-01 00:00:00');
  store.put('memory-ann','announcement',{title:'合成公告',body:'不限专业',fileIds:[]});
  let reader=recruitmentReader(store),first=reader.get('memory-ann'),source=reader.source('memory-ann');
  store.setSetting('worker-status',{lastHeartbeat:new Date().toISOString(),running:true});
  reader=recruitmentReader(store);assert.equal(reader.get('memory-ann'),first);assert.equal(reader.source('memory-ann'),source);
  store.db.prepare("UPDATE records SET data=json_set(data,'$.body','已撤回') WHERE id='memory-ann'").run();
  reader=recruitmentReader(store);assert.notEqual(reader.get('memory-ann'),first);assert.equal(reader.source('memory-ann').text,'已撤回');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ai_requests').get().n,0);
  console.log(JSON.stringify({passed:true,node:process.version,idleTicks:2000,formatterConstructions,initialMemory:initial,finalMemory:process.memoryUsage(),midnightCorrect:true,cacheInvalidation:true,externalAICalls:0,productionDataUsed:false}));
}finally{Intl.DateTimeFormat=Original;store.db.close();}
