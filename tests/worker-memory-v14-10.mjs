// Synthetic DB only. Compare real worker ticks without production config, network or AI.
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]||'.'),iterations=Number(process.argv[3]||20000),delay=Number(process.argv[4]||0),label=process.argv[5]||'candidate';
const out=resolve('.check/memory-v14-10');mkdirSync(out,{recursive:true});
const dataDir=mkdtempSync(join(out,label+'-'));
const {Store}=await import(pathToFileURL(join(root,'backend/db.ts')).href);
const {runWorkerTick}=await import(pathToFileURL(join(root,'backend/worker.ts')).href);
const {todayCN}=await import(pathToFileURL(join(root,'shared/model.ts')).href);
const store=new Store(dataDir);
const config={dataDir,origin:'http://127.0.0.1:8788',host:'127.0.0.1',port:8788,adminUsername:'synthetic',passwordHash:'unused',masterKey:randomBytes(32).toString('hex'),python:process.env.JINDU_TEST_PYTHON||'python',distDir:join(root,'dist')};
const samples=[],started=performance.now();let stoppedAt=iterations;
const sample=(iteration)=>{const s={iteration,seconds:Number(((performance.now()-started)/1000).toFixed(2)),...process.memoryUsage()};samples.push(s);return s;};
try{
  store.setSetting('sources',{autoEnabled:false,sites:[]});
  store.setSetting('last-auto-backup',todayCN());store.setSetting('last-auto-follow',todayCN());
  // Representative completed queue; no work can become runnable.
  store.transaction(()=>{for(let i=0;i<2100;i++)store.db.prepare("INSERT INTO jobs(id,type,payload,state,updated_at) VALUES(?,'analyze','{}','done',?)").run('done:'+i,new Date().toISOString());});
  sample(0);
  for(let i=1;i<=iterations;i++){
    await runWorkerTick(store,config);
    if(i%100===0||delay>0&&i%20===0){const s=sample(i);if(delay>0)console.log(JSON.stringify({label,...s}));if(s.rss>450*1048576){stoppedAt=i;break;}}
    if(delay>0)await new Promise(r=>setTimeout(r,delay));else if(i%20===0)await new Promise(r=>setImmediate(r));
  }
  sample(stoppedAt);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE state!='done'").get().n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ai_requests').get().n,0);
  const beforeGC=process.memoryUsage();
  if(global.gc){global.gc();await new Promise(r=>setTimeout(r,100));global.gc();}
  const result={label,node:process.version,icu:process.versions.icu,iterations:stoppedAt,requestedIterations:iterations,delayMs:delay,seconds:performance.now()-started,samples,beforeGC,afterGC:process.memoryUsage(),externalAICalls:0,productionDataUsed:false};
  result.seconds=Number((result.seconds/1000).toFixed(2));
  writeFileSync(join(out,label+'.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({label,node:result.node,iterations:stoppedAt,seconds:result.seconds,initialMiB:samples[0].rss/1048576,peakMiB:Math.max(...samples.map(s=>s.rss))/1048576,finalMiB:beforeGC.rss/1048576,afterGCMiB:result.afterGC.rss/1048576}));
}finally{store.db.close();}
