import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../backend/db.ts';
import {schemas} from '../backend/model.ts';
import {listRecords} from '../backend/listings.ts';
import {announcementReport} from '../backend/announcement-report.ts';
import {announcementScreenView} from '../backend/recruitment-reader.ts';
import {createReadCache} from '../src/read-cache';

let store:Store,worker:Store;
beforeEach(()=>{mkdirSync('.check/performance-v14-5/tests',{recursive:true});store=new Store(mkdtempSync(resolve('.check/performance-v14-5/tests/case-')));worker=new Store(store.dir);});
afterEach(()=>{worker.db.close();store.db.close();vi.useRealTimers();});
function seed(){
  const profile=store.save('profile',{title:'合成条件',education:[{level:'硕士',major:'土壤学',code:'090301'}]});
  const ann=store.put('ann','announcement',{title:'示例招聘',type:'企业招聘',body:'不限专业',fileIds:['file'],published:'2026-09-23',status:'pending',candidates:[]});
  const job=store.put('job','job',schemas.job.parse({title:'技术岗位',type:'企业招聘',url:'',organization:'示例企业',announcementId:ann.id,status:'未选择',majorRequirements:[{unrestricted:true,evidence:'不限专业'}]}));
  store.db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?)').run('file','ann','附件.txt','','text/plain',100,'hash','其他要求','');
  return {ann,job,profile};
}
const page=(query='status=专业符合')=>listRecords(store,'job',new URLSearchParams(query));
describe('current evidence under repeated reads',()=>{
  it('invalidates a profile changed by the separate worker connection',()=>{
    const {job,profile}=seed();
    store.put(job.id,'job',{...job,majorRequirements:[{levels:['硕士'],names:['土壤学'],evidence:'硕士土壤学'}]},job.version);
    worker.db.prepare("UPDATE files SET text='硕士土壤学' WHERE id='file'").run();
    expect(page().total).toBe(1);expect(page().total).toBe(1);
    worker.put(profile.id,'profile',{...profile,education:[{level:'硕士',major:'软件工程'}]},profile.version);
    expect(page().total).toBe(0);
  });
  it('invalidates attachment text changes even when id, sha, length and record versions stay the same',()=>{
    const {ann}=seed();store.put(ann.id,'announcement',{...ann,body:''},ann.version);
    worker.db.prepare("UPDATE files SET text='不限专业' WHERE id='file'").run();
    expect(page().total).toBe(1);
    worker.db.prepare("UPDATE files SET text='限制专业' WHERE id='file'").run();
    expect(page().total).toBe(0);expect(page('status=待核对').total).toBe(1);
  });
  it('observes own raw SQL updates and rollbacks without trusting the stored version alone',()=>{
    seed();expect(page().total).toBe(1);
    store.db.exec("UPDATE records SET data=json_set(data,'$.body','只招其他专业') WHERE id='ann'");
    expect(page().total).toBe(0);
    store.db.exec('BEGIN');store.db.exec("UPDATE records SET data=json_set(data,'$.body','不限专业') WHERE id='ann'");
    expect(page().total).toBe(1);store.db.exec('ROLLBACK');
    // ROLLBACK itself does not increment total_changes. End-of-transaction reuse
    // must not retain a read that was made inside an uncommitted transaction.
    expect(page().total).toBe(0);
  });
  it('updates status, deletion and new records between the list, report and compact snapshot',()=>{
    const {job,ann}=seed();expect(page().total).toBe(1);
    worker.put(job.id,'job',{...job,status:'关注'},job.version);
    expect(page('status=关注').total).toBe(1);expect(store.snapshot(true).jobCounts).toEqual({intended:1});
    expect(announcementReport(store,store.get(ann.id)).jobs[0].status).toBe('关注');
    worker.db.prepare("DELETE FROM records WHERE id='job'").run();
    expect(page().total).toBe(0);expect(announcementReport(store,store.get(ann.id)).jobs).toHaveLength(0);
  });
  it('preserves all displayed card facts and complete evidence in screen/detail results',()=>{
    const {ann}=seed();const full=page().items[0],card=page('status=专业符合&view=cards').items[0];
    for(const key of Object.keys(card))expect(card[key]).toEqual(full[key]);
    expect(card.majorSummary).toBe('不限专业');expect(card).not.toHaveProperty('eligibilityRequirements');
    const report=announcementReport(store,ann),screen=announcementScreenView(report);
    expect(screen.jobs[0].majorRequirements).toEqual(report.jobs[0].majorRequirements);
    expect(screen.jobs[0].specificEligibilityChecks).toEqual(report.jobs[0].specificEligibilityChecks);
    expect(screen.applicationProcess).toEqual(report.applicationProcess);expect(screen.body).toEqual(report.body);
    expect(store.get('job').status).toBe('未选择');
  });
  it('returns archived jobs in compact state without parsing every active job',()=>{
    const {job}=seed();store.put('archived','job',{...job,title:'归档岗位',archived:true});
    expect(store.snapshot(true).jobs.map(j=>j.id)).toEqual(['archived']);
    expect(store.snapshot(false).jobs).toHaveLength(2);
  });
});
describe('session-scoped navigation reads',()=>{
  it('coalesces concurrent reads and reuses fresh results until expiration',async()=>{
    vi.useFakeTimers();let resolve:(v:any)=>void=()=>{};
    const load=vi.fn(()=>new Promise(r=>{resolve=r;})),cache=createReadCache(load,1000);
    const a=cache.load('/jobs/a'),b=cache.load('/jobs/a');expect(load).toHaveBeenCalledTimes(1);
    resolve({version:1});expect(await a).toEqual(await b);
    expect(await cache.load('/jobs/a')).toEqual({version:1});expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1001);const later=cache.load('/jobs/a');resolve({version:2});expect(await later).toEqual({version:2});expect(load).toHaveBeenCalledTimes(2);
  });
  it('clears on writes/logout and discards an old response that ignores abort',async()=>{
    const resolvers:((value:any)=>void)[]=[];const signals:AbortSignal[]=[];
    const cache=createReadCache((_,signal)=>{signals.push(signal);return new Promise(r=>resolvers.push(r));});
    const old=cache.load('/jobs/a'),rejected=expect(old).rejects.toHaveProperty('name','AbortError');
    cache.clear(false);expect(signals[0].aborted).toBe(true);
    const next=cache.load('/jobs/a');resolvers[1]({version:2});await next;resolvers[0]({version:1});await rejected;
    expect(cache.peek('/jobs/a')).toEqual({version:2});cache.clear(false);expect(cache.peek('/jobs/a')).toBeUndefined();
  });
  it('does not share data between app sessions or poison retries after a failed request',async()=>{
    const load=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({version:1});
    const a=createReadCache(load),b=createReadCache(load);await expect(a.load('/ann')).rejects.toThrow('offline');
    expect(await a.load('/ann')).toEqual({version:1});expect(b.peek('/ann')).toBeUndefined();
  });
  it('keeps memory bounded and refreshes explicitly even before the TTL expires',async()=>{
    const load=vi.fn(async(path:string)=>path);const cache=createReadCache(load,15000,2);
    await cache.load('/a');await cache.load('/b');await cache.load('/c');expect(cache.peek('/a')).toBeUndefined();
    await cache.load('/c',true);expect(load).toHaveBeenCalledTimes(4);
  });
});
