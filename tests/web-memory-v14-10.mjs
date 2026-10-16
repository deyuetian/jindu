// Local synthetic 450-announcement/1500-job read-cache comparison. No external calls.
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]||'.'),label=process.argv[3]||'web-candidate',out=resolve('.check/memory-v14-10');
mkdirSync(out,{recursive:true});const dataDir=mkdtempSync(join(out,label+'-'));
const {Store}=await import(pathToFileURL(join(root,'backend/db.ts')).href);
const {listRecords}=await import(pathToFileURL(join(root,'backend/listings.ts')).href);
const {schemas}=await import(pathToFileURL(join(root,'backend/model.ts')).href);
const store=new Store(dataDir),samples=[];
const sample=label=>samples.push({label,...process.memoryUsage()});
const collect=async()=>{global.gc();await new Promise(r=>setTimeout(r,100));global.gc();};
try{
  store.transaction(()=>{
    for(let i=0;i<450;i++){
      store.put('ann:'+i,'announcement',{title:'公告 '+i,type:'企业招聘',body:'不限专业。合成公告正文。'.repeat(240),province:'北京市',published:'2026-09-26',status:'pending',candidates:[],fileIds:['file:'+i]});
      store.db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?)').run('file:'+i,'ann:'+i,'岗位表.txt','','text/plain',0,'test','不限专业。合成附件内容。'.repeat(200),'');
    }
    const job=schemas.job.parse({title:'合成岗位',type:'企业招聘',province:'北京市',url:'',majorRequirements:[{unrestricted:true,evidence:'不限专业'}],notes:'合成岗位条件和材料。'.repeat(240)});
    for(let i=0;i<1500;i++)store.put('job:'+i,'job',{...job,title:'合成岗位 '+i,announcementId:'ann:'+(i%450)});
  });
  await collect();sample('seeded');const times=[];
  for(let i=0;i<16;i++){
    // A real worker heartbeat must preserve memoized results but still refresh the read stamp.
    store.setSetting('worker-status',{lastHeartbeat:new Date().toISOString(),running:true});
    const start=performance.now();const page=listRecords(store,'job',new URLSearchParams('view=cards&pageSize=20&page='+(1+i)));
    assert.equal(page.total,1500);assert.equal(page.items.length,20);times.push(performance.now()-start);sample('page-'+i);
  }
  await collect();sample('retained');
  // Direct data changes with the same version and updated_at must still invalidate the cache.
  store.db.prepare("UPDATE records SET data=json_set(data,'$.title','变更后岗位') WHERE id='job:0'").run();
  assert.equal(listRecords(store,'job',new URLSearchParams('q=变更后岗位')).total,1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ai_requests').get().n,0);
  const result={label,node:process.version,announcements:450,jobs:1500,samples,requestMilliseconds:times,productionDataUsed:false,externalAICalls:0};
  writeFileSync(join(out,label+'.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({label,seededMiB:samples[0].rss/1048576,retainedMiB:samples.at(-1).rss/1048576,heapUsedMiB:samples.at(-1).heapUsed/1048576,peakMiB:Math.max(...samples.map(s=>s.rss))/1048576,firstMs:times[0],repeatMedianMs:[...times.slice(1)].sort((a,b)=>a-b)[7]}));
}finally{store.db.close();}
