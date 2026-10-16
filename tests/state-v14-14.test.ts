import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../backend/db.ts';
import {schemas} from '../backend/model.ts';
import {hash,type Config} from '../backend/config.ts';
import {announcementReport} from '../backend/announcement-report.ts';
import {announcementScreenView,recruitmentReader} from '../backend/recruitment-reader.ts';
import {listRecords} from '../backend/listings.ts';
import {jobCalendar,addJobCalendar} from '../backend/job-actions.ts';
import {calendarFeed,updateSubscription,subscriptionLink} from '../backend/calendar-feed.ts';
import {mergeMilestones,type Extraction} from '../backend/agent.ts';
import {calendarExamView,normalizeCalendarStages,stageMilestone} from '../shared/calendar-policy.ts';

let store:Store;
beforeEach(()=>{mkdirSync('.check/state-v14-14/tests',{recursive:true});store=new Store(mkdtempSync(resolve('.check/state-v14-14/tests/case-')));});
afterEach(()=>{store.db.close();vi.useRealTimers();});
const stage=(id:string,label:string,extra:any={})=>({id,label,date:'2026-10-14',time:'10:00',evidence:'2026年10月14日10:00开始下载打印纸质准考证',origin:'ai',manualEdited:false,inferredYear:false,sourceUrl:'',...extra});
const exam=(stages:any[])=>schemas.exam.parse({title:'合成选调公告',type:'选调',url:'',calendarKind:'exam',stages,tracking:{enabled:true,passed:false,query:'合成选调公告'}});
const paired=()=>[stage('old','打印笔试准考证开始'),stage('ai:ticket_start','准考证打印开始',{milestone:'ticket_start'})];
const list=(status='全部')=>listRecords(store,'announcement',new URLSearchParams({status}));
function notice(){store.put('ann','announcement',{title:'合成选调公告',body:'岗位不限专业',province:'湖北省',type:'选调',status:'accepted',analysisStatus:'done',candidates:[]});store.put('job','job',schemas.job.parse({title:'合成岗位',type:'选调',url:'',announcementId:'ann'}));}

