import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {readFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {normalizeCalendarStages,stageMilestone} from '../shared/calendar-policy.ts';
import {applicationStatus} from '../shared/job-display.ts';
import {Store} from '../backend/db.ts';
import {schemas} from '../backend/model.ts';
import {jobCalendar,addJobCalendar,updateJobProgress,jobDetail} from '../backend/job-actions.ts';
import {announcementReport} from '../backend/announcement-report.ts';
import {listRecords} from '../backend/listings.ts';
import {mergeMilestones,type Extraction} from '../backend/agent.ts';
import {calendarFeed,subscriptionLink,updateSubscription} from '../backend/calendar-feed.ts';
import type {Config} from '../backend/config.ts';

const fixtures=JSON.parse(readFileSync(new URL('./fixtures/calendar-aliases-v14-4.json',import.meta.url),'utf8'));
const stage=(label:string,time='09:00',extra:any={})=>({id:label,label,date:'2026-09-20',time,evidence:label+' 2026年9月20日',inferredYear:false,...extra});
const chronological=(stages:any[])=>stages.map(s=>s.date+' '+s.time);
let store:Store;
beforeEach(()=>{mkdirSync('.check/calendar-focus-v14-4/tests',{recursive:true});store=new Store(mkdtempSync(resolve('.check/calendar-focus-v14-4/tests/case-')));});
afterEach(()=>store.db.close());
function seed(index=0){
  const ann=store.put(fixtures[index].id,'announcement',{...fixtures[index],status:'pending',url:'https://example.edu.cn/notice',body:'公开公告回放',analysisStatus:'done'});
  for(let i=0;i<2;i++)store.put('focus:job:'+i,'job',schemas.job.parse({title:'岗位'+i,type:'选调',url:ann.url,announcementId:ann.id}));
  return ann;
}
describe('calendar aliases and chronology',()=>{
  it.each([[0,13,11],[1,23,9]])('replays real announcement %s without reanalysis',(index,before,after)=>{
    const ann=seed(index),raw=structuredClone(ann.candidates),report=announcementReport(store,ann),preview=jobCalendar(store,'focus:job:0');
    expect(raw).toHaveLength(before);expect(preview.stages).toHaveLength(after);expect(report.candidates).toHaveLength(after);
    expect(chronological(preview.stages)).toEqual([...chronological(preview.stages)].sort());
    expect(preview.stages.filter((s:any)=>s.label==='报名开始')).toHaveLength(1);
    expect(preview.stages.filter((s:any)=>s.label==='报名截止')).toHaveLength(1);
    expect(store.get(ann.id).candidates).toEqual(raw);expect(ann.candidates).toEqual(raw);
    expect(normalizeCalendarStages(report.candidates)).toEqual(report.candidates);
    if(index===0){
      expect(preview.stages.find((s:any)=>s.label==='调剂报名开始').milestone).toBeUndefined();
      expect(preview.stages.find((s:any)=>s.label==='改报截止').date).toBe('2026-09-23');
      const day=preview.stages.filter((s:any)=>s.date==='2026-10-17');expect(day.map((s:any)=>s.label)).toEqual(['笔试','准考证打印截止']);
    }else expect(preview.stages.find((s:any)=>s.label==='资格初审截止').time).toBe('12:00');
  });
  it('merges aliases with a unique exact time, keeps first ID and explicit evidence',()=>{
    const raw=[stage('报名开始','',{id:'stable'}),stage('网上报名开始','09:00',{evidence:'报名于2026年9月20日09:00开始'})],before=structuredClone(raw);
    expect(normalizeCalendarStages(raw)).toEqual([{...raw[1],label:'报名开始',id:'stable',milestone:'registration_start'}]);expect(raw).toEqual(before);
  });
  it('retains conflicting clocks, unknown clocks, different dates, batches and phases',()=>{
    const raw=[stage('网上报名开始'),stage('报名开始','10:00'),stage('报名开始',''),stage('报名开始','09:00',{date:'2026-09-21'}),...['调剂报名开始','补录报名开始','改报开始','A类报名开始','B类报名开始','第一批报名开始'].map(l=>stage(l,'09:00',{milestone:'registration_start'}))];
    expect(normalizeCalendarStages(raw)).toHaveLength(raw.length);
    for(const s of raw.slice(4))expect(stageMilestone(s)).toBeUndefined();
  });
  it('preserves manual entries and their IDs, text and times',()=>{
    const manual=stage('网上报名开始','09:00',{id:'mine',origin:'manual',manualEdited:true}),auto=stage('报名开始','09:00',{origin:'ai'});
    expect(normalizeCalendarStages([auto,manual])).toContainEqual(manual);expect(normalizeCalendarStages([auto,manual])).toHaveLength(2);
    expect(normalizeCalendarStages([stage('网上报名开始'),stage('报名开始')],true)).toHaveLength(2);
  });
  it('writes exactly the preview once and publishes stable subscription UIDs',()=>{
    const ann=seed(),preview=jobCalendar(store,'focus:job:0');
    const added=addJobCalendar(store,'focus:job:0',{version:ann.version,stageIds:preview.stages.map((s:any)=>s.id),follow:false});
    const exam=store.get(added.id);expect(exam.stages).toHaveLength(11);expect(exam.title).toBe(ann.title);
    expect(exam.stages.map((s:any)=>[s.id,s.label,s.date,s.time])).toEqual(preview.stages.map((s:any)=>[s.id,s.label,s.date,s.time]));
    const config={origin:'https://example.invalid',masterKey:'a'.repeat(64)} as Config;
    updateSubscription(store,config,{action:'enable',version:0});const token=subscriptionLink(store,config).url.split('/').at(-1)!.slice(0,-4);
    const body=calendarFeed(store,config,token).body;expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(11);
    expect(addJobCalendar(store,'focus:job:1',{version:ann.version,stageIds:preview.stages.map((s:any)=>s.id)}).alreadyAdded).toBe(true);
    expect(calendarFeed(store,config,token).body.match(/UID:.+/g)).toEqual(body.match(/UID:.+/g));expect(store.list('exam')).toHaveLength(1);
  });
  it.each([false,true])('normalizes direct announcement imports from old and new clients (%s)',projected=>{
    const ann=seed(),stages=projected?announcementReport(store,ann).candidates:ann.candidates;
    const result=store.accept(ann.id,ann.version,{title:ann.title,type:ann.type,url:ann.url,stages});
    expect(store.get(result.id).stages).toHaveLength(11);expect(store.get(result.id).stages.every((s:any)=>s.origin==='ai')).toBe(true);
  });
  it('following recognizes legacy aliases without stealing a transfer-registration stage',()=>{
    const old={stages:[stage('网上报名开始','09:00',{id:'old',origin:'ai',milestone:'registration_start'}),stage('报名开始','09:00',{origin:'ai'}),stage('调剂报名开始','09:00',{origin:'ai',date:'2026-11-02',milestone:'registration_start'})]};
    const result=mergeMilestones(old,{stages:[]} as unknown as Extraction,[],false);
    expect(result.stages.filter(s=>stageMilestone(s)==='registration_start')).toHaveLength(1);
    expect(result.stages.find(s=>s.label==='报名开始').id).toBe('old');expect(result.stages.find(s=>s.label==='调剂报名开始').date).toBe('2026-11-02');
  });
  it('accepts repeated identical evidence but rejects conflicting or transfer dates for initial registration',()=>{
    const quote='报名于2026年9月20日09:00开始',doc={id:'public',title:'2027选调',url:'https://example.gov.cn/a',text:quote+'，调剂报名于2026年11月2日09:00开始。',published:'2026-09-01'};
    const one={milestone:'registration_start' as const,date:'2026-09-20',time:'09:00',evidence:quote,sourceId:'public'};
    const same=mergeMilestones(undefined,{stages:[one,one]} as Extraction,[doc],false);expect(same.stages.filter(s=>s.date)).toHaveLength(1);expect(same.rejected).toEqual([]);
    const transfer={...one,date:'2026-11-02',evidence:'调剂报名于2026年11月2日09:00开始'};
    const wrong=mergeMilestones(undefined,{stages:[transfer]} as Extraction,[doc],false);expect(wrong.stages.filter(s=>s.date)).toHaveLength(0);expect(wrong.rejected).toContain('报名开始');
  });
});
describe('explicit attention replaces application intent',()=>{
  it('retains old manual choices, counts both versions, excludes automatic 收藏 and inactive jobs',()=>{
    seed();for(const [i,status] of ['拟投递','关注','收藏','准备材料','关注','关注'].entries())store.put('count:'+i,'job',{...schemas.job.parse({title:'计数'+i,type:'其他',url:'',status}),archived:i===4,analysisCurrent:i!==5});
    expect(store.snapshot().jobCounts).toEqual({intended:2});
    for(const filter of ['关注','拟投递']){
      const result=listRecords(store,'job',new URLSearchParams({status:filter}));expect(result.total).toBe(2);expect(result.items.every(j=>j.applicationStatus==='关注')).toBe(true);
    }
    expect(applicationStatus(store.get('count:0'))).toBe('关注');expect(store.get('count:0').status).toBe('拟投递');expect(applicationStatus(store.get('count:2'))).toBe('未选择');
    expect(jobDetail(store,'count:0').applicationStatus).toBe('关注');
  });
  it('can follow, unfollow and preserve notes without editing matching or calendar state',()=>{
    seed();const job=store.get('focus:job:0');const followed=updateJobProgress(store,job.id,{version:job.version,status:'关注',notes:'我的记录'});
    expect(followed.applicationStatus).toBe('关注');expect(store.snapshot().jobCounts).toEqual({intended:1});
    const cancelled=updateJobProgress(store,job.id,{version:followed.version,status:'未选择'});expect(cancelled.notes).toBe('我的记录');expect(store.snapshot().jobCounts).toEqual({intended:0});
    expect(store.list('exam')).toHaveLength(0);expect(cancelled.majorRequirements).toEqual(job.majorRequirements);
  });
});
