import { readFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { aiSettingsSchema, AppError, todayCN, now } from './model.ts';
import type { Store } from './db.ts';

export interface Config { dataDir:string; origin:string; host:string;port:number;adminUsername:string;passwordHash:string;masterKey:string;python:string;distDir:string;tlsCert?:string;tlsKey?:string; }
export function loadConfig():Config {
  const path=process.env.JINDU_CONFIG;if(!path)throw new Error('JINDU_CONFIG is required');
  const v=JSON.parse(readFileSync(path,'utf8'));
  if(!v.origin||!v.adminUsername||!v.passwordHash||!/^[a-f0-9]{64}$/.test(v.masterKey))throw new Error('Incomplete server configuration');
  return {host:'127.0.0.1',port:8788,python:process.env.JINDU_PYTHON||(process.platform==='win32'?'python':'python3'),distDir:resolve('dist'),...v,dataDir:resolve(v.dataDir)};
}
export const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
export function equal(a:string,b:string) {return timingSafeEqual(Buffer.from(hash(a),'hex'),Buffer.from(hash(b),'hex'));}
export function seal(value:string,key:string) {const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);const body=Buffer.concat([c.update(value,'utf8'),c.final()]);return [iv.toString('hex'),c.getAuthTag().toString('hex'),body.toString('hex')].join('.');}
export function unseal(value:string,key:string) {const [iv,tag,body]=value.split('.');const c=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),Buffer.from(iv,'hex'));c.setAuthTag(Buffer.from(tag,'hex'));return Buffer.concat([c.update(Buffer.from(body,'hex')),c.final()]).toString('utf8');}
export function aiSettings(store:Store) { const saved=store.getSetting<any>('ai',{});return {baseUrl:'',model:'',unlimited:false,dailyLimit:60,attachmentLimitMB:1000,vision:false,...saved,keyConfigured:!!store.getSetting('ai-secret','')}; }
export function saveAI(store:Store,input:unknown,config:Config) {
  const v=aiSettingsSchema.parse(input);
  if(v.baseUrl) { const u=new URL(v.baseUrl);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new AppError(400,'API 地址须为 HTTPS，不能包含账号密码、查询参数或片段'); }
  store.transaction(()=>{
    const {key,clearKey,...publicSettings}=v;
    store.setSetting('ai',publicSettings);
    if(clearKey)store.setSetting('ai-secret','');else if(key)store.setSetting('ai-secret',seal(key,config.masterKey));
  });
  const ready=!!(v.baseUrl&&v.model&&store.getSetting('ai-secret',''));
  const used=(store.db.prepare('SELECT calls FROM usage WHERE day=?').get(todayCN()) as any)?.calls||0;
  if(ready) {
    const waiting=store.db.prepare("SELECT id,type,payload,state FROM jobs WHERE type IN ('analyze','agent','follow') AND (state='waiting_config' OR (state='waiting_quota' AND ?)) ORDER BY updated_at DESC").all(v.unlimited||used<v.dailyLimit?1:0) as any[];
    const follows=new Set<string>((store.db.prepare("SELECT payload FROM jobs WHERE type='follow' AND state IN ('pending','running','retry')").all() as any[]).map(j=>JSON.parse(j.payload).id));
    for(const j of waiting) {
      const target=JSON.parse(j.payload).id;
      if(j.type==='follow'&&follows.has(target)){store.db.prepare("UPDATE jobs SET state='done',error='已合并到最新跟进任务' WHERE id=?").run(j.id);continue;}
      if(j.type==='follow')follows.add(target);
      store.db.prepare("UPDATE jobs SET state='pending',available_at=0,error='',updated_at=? WHERE id=?").run(now(),j.id);
      if(j.type==='analyze'){const ann=store.get(target);if(ann&&['waiting_quota','waiting_config'].includes(ann.analysisStatus))store.put(ann.id,'announcement',{...ann,analysisStatus:'pending',analysisError:''},ann.version);}
    }
  }
  return aiSettings(store);
}