describe('saved calendars use one conservative projection',()=>{
  it('recognizes written admission ticket aliases and updates the existing ID',()=>{
    const before=exam(paired()),raw=structuredClone(before),view=calendarExamView(before);
    expect(view.stages).toHaveLength(1);expect(view.stages[0]).toMatchObject({id:'old',milestone:'ticket_start',label:'准考证打印开始'});
    expect(before).toEqual(raw);expect(calendarExamView(view)).toEqual(view);
    const quote='2026年10月14日10:00开始下载打印纸质准考证';
    const merged=mergeMilestones(before,{stages:[{milestone:'ticket_start',date:'2026-10-14',time:'10:00',evidence:quote,sourceId:'doc'}]} as Extraction,[{id:'doc',title:'合成公告',url:'https://example.invalid/notice',text:quote,published:'2026-10-01'}],false);
    expect(merged.stages.filter(s=>stageMilestone(s)==='ticket_start')).toHaveLength(1);
    expect(merged.stages.find(s=>s.milestone==='ticket_start').id).toBe('old');expect(merged.conflicts).toEqual([]);
  });
  it('collapses combined recommendation procedures but keeps standalone and qualified steps',()=>{
    const labels=['报名推荐表打印审核截止','报名推荐表审核鉴章截止','报名推荐表审核盖章截止','报名推荐表打印盖章截止','报名推荐表办理截止','报名推荐表打印及审核鉴章截止'];
    const same=labels.map((l,i)=>stage('s'+i,l,{time:'',date:'2026-10-23'}));
    expect(normalizeCalendarStages(same,true)).toHaveLength(1);
    const distinct=['报名推荐表打印截止','报名推荐表审核截止','第二批报名推荐表办理截止','面试准考证打印开始','打印面试准考证开始','调剂报名开始'].map((l,i)=>stage('other'+i,l));
    expect(normalizeCalendarStages(distinct,true)).toHaveLength(distinct.length);
    expect(normalizeCalendarStages([stage('a','六项选调条件取得截止'),stage('b','选调条件取得截止')],true)).toHaveLength(1);
  });
  it('keeps manual, unowned, personal, conflicting-clock and different-day entries',()=>{
    const protectedStages=[stage('manual','打印笔试准考证开始',{origin:'manual'}),stage('edited','打印笔试准考证开始',{manualEdited:true}),stage('legacy','打印笔试准考证开始',{origin:undefined})];
    const conflicts=[stage('late','准考证打印开始',{time:'11:00'}),stage('unknown','准考证打印开始',{time:''}),stage('other-day','准考证打印开始',{date:'2026-10-15'})];
    const view=calendarExamView(exam([...paired(),...protectedStages,...conflicts]));
    expect(view.stages).toHaveLength(7);
    for(const p of protectedStages)expect(view.stages.find(s=>s.id===p.id)).toMatchObject(p);
    const personal={...exam(paired()),calendarKind:'personal'};expect(calendarExamView(personal)).toEqual(personal);
  });
  it('shows one date in state and job preview without rewriting the original records',()=>{
    notice();const saved=store.put('exam:ann','exam',{...exam(paired()),announcementId:'ann'}),before=JSON.stringify(store.get(saved.id));
    expect(store.snapshot(true).exams[0].stages).toHaveLength(1);
    expect(jobCalendar(store,'job').existing.stages).toHaveLength(1);
    expect(announcementScreenView(announcementReport(store,store.get('ann'))).calendar.stages).toHaveLength(1);
    expect(JSON.stringify(store.get(saved.id))).toBe(before);
  });
  it('saving a projected calendar keeps automatic ownership and does not suppress the retained phase',()=>{
    const saved=store.save('exam',exam([]));
    const raw=store.put(saved.id,'exam',exam(paired()),saved.version),view=calendarExamView(raw);
    const updated=store.save('exam',view,raw.id,raw.version);
    expect(updated.stages).toHaveLength(1);expect(updated.stages[0]).toMatchObject({origin:'ai',manualEdited:false,milestone:'ticket_start'});
    expect(updated.tracking.suppressed).not.toContain('ticket_start');
    const edited=store.save('exam',{...updated,stages:[{...updated.stages[0],time:'12:00'}]},updated.id,updated.version);
    expect(edited.stages[0].manualEdited).toBe(true);
  });
  it('removing a projected phase suppresses future auto updates for that phase',()=>{
    const raw=store.put('exam:ann','exam',exam(paired()));
    const updated=store.save('exam',{...calendarExamView(raw),stages:[]},raw.id,raw.version);
    expect(updated.tracking.suppressed).toContain('ticket_start');
  });
  it('cancels previously published duplicates with stable retained UIDs and keeps separate announcements',()=>{
    const a=store.put('exam:a','exam',exam(paired()));store.put('exam:b','exam',{...exam([paired()[0]]),title:'另一公告'});
    const config={origin:'https://example.invalid',masterKey:'a'.repeat(64)} as Config;
    updateSubscription(store,config,{action:'enable',version:0});const token=subscriptionLink(store,config).url.split('/').at(-1)!.slice(0,-4);
    const uid=(id:string,s:string)=>hash(JSON.stringify(['exam',id,s]))+'@jindu.calendar';
    const journal=Object.fromEntries(a.stages.map((s:any)=>[uid(a.id,s.id),{event:{title:a.title+' · '+s.label,date:s.date,time:s.time,category:'考试'},sequence:3,updatedAt:'2026-10-13T00:00:00Z',cancelled:false}]));
    store.setSetting('calendar-subscription-events',journal);
    const original=JSON.stringify(store.list('exam')),feed=calendarFeed(store,config,token),entries=feed.body.replace(/\r\n /g,'').split('BEGIN:VEVENT\r\n').slice(1);
    expect(entries.filter(e=>e.includes('STATUS:CONFIRMED'))).toHaveLength(2);
    const cancelled=entries.find(e=>e.includes('UID:'+uid(a.id,'ai:ticket_start')))!,retained=entries.find(e=>e.includes('UID:'+uid(a.id,'old')))!;
    expect(cancelled).toContain('STATUS:CANCELLED');expect(cancelled).toContain('SEQUENCE:4');expect(retained).toContain('STATUS:CONFIRMED');
    expect(calendarFeed(store,config,token)).toEqual(feed);expect(JSON.stringify(store.list('exam'))).toBe(original);
    const restarted=new Store(store.dir);try{expect(calendarFeed(restarted,config,token)).toEqual(feed);}finally{restarted.db.close();}
  });
});

