import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, statfsSync, unlinkSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileTool } from './files.ts';
import { schemas, AppError, now, todayCN } from './model.ts';
import { dateSchema,stageSchema } from '../shared/model.ts';
import type { Store } from './db.ts';
import type { Config } from './config.ts';

// Endpoint and key are kept together in the current installation, never restored from an archive.
const publicSettings:string[]=[];
export function backupList(config:Config) { const dir=join(config.dataDir,'backups');mkdirSync(dir,{recursive:true});return readdirSync(dir).filter(n=>/^jindu-\d{8}-\d{6}-[a-f0-9]{8}\.zip$/.test(n)).sort().reverse().map(name=>({name,size:statSync(join(dir,name)).size})); }
export async function makeBackup(store:Store,config:Config) {
  const dir=join(config.dataDir,'backups');mkdirSync(dir,{recursive:true});
  const files=store.db.prepare('SELECT * FROM files').all() as any[];
  const size=files.reduce((n,f)=>n+f.size,0);const disk=statfsSync(config.dataDir);
  if(Number(disk.bavail)*Number(disk.bsize)<size+100000000)throw new AppError(507,'没有足够空间生成新备份；已保留已有备份');
  const stamp=now().replace(/[-:]/g,'').replace('T','-').slice(0,15);const name=`jindu-${stamp}-${randomUUID().slice(0,8)}.zip`;
  const manifest=store.transaction(()=>({format:'jindu-server-backup',version:1,createdAt:now(),records:store.db.prepare('SELECT * FROM records').all(),repeats:store.db.prepare('SELECT * FROM repeats').all(),history:store.db.prepare('SELECT * FROM history').all(),files,settings:publicSettings.map(key=>({key,value:store.getSetting(key,null)}))}));
  const meta=join(dir,'manifest-'+randomUUID()+'.json');writeFileSync(meta,JSON.stringify(manifest),{mode:0o600});
  try {
    await fileTool(config,['backup',config.dataDir,meta,join(dir,name)],300000);
    // Only this application's named backup archives are subject to the agreed three-copy retention.
    for(const old of backupList(config).slice(3))unlinkSync(join(dir,old.name));
    store.setSetting('backup-status',{lastSuccess:now(),lastDay:todayCN(),error:''});return {name};
  }finally{unlinkSync(meta);}
}
export async function restoreBackup(store:Store,config:Config,archive:string) {
  const active=store.db.prepare("SELECT id FROM jobs WHERE state='running' LIMIT 1").get();
  if(active)throw new AppError(409,'后台正在处理公告，请等本轮结束后恢复');
  const stage=join(config.dataDir,'restore',randomUUID());
  try {
  await fileTool(config,['restore',archive,stage,'4000000000'],300000);
  const m=JSON.parse(readFileSync(join(stage,'manifest.json'),'utf8'));
  if(!Array.isArray(m.records)||!Array.isArray(m.repeats)||!Array.isArray(m.history)||!Array.isArray(m.files)||!Array.isArray(m.settings)||m.records.length>200000)throw new AppError(400,'备份结构不正确');
  const seen=new Set<string>();
  for(const r of m.records) {
    if(typeof r.id!=='string'||seen.has(r.id)||!Number.isInteger(r.version)||r.version<1)throw new AppError(400,'备份记录无效');seen.add(r.id);
    const data=JSON.parse(r.data);if(r.kind==='announcement'){
      if(typeof data.title!=='string'||typeof data.body!=='string'||data.url&&!/^https?:\/\//.test(data.url)||!Array.isArray(data.candidates))throw new AppError(400,'公告备份无效');
      data.candidates.forEach((s:unknown)=>stageSchema.parse(s));
    }
    else if(Object.hasOwn(schemas,r.kind))(schemas as any)[r.kind].parse(data);else throw new AppError(400,'备份记录类别不支持');
  }
  for(const r of m.repeats) {schemas.task.parse(JSON.parse(r.template));dateSchema.parse(r.next_date);if(r.until_date)dateSchema.parse(r.until_date);if(!['daily','weekly','none'].includes(r.period)||![0,1].includes(r.active))throw new AppError(400,'重复计划备份无效');}
  for(const f of m.files)if(!/^[a-f0-9]{64}$/.test(f.id)||!seen.has(f.announcement_id))throw new AppError(400,'备份附件关联无效');
  await makeBackup(store,config);
  mkdirSync(join(config.dataDir,'files'),{recursive:true});
  for(const f of m.files) {const dst=join(config.dataDir,'files',f.id);if(!existsSync(dst))copyFileSync(join(stage,'files',f.id),dst);}
  store.transaction(()=>{
    store.db.exec('DELETE FROM records; DELETE FROM repeats; DELETE FROM files; DELETE FROM history; DELETE FROM jobs; DELETE FROM sessions;');
    for(const r of m.records)store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run(r.id,r.kind,r.data,r.version+1,now());
    // Jobs are intentionally not restored. Finish interrupted chat turns rather than
    // leaving the composer blocked by a request that no worker can ever pick up.
    for(const t of store.list('agent_turn').filter(t=>!t.done))store.put(t.id,'agent_turn',{...t,done:true,progress:'',reply:'已恢复这段对话。恢复前尚未完成的请求没有继续执行，请重新发送。'},t.version);
    for(const r of m.repeats)store.db.prepare('INSERT INTO repeats VALUES(?,?,?,?,?,?)').run(r.id,r.template,r.period,r.next_date,r.until_date,r.active);
    for(const f of m.files)store.db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?)').run(f.id,f.announcement_id,f.name,f.url,f.mime,f.size,f.sha256,f.text,f.error);
    for(const h of m.history)store.db.prepare('INSERT INTO history(record_id,content_hash,data,created_at) VALUES(?,?,?,?)').run(h.record_id,h.content_hash,h.data,h.created_at);
    for(const s of m.settings)if(publicSettings.includes(s.key))store.setSetting(s.key,s.value);
    store.db.prepare("DELETE FROM settings WHERE key LIKE 'analysis:%' OR key LIKE 'analysis-requeue:%' OR key LIKE 'agent-plan:%' OR key LIKE 'recruitment-target:%' OR key LIKE 'workbook-v2:%' OR key IN ('analysis-progress','source-status','last-auto-follow')").run();
    store.setSetting('restore-status',{lastSuccess:now()});
    store.recoverAnalyses();
  });
  return {ok:true,relogin:true};
  }finally{rmSync(stage,{recursive:true,force:true});}
}
