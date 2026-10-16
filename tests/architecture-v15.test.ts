import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {Store} from '../backend/db.ts';
import {migrateSchema,readSchemaVersion} from '../backend/schema.ts';
import {workerHealth,runtimeHealth,startWorkerHeartbeat} from '../backend/runtime-health.ts';
import {matchJob,matchJobMajor} from '../backend/matching.ts';
import {evidenceContains,normalizedEvidence} from '../shared/evidence.ts';
const stores:Store[]=[];
function directory(){mkdirSync('.check/architecture-v15/tests',{recursive:true});return mkdtempSync(resolve('.check/architecture-v15/tests/case-'));}
function store(){const value=new Store(directory());stores.push(value);return value;}
afterEach(()=>{vi.useRealTimers();for(const value of stores.splice(0))value.db.close();});

describe('versioned data compatibility',()=>{
  it('preserves legacy records, settings, sessions and queues while registering the schema',()=>{
    const dir=directory(),original=new Store(dir);
    original.put('task','task',{title:'Synthetic preserved task',done:false});
    original.setSetting('synthetic-config',{example:'fixture'});
    original.enqueue('job','analyze',{id:'ann'});
    original.db.exec("INSERT INTO sessions VALUES('fixture',12345); PRAGMA user_version=0;");
    const before=['records','settings','jobs','sessions'].map(t=>original.db.prepare(`SELECT * FROM ${t}`).all());original.db.close();
    const upgraded=new Store(dir);stores.push(upgraded);
    expect(readSchemaVersion(upgraded.db)).toBe(1);
    expect(['records','settings','jobs','sessions'].map(t=>upgraded.db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before);
    expect(upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='files_announcement'").get()).toBeTruthy();
  });
  it('rolls back the whole migration if any step fails',()=>{
    const db=new DatabaseSync(':memory:');
    expect(()=>migrateSchema(db,[{version:1,name:'first',apply(d){d.exec('CREATE TABLE example(id); INSERT INTO example VALUES(1)');}},{version:2,name:'failure',apply(){throw new Error('injected');}}],2)).toThrow('injected');
    expect(readSchemaVersion(db)).toBe(0);expect(db.prepare("SELECT name FROM sqlite_master WHERE name='example'").get()).toBeUndefined();db.close();
  });
  it('rejects a future schema before changing the database file',()=>{
    const dir=directory(),file=join(dir,'jindu.sqlite'),db=new DatabaseSync(file);db.exec('PRAGMA user_version=99');db.close();
    const before=readFileSync(file);expect(()=>new Store(dir)).toThrow('newer version');expect(readFileSync(file)).toEqual(before);
  });
  it('refuses missing migration steps and incompatible old layouts',()=>{
    const db=new DatabaseSync(':memory:');expect(()=>migrateSchema(db,[],1)).toThrow('Missing');db.close();
    const dir=directory(),old=new DatabaseSync(join(dir,'jindu.sqlite'));old.exec('CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT,data TEXT,updated_at TEXT)');old.close();
    expect(()=>new Store(dir)).toThrow('legacy table');
    const check=new DatabaseSync(join(dir,'jindu.sqlite'));expect(readSchemaVersion(check)).toBe(0);check.close();
  });
  it('does not replay migrations when a second connection opens',()=>{
    const first=store();first.put('fixture','task',{title:'Keep'});
    const second=new Store(first.dir);stores.push(second);expect(second.get('fixture').title).toBe('Keep');expect(readSchemaVersion(second.db)).toBe(1);
  });
  it('rejects extra or reordered legacy columns instead of silently changing stored values',()=>{
    for(const layout of ['value TEXT,key TEXT PRIMARY KEY','key TEXT PRIMARY KEY,value TEXT,extra TEXT']){
      const dir=directory(),db=new DatabaseSync(join(dir,'jindu.sqlite'));db.exec(`CREATE TABLE settings(${layout})`);db.close();
      expect(()=>new Store(dir)).toThrow('Incompatible legacy table: settings');
      const check=new DatabaseSync(join(dir,'jindu.sqlite'));expect(readSchemaVersion(check)).toBe(0);check.close();
    }
  });
});

describe('worker and recovery visibility',()=>{
  it('distinguishes absent, stopped, stale and future-invalid heartbeats',()=>{
    const instant=Date.parse('2026-10-16T00:00:00Z');
    expect(workerHealth({},instant).healthy).toBe(false);
    expect(workerHealth({running:false,lastHeartbeat:new Date(instant).toISOString()},instant).state).toBe('stopped');
    expect(workerHealth({running:true,lastHeartbeat:new Date(instant-91000).toISOString()},instant).state).toBe('stale');
    expect(workerHealth({running:true,lastHeartbeat:new Date(instant+60000).toISOString()},instant).healthy).toBe(false);
    expect(workerHealth({running:true,lastHeartbeat:new Date(instant-1000).toISOString()},instant).healthy).toBe(true);
  });
  it('keeps a live heartbeat during an awaited long-running operation and stops on shutdown',async()=>{
    vi.useFakeTimers();const s=store(),stop=startWorkerHeartbeat(s);
    await vi.advanceTimersByTimeAsync(180000);
    expect(workerHealth(s.getSetting('worker-status',{})).healthy).toBe(true);
    stop();await vi.advanceTimersByTimeAsync(30000);expect(workerHealth(s.getSetting('worker-status',{})).state).toBe('stopped');
  });
  it('reports old/failed backups and distinguishes queued work from quota/configuration waits',()=>{
    const s=store(),instant=Date.parse('2026-10-16T00:00:00Z');
    expect(runtimeHealth(s,instant).backup.state).toBe('missing');
    s.setSetting('backup-status',{lastSuccess:'2026-10-13T00:00:00Z'});expect(runtimeHealth(s,instant).backup.state).toBe('overdue');
    s.setSetting('backup-status',{lastSuccess:'2026-10-16T00:00:00Z',error:'fixture failure'});expect(runtimeHealth(s,instant).backup.state).toBe('failed');
    for(const state of ['pending','running','error','waiting_quota','waiting_config','retry']){
      s.enqueue(state,'analyze',{});s.db.prepare('UPDATE jobs SET state=?,available_at=?,updated_at=? WHERE id=?').run(state,state==='retry'?instant+3600000:0,'2026-10-15T00:00:00Z',state);
    }
    expect(runtimeHealth(s,instant).queue).toEqual({failed:1,waiting:1,longRunning:1});
  });
});

describe('major filter and long-source correctness',()=>{
  it('uses the same verdict as full evaluation for degree policies, incomplete evidence and profile changes',()=>{
    const source='硕士专业土壤学；本科专业土地资源管理；必须以最高学历报考；限中共党员';
    const profiles=[{id:'p',education:[{level:'硕士',major:'土壤学',code:'090301'},{level:'本科',major:'土地资源管理',code:'120404'}]}];
    for(const level of ['本科','硕士'])for(const highest of [false,true])for(const incomplete of [false,true])for(const archived of [false,true]){
      const job={majorRequirements:[{levels:[level],names:[level==='本科'?'土地资源管理':'土壤学'],evidence:level==='本科'?'本科专业土地资源管理':'硕士专业土壤学'}],...(highest?{degreePolicy:{policy:'highest',evidence:'必须以最高学历报考'}}:{}),...(incomplete?{analysisQuality:{issues:['学历范围尚未完成核查']}}:{})};
      const active=profiles.map(p=>({...p,archived}));const full=matchJob(job,active,source),major=matchJobMajor(job,active,source);
      expect(major.status).toBe(full.majorStatus);expect(major.reason).toBe(full.majorReason);
    }
  });
  it('does not reuse cached evidence for changed or interleaved long documents',()=>{
    const first='公 开 原 文 \n'.repeat(160000)+'土壤学专业',second='其 他 原 文 \n'.repeat(160000)+'土地管理专业';
    for(let n=0;n<4;n++){
      expect(evidenceContains(first,'土壤学专业')).toBe(true);expect(evidenceContains(second,'土壤学专业')).toBe(false);
      expect(normalizedEvidence(first)).toBe(first.replace(/\s/g,''));
    }
    expect(evidenceContains(first.replace('土壤学专业','其他专业'),'土壤学专业')).toBe(false);
  });
});
