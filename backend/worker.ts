import { loadConfig,type Config } from './config.ts';
import {startWorkerHeartbeat,updateMaintenance} from './runtime-health.ts';
import { Store } from './db.ts';
import { crawlPage,detail,startCrawl } from './crawler.ts';
import { analyze,AIOutputError } from './ai.ts';
import { makeBackup } from './backup.ts';
import { now,todayCN,AppError } from './model.ts';
import { safeError } from './net.ts';
import { runTurn, followExam } from './agent.ts';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { sourceSettings,sourceStatus } from './sources.ts';
import {AIServiceError,AIServicePaused,aiCooldown,postponeAI,markAIWait,transientAttemptLimit} from './ai-failure.ts';

// The worker runs even with an empty queue; reuse the timezone formatter.
const clockCNFormatter=new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'Asia/Shanghai'});

export function initializeWorker(store:Store) {
  store.prepare("UPDATE jobs SET state='retry',available_at=0,error='后台重启，已恢复待处理' WHERE state='running'").run();
  // Startup resumes interrupted work only. Upgrades and migration must never
  // enqueue a historical, completed collection just to apply a new AI prompt.
}
function finishJob(store:Store,job:any,state:string,error='',available=0,attempts=0) {
  store.transaction(()=>{
    // Retry budgets count consecutive failures. A saved successful segment starts a new budget.
    store.prepare('UPDATE jobs SET state=?,attempts=CASE WHEN ? THEN 0 ELSE attempts+? END,error=?,available_at=?,updated_at=? WHERE id=?').run(state,state==='pending'&&!error?1:0,attempts,error,available,now(),job.id);
    if(state==='done'||state==='pending'&&!error)store.prepare('DELETE FROM settings WHERE key=?').run('job-error:'+job.id);
    if(state!=='retry')store.prepare('DELETE FROM settings WHERE key=?').run('ai-wait:'+job.id);
    if(job.type!=='analyze')return;
    const id=JSON.parse(job.payload).id,key='analysis-requeue:'+id,requested=store.getSetting<any>(key,false);
    if(!requested)return;
    store.prepare('DELETE FROM settings WHERE key=?').run(key);
    store.enqueueAnalysis(id,requested===true||!!requested.reset);
  });
}
export async function runWorkerTick(store:Store,config:Config) {
  if(store.getSetting('maintenance',false)||updateMaintenance(config.dataDir))return;
  const instant=new Date(),day=todayCN(instant),clock=clockCNFormatter.format(instant),hour=Number(clock.slice(0,2));
  store.setSetting('worker-status',{...store.getSetting('worker-status',{}),lastHeartbeat:now(),running:true});
  store.repeat(day);
  const sources=sourceSettings(store);
  if(sources.autoEnabled&&sources.sites.some(s=>s.enabled)&&clock>=sources.dailyTime&&store.getSetting('last-auto-crawl','')!==day){startCrawl(store);store.setSetting('last-auto-crawl',day);}
  if(hour>=9&&store.getSetting('last-auto-follow','')!==day){for(const e of store.list('exam').filter(e=>!e.archived&&e.calendarKind!=='personal'&&e.tracking?.enabled)){
    const active=store.prepare("SELECT 1 FROM jobs WHERE type='follow' AND json_extract(payload,'$.id')=? AND state IN ('pending','running','retry','waiting_config','waiting_quota')").get(e.id);
    if(!active)store.enqueue(`follow:${e.id}:${day}`,'follow',{id:e.id});
  }store.setSetting('last-auto-follow',day);}
  if(store.getSetting('last-auto-backup','')!==day) {store.enqueue('backup:auto:'+day,'backup',{});store.setSetting('last-auto-backup',day);}
  store.prepare("UPDATE jobs SET state='pending' WHERE state='waiting_quota' AND available_at<=?").run(Date.now());
  const cooling=(aiCooldown(store)?.until||0)>Date.now();
  const job=store.transaction(()=>{const j=store.prepare("SELECT * FROM jobs WHERE state IN ('pending','retry') AND available_at<=? AND (?=0 OR type NOT IN ('analyze','follow')) ORDER BY CASE type WHEN 'agent' THEN 0 WHEN 'backup' THEN 1 WHEN 'crawl' THEN 2 WHEN 'detail' THEN 3 WHEN 'follow' THEN 4 ELSE 5 END,updated_at LIMIT 1").get(Date.now(),cooling?1:0) as any;if(j)store.prepare("UPDATE jobs SET state='running',updated_at=? WHERE id=?").run(now(),j.id);return j;});
  if(job) {
    try {
      const p=JSON.parse(job.payload);
      if(job.type==='crawl')await crawlPage(store,p);else if(job.type==='detail')await detail(store,config,p);else if(job.type==='analyze'){if(await analyze(store,config,p.id,1)===false){finishJob(store,job,'pending');return;}}else if(job.type==='backup')await makeBackup(store,config);else if(job.type==='agent'){if(await runTurn(store,config,p.id)===false){finishJob(store,job,'pending');return;}}else if(job.type==='follow')await followExam(store,config,p.id);
      finishJob(store,job,'done');
    }catch(e) {
      let message=safeError(e),state=job.attempts>=2?'error':'retry',available=Date.now()+60000*(job.attempts+1);
      if(e instanceof AIServicePaused){markAIWait(store,job.id,e.until);finishJob(store,job,'retry',message,e.until,0);return;}
      if(e instanceof AIServiceError) {
        state=e.retryable&&job.attempts+1<transientAttemptLimit?'retry':'error';
        if(e.retryable){available=postponeAI(store,e);if(state==='retry')markAIWait(store,job.id,available);}
        if(state==='error'&&e.retryable)message+='；已连续尝试 6 次，进度已保存，可稍后手动继续';
        store.setSetting('job-error:'+job.id,{code:e.code,httpStatus:e.httpStatus,transportCode:e.transportCode,retryable:e.retryable,attempts:job.attempts+1,at:now()});
      } else store.setSetting('job-error:'+job.id,{code:e instanceof AIOutputError?'model_output':e instanceof AppError?'application':'unknown',at:now(),attempts:job.attempts+1});
      if(job.type==='analyze'&&e instanceof AIOutputError)state='error'; // analyze() already spent its bounded repair budget; chat has not.
      if(e instanceof AppError&&e.status===428)state='waiting_config';
      if(e instanceof AppError&&e.status===429){state='waiting_quota';available=Date.parse(day+'T00:00:00+08:00')+86400000;}
      if(job.type==='backup')store.setSetting('backup-status',{...store.getSetting<any>('backup-status',{}),error:message});
      if(job.type==='analyze'){const a=store.get(JSON.parse(job.payload).id);if(a)store.put(a.id,'announcement',{...a,analysisStatus:state,analysisError:message},a.version);}
      if(job.type==='follow'){const a=store.get(JSON.parse(job.payload).id);if(a?.tracking)store.put(a.id,'exam',{...a,tracking:{...a.tracking,error:message}},a.version);}
      if(['crawl','detail'].includes(job.type)){store.setSetting('source-status',{...store.getSetting<any>('source-status',{}),error:message});const sourceId=JSON.parse(job.payload).sourceId;if(sourceId)sourceStatus(store,sourceId,{error:message});}
      finishJob(store,job,state,message,available,['waiting_config','waiting_quota'].includes(state)?0:1);
    }
  }
  const source=store.getSetting<any>('source-status',{});
  const unfinished=store.prepare("SELECT state,payload,error FROM jobs WHERE type IN ('crawl','detail') AND json_extract(payload,'$.run')=? AND state!='done'").all(source.run||'') as any[];
  if(source.running&&!unfinished.length)store.setSetting('source-status',{...source,running:false,lastSuccess:now(),error:''});
  if(unfinished.length)store.setSetting('source-status',{...source,running:unfinished.some(j=>['pending','retry','running'].includes(j.state))});
  if(source.run)for(const site of sources.sites){
    const status=store.getSetting<Record<string,any>>('source-sites-status',{})[site.id];
    if(!status?.running)continue;
    const jobs=unfinished.filter(j=>JSON.parse(j.payload).sourceId===site.id);
    if(!jobs.length)sourceStatus(store,site.id,{running:false,lastSuccess:now(),error:''});
    else if(!jobs.some(j=>['pending','retry','running'].includes(j.state)))sourceStatus(store,site.id,{running:false});
  }
  store.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());store.prepare('DELETE FROM rate_limits WHERE expires_at<?').run(Date.now());
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const config=loadConfig(),store=new Store(config.dataDir);let stopped=false;
  process.on('SIGTERM',()=>{stopped=true;});process.on('SIGINT',()=>{stopped=true;});
  initializeWorker(store);
  const stopHeartbeat=startWorkerHeartbeat(store);
  try {
    while(!stopped) {
      try{await runWorkerTick(store,config);}
      catch(e){store.setSetting('worker-status',{...store.getSetting('worker-status',{}),lastErrorAt:now()});console.error(JSON.stringify({event:'worker_error',type:e instanceof Error?e.name:'Unknown'}));}
      if(!stopped)await new Promise(r=>setTimeout(r,3000));
    }
  }finally{stopHeartbeat();store.db.close();}
}