describe('announcement calendar state follows the linked calendar',()=>{
  it('uses archive/restore state consistently in list filters, detail and import guards',()=>{
    notice();const e=store.put('exam:ann','exam',{...exam(paired()),archived:true,announcementId:'ann'});
    expect(list().items[0].calendarStatus).toBe('archived');expect(list('已加入日历').total).toBe(0);
    const detail=announcementScreenView(announcementReport(store,store.get('ann')));
    expect(detail).toMatchObject({status:'accepted',calendarStatus:'archived',calendar:{id:e.id,archived:true}});
    expect(addJobCalendar(store,'job',{version:store.get('ann').version,stageIds:['anything']})).toMatchObject({id:e.id,alreadyAdded:true,archived:true});
    store.put(e.id,'exam',{...e,archived:false},e.version);
    expect(list('已加入日历').total).toBe(1);expect(announcementReport(store,store.get('ann')).calendarStatus).toBe('added');
  });
  it('prefers a remaining active calendar and ignores personal schedules and stale accepted flags',()=>{
    notice();expect(announcementReport(store,store.get('ann')).calendar).toBeNull();
    store.put('exam:ann','exam',{...exam([]),archived:true});
    store.put('active','exam',{...exam([]),announcementId:'ann'});
    store.put('personal','exam',{...exam([]),calendarKind:'personal',announcementId:'ann'});
    expect(announcementReport(store,store.get('ann')).calendar.id).toBe('active');expect(jobCalendar(store,'job').existing.id).toBe('active');
    expect(list('已加入日历').items[0].calendarStatus).toBe('added');
  });
});

describe('date dependent qualification cache',()=>{
  function seed(){
    notice();store.save('profile',{title:'测试条件',education:[{level:'本科',major:'土壤学'}],eligibility:{certificatesStatus:'complete',certificates:[{name:'安全员证',date:'2025-01-01',expires:'2026-10-14'}]}});
    const quote='岗位不限专业；须持有安全员证';store.put('ann','announcement',{...store.get('ann'),body:quote},store.get('ann').version);
    store.put('job','job',schemas.job.parse({title:'合成岗位',type:'选调',url:'',announcementId:'ann',eligibilityCoverage:'complete',majorRequirements:[{levels:['本科'],names:[],unrestricted:true,evidence:'岗位不限专业'}],eligibilityRequirements:[{label:'证书要求',mode:'all',evidence:'须持有安全员证',criteria:[{kind:'certificate',label:'安全员证',evidence:'须持有安全员证',accepted:['安全员证']}]}]}),store.get('job').version);
  }
  const read=()=>{const r=recruitmentReader(store);return r.job(r.get('job'));};
  it.each([false,true])('expires at Beijing midnight without record changes (heartbeat=%s)',heartbeat=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-14T15:59:59Z'));seed();
    const first=read();expect(first.eligibilityChecks.status).toBe('met');expect(read()).toBe(first);
    vi.setSystemTime(new Date('2026-10-14T16:00:00Z'));if(heartbeat)store.setSetting('worker-status',{lastHeartbeat:new Date().toISOString()});
    const next=read();expect(next.eligibilityChecks.status).toBe('unmet');expect(next.match).toBe('不符合');expect(read()).toBe(next);
    expect(listRecords(store,'job',new URLSearchParams()).items[0].eligibilityChecks.status).toBe('unmet');
    expect(announcementReport(store,store.get('ann')).jobs[0].eligibilityChecks.status).toBe('unmet');
  });
  it('keeps a same-Beijing-day cache hit across UTC midnight and handles clock rollback',()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T23:59:59Z'));seed();const first=read();
    vi.setSystemTime(new Date('2026-10-14T00:00:01Z'));expect(read()).toBe(first);
    vi.setSystemTime(new Date('2026-10-14T16:00:00Z'));expect(read().eligibilityChecks.status).toBe('unmet');
    vi.setSystemTime(new Date('2026-10-14T15:00:00Z'));expect(read().eligibilityChecks.status).toBe('met');
  });
});
