import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { mkdirSync,mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../backend/db.ts';
import { aiSettings,saveAI,type Config } from '../backend/config.ts';
import { beginUsage,finishUsage,measuredUsage,usageSummary } from '../backend/usage.ts';
import { eligibilityFactsSchema,eligibilityGroupsSchema,evaluateEligibility } from '../shared/eligibility.ts';
import { matchJob } from '../backend/matching.ts';
import { analyze } from '../backend/ai.ts';
import { requestPublic } from '../backend/net.ts';
import { todayCN } from '../shared/model.ts';
import { initializeWorker } from '../backend/worker.ts';
vi.mock('../backend/net.ts',async original=>({...await original<typeof import('../backend/net.ts')>(),requestPublic:vi.fn()}));
let store:Store,config:Config;
beforeEach(()=>{mkdirSync('.check/v9/tests',{recursive:true});const dataDir=mkdtempSync(resolve('.check/v9/tests/case-'));store=new Store(dataDir);config={dataDir,origin:'http://127.0.0.1:8899',host:'127.0.0.1',port:8899,adminUsername:'fixture',passwordHash:'unused',masterKey:randomBytes(32).toString('hex'),python:'unused',distDir:resolve('dist')};vi.mocked(requestPublic).mockReset();});
afterEach(()=>store.db.close());
const clause='中共党员或校级优秀学生干部；班长任职满12个月，截至2026年9月1日。';
const group=(mode:'all'|'any'='any')=>eligibilityGroupsSchema.parse([{label:'选调附加资格',mode,evidence:clause,criteria:[{kind:'political',label:'党员',evidence:'中共党员',accepted:['中共党员']},{kind:'award',label:'优秀学生干部',evidence:'校级优秀学生干部',accepted:['优秀学生干部'],levels:['校级']}]}]);
const facts=(overrides:any={})=>eligibilityFactsSchema.parse(overrides);
const education=[{level:'本科',major:'土地资源管理',code:'120404',year:'2027',school:'测试大学'}];
const majorEvidence='本科土地资源管理专业。';
const requirement={levels:['本科'],names:['土地资源管理'],evidence:majorEvidence};
const job=(p:string)=>({title:'选调岗位',profileId:p,type:'选调',organization:'测试单位',url:'',announcementId:'ann',majorRequirements:[requirement],eligibilityRequirements:group(),eligibilityCoverage:'complete',analysisIncomplete:false});

describe('unlimited daily AI usage',()=>{
  it('keeps counting above a saved quota, survives reopening, and restores quota enforcement',()=>{
    saveAI(store,{baseUrl:'https://example.com/v1',key:'fixture-only',model:'fixture',dailyLimit:1},config);
    finishUsage(store,beginUsage(store,'fixture','test',1),'success',measuredUsage({prompt_tokens:12,completion_tokens:3}));
    store.put('ann','announcement',{analysisStatus:'waiting_quota',analysisError:'旧额度错误'});store.enqueue('queue:ann','analyze',{id:'ann'});store.db.prepare("UPDATE jobs SET state='waiting_quota',available_at=?").run(Date.now()+86400000);
    saveAI(store,{...aiSettings(store),unlimited:true},config);
    expect(store.db.prepare('SELECT state,available_at FROM jobs').get()).toMatchObject({state:'pending',available_at:0});expect(store.get('ann')).toMatchObject({analysisStatus:'pending',analysisError:''});
    const reopened=new Store(config.dataDir);
    try {const s=aiSettings(reopened);expect(s.unlimited).toBe(true);finishUsage(reopened,beginUsage(reopened,s.model,'calendar',s.dailyLimit,s.unlimited),'success',measuredUsage({prompt_tokens:20,completion_tokens:5}));expect(usageSummary(reopened).periods.today).toMatchObject({calls:2,total:40});} finally {reopened.db.close();}
    saveAI(store,{...aiSettings(store),unlimited:false},config);expect(()=>beginUsage(store,'fixture','test',1)).toThrow('上限');
    expect(requestPublic).not.toHaveBeenCalled();
  });
  it('does not enable unlimited for pre-v9 settings and never resets recorded usage',()=>{
    store.setSetting('ai',{dailyLimit:1000});store.db.prepare('INSERT INTO usage(day,calls) VALUES(?,?)').run(todayCN(),4000);
    expect(aiSettings(store).unlimited).toBe(false);expect(()=>beginUsage(store,'fixture','calendar',1000)).toThrow();expect(usageSummary(store).periods.today.calls).toBe(4000);
  });
});
describe('evidenced eligibility checks',()=>{
  it('preserves OR and AND requirements and does not accept probationary membership as full membership',()=>{
    const f=facts({politicalStatus:'中共预备党员',awardsStatus:'complete',awards:[{name:'优秀学生干部',level:'校级'}]});
    expect(evaluateEligibility(group('any'),f,clause).status).toBe('met');expect(evaluateEligibility(group('all'),f,clause).status).toBe('unmet');
  });
  it('distinguishes an unfilled award history from explicitly having none',()=>{
    expect(evaluateEligibility(group(),facts({politicalStatus:'群众'}),clause).status).toBe('missing');
    expect(evaluateEligibility(group(),facts({politicalStatus:'群众',awardsStatus:'none'}),clause).status).toBe('unmet');
  });
  it('does not invent equivalence or accept unsupported evidence',()=>{
    expect(evaluateEligibility(group(),facts({politicalStatus:'群众',awardsStatus:'complete',awards:[{name:'三好学生',level:'校级'}]}),clause).status).toBe('review');
    expect(evaluateEligibility(group(),facts({politicalStatus:'中共党员'}),'专业不限').status).toBe('review');
  });
  it('checks membership cutoffs and asks for missing dates',()=>{
    const g=group('all').map(g=>({...g,criteria:[{...g.criteria[0],asOf:'2026-09-01'}]}));
    expect(evaluateEligibility(g,facts({politicalStatus:'中共党员'}),clause).status).toBe('missing');
    expect(evaluateEligibility(g,facts({politicalStatus:'中共党员',politicalSince:'2026-09-10'}),clause).status).toBe('unmet');
  });
  it('requires a complete duration in one role and does not credit future service',()=>{
    const g=eligibilityGroupsSchema.parse([{label:'任职时长',mode:'all',evidence:clause,criteria:[{kind:'leadership',label:'班长满一年',evidence:'班长任职满12个月，截至2026年9月1日',accepted:['班长'],minMonths:12,asOf:'2026-09-01'}]}]);
    const f=facts({rolesStatus:'complete',roles:[{name:'班长',start:'2025-09-02',end:'2026-09-01'}]});
    expect(evaluateEligibility(g,f,clause,'2026-09-21').status).toBe('unmet');
    f.roles[0].start='2025-09-01';expect(evaluateEligibility(g,f,clause,'2026-09-21').status).toBe('met');
    f.roles=[{name:'班长',scope:'',organization:'',start:'2026-03-01',end:''}];g[0].criteria[0].asOf='2027-09-01';expect(evaluateEligibility(g,f,clause,'2026-09-21').status).toBe('missing');
  });
  it('keeps open-ended vague or complex requirements pending',()=>{
    const g=eligibilityGroupsSchema.parse([{label:'其他要求',mode:'all',evidence:'应有相关工作经历',criteria:[{kind:'other',label:'工作经历',evidence:'应有相关工作经历'}]}]);expect(evaluateEligibility(g,facts(),'应有相关工作经历').status).toBe('review');
  });
  it('does not credit future awards or appointments and requires temporal overlap',()=>{
    const a=group('all').map(g=>({...g,criteria:[g.criteria[1]]}));expect(evaluateEligibility(a,facts({awardsStatus:'complete',awards:[{name:'优秀学生干部',level:'校级',date:'2027-01-01'}]}),clause,'2026-09-21').status).toBe('missing');
    const g=eligibilityGroupsSchema.parse([{label:'在指定时段任职',mode:'all',evidence:clause,criteria:[{kind:'leadership',label:'班长',evidence:'班长任职满12个月，截至2026年9月1日',accepted:['班长'],from:'2025-09-01',to:'2026-09-01'}]}]);
    expect(evaluateEligibility(g,facts({rolesStatus:'complete',roles:[{name:'班长',start:'2023-01-01',end:'2024-01-01'}]}),clause).status).toBe('unmet');
    expect(evaluateEligibility(g,facts({rolesStatus:'complete',roles:[{name:'班长',start:'2027-01-01'}]}),clause,'2026-09-21').status).toBe('missing');
  });
  it('checks explicit birth date boundaries and fresh graduate year independently',()=>{
    const evidence='1995年1月1日至2005年12月31日出生，2027届应届毕业生。';const g=eligibilityGroupsSchema.parse([{label:'基本条件',mode:'all',evidence,criteria:[{kind:'birthDate',label:'出生日期',evidence:'1995年1月1日至2005年12月31日出生',from:'1995-01-01',to:'2005-12-31'},{kind:'freshGraduate',label:'应届身份',evidence:'2027届应届毕业生',accepted:['2027']}]}]);
    expect(evaluateEligibility(g,facts({birthday:'1995-01-01',freshGraduate:'yes',freshGraduateYear:'2027'}),evidence).status).toBe('met');
    expect(evaluateEligibility(g,facts({birthday:'1994-12-31',freshGraduate:'yes',freshGraduateYear:'2027'}),evidence).status).toBe('unmet');
    expect(evaluateEligibility(g,facts({birthday:'2000-01-01',freshGraduate:'yes'}),evidence).status).toBe('missing');
  });
  it('rejects inconsistent profile records and date ordering',()=>{
    expect(()=>facts({roles:[{name:'班长',start:'2026-09-01',end:'2025-09-01'}]})).toThrow();expect(()=>facts({awardsStatus:'none',awards:[{name:'优秀学生干部'}]})).toThrow();
  });
});
describe('profile and announcement integration',()=>{
  it('upgrading or migrating resumes only interrupted jobs without scheduling completed history',()=>{
    store.put('historical','announcement',{title:'历史公告',analysisStatus:'done',analysisVersion:2});store.enqueue('in-flight','analyze',{id:'current'});store.db.prepare("UPDATE jobs SET state='running' WHERE id='in-flight'").run();initializeWorker(store);
    expect(store.db.prepare('SELECT id,state FROM jobs').all()).toEqual([{id:'in-flight',state:'retry'}]);expect(requestPublic).not.toHaveBeenCalled();
  });
  it('rechecks a saved requirement after editing facts without enqueueing historical AI analysis',()=>{
    const p=store.save('profile',{title:'本人',education,eligibility:facts({politicalStatus:'群众',awardsStatus:'none'})});store.put('ann','announcement',{body:majorEvidence+clause,fileIds:[]});store.put('job','job',job(p.id));
    expect(matchJob(store.get('job'),[p],majorEvidence+clause).match).toBe('不符合');
    const updated=store.save('profile',{...p,eligibility:facts({politicalStatus:'中共党员'})},p.id,p.version);expect(store.get('job')).toMatchObject({match:'符合',majorStatus:'matched',eligibilityProfile:'本人'});expect(updated.eligibility.politicalStatus).toBe('中共党员');
    expect(store.db.prepare('SELECT count(*) n FROM jobs').get()).toMatchObject({n:0});expect(requestPublic).not.toHaveBeenCalled();expect(store.list('exam')).toHaveLength(0);
  });
  it('never combines a matching degree from one profile with another profile’s political status',()=>{
    const p=store.save('profile',{title:'学历档案',education,eligibility:facts({politicalStatus:'群众',awardsStatus:'none'})});const other=store.save('profile',{title:'另一档案',education:[],eligibility:facts({politicalStatus:'中共党员'})});
    expect(matchJob(job(other.id),[p,other],majorEvidence+clause)).toMatchObject({profileId:p.id,match:'不符合'});
  });
  it('does not label legacy, incomplete, or unverified requirements as fully qualified',()=>{
    const p=store.save('profile',{title:'本人',education,eligibility:facts({politicalStatus:'中共党员'})});
    expect(matchJob({...job(p.id),eligibilityCoverage:undefined},[p],majorEvidence+clause).match).toBe('待核对');expect(matchJob({...job(p.id),analysisIncomplete:true},[p],majorEvidence+clause).match).toBe('待核对');
  });
  it('extracts and evaluates evidence through the real analysis pipeline with one mocked provider response',async()=>{
    const p=store.save('profile',{title:'本人',education,eligibility:facts({politicalStatus:'中共党员'})});const a=store.put('ann','announcement',{title:'2027选调公告',body:majorEvidence+clause,published:'2026-09-21',url:'https://example.com/notice',contentHash:'one',fileIds:[],status:'pending'});
    saveAI(store,{baseUrl:'https://example.com/v1',key:'fixture-only',model:'fixture',dailyLimit:1,unlimited:true},config);
    const result={relevant:true,type:'选调',summary:'测试',jobs:[{...job(p.id),match:'符合',reasons:'测试',evidence:majorEvidence+clause}]};
    vi.mocked(requestPublic).mockResolvedValue({status:200,headers:{},url:'',body:Buffer.from(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:25,completion_tokens:15}}))});
    await analyze(store,config,a.id);const [saved]=store.list('job');expect(saved).toMatchObject({match:'符合',eligibilityCoverage:'complete',analysisIncomplete:false});expect(saved.eligibilityChecks.groups[0].items[0].status).toBe('met');expect(store.list('exam')).toHaveLength(0);
  });
});
