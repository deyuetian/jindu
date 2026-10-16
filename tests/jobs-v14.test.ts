import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../backend/db.ts';
import {schemas} from '../backend/model.ts';
import {jobCalendar,addJobCalendar,updateJobProgress} from '../backend/job-actions.ts';
import {regionName,majorSummary,applicationStatus} from '../shared/job-display.ts';
import {jobPresentation} from '../shared/recruitment-report.ts';
import {listRecords} from '../backend/listings.ts';
import {mergeMilestones} from '../backend/agent.ts';
import {analyze} from '../backend/ai.ts';
import {requestPublic} from '../backend/net.ts';
import {saveAI,type Config} from '../backend/config.ts';
import {calendarFeed,subscriptionLink,updateSubscription} from '../backend/calendar-feed.ts';
vi.mock('../backend/net.ts',async original=>({...await original<typeof import('../backend/net.ts')>(),requestPublic:vi.fn()}));
let store:Store;
beforeEach(()=>{mkdirSync('.check/v14/tests',{recursive:true});store=new Store(mkdtempSync(resolve('.check/v14/tests/case-')));vi.mocked(requestPublic).mockReset();});
afterEach(()=>store.db.close());
const stage=(label:string,date:string)=>({id:label,label,date,time:'',evidence:'公告：'+date,inferredYear:false});
const seed=()=>{
  const ann=store.put('ann:v14','announcement',{title:'湖北省2027年选调生招录公告',type:'选调',body:'不限专业，2026-10-12报名截止',status:'pending',url:'https://example.edu.cn/notice',province:'湖北',published:'2026-09-20',candidates:[stage('报名开始','2026-10-01'),stage('报名截止','2026-10-12'),stage('笔试','2026-11-08'),stage('成绩查询',''),stage('面试','2026-12-10')]});
  for(let i=1;i<=2;i++)store.put('job:'+i,'job',schemas.job.parse({title:'岗位 '+i,organization:'武汉市直属单位',type:'选调',province:i===1?'湖北':'湖北省',url:ann.url,announcementId:ann.id,majorRequirements:[{unrestricted:true,evidence:'不限专业'}]}));
  return ann;
};
describe('canonical job display',()=>{
  it.each([
    ['湖北','湖北省'],['湖北省','湖北省'],['湖北省武汉市','湖北省 · 武汉市'],['湖北 · 武汉市','湖北省 · 武汉市'],
    ['湖南省 · 湘潭市','湖南省 · 湘潭市'],['北京','北京市'],['北京市朝阳区','北京市 · 朝阳区'],
    ['广西','广西壮族自治区'],['广西自治区南宁市','广西壮族自治区 · 南宁市'],['宁夏回族自治区','宁夏回族自治区'],
    ['新疆乌鲁木齐市','新疆维吾尔自治区 · 乌鲁木齐市'],['内蒙古','内蒙古自治区'],['香港','香港特别行政区'],['吉林市','吉林市'],['海南藏族自治州','海南藏族自治州'],['湖北省内','湖北省内'],['全国','全国'],['',''],
  ])('normalizes %s without changing a second time',(raw,expected)=>{expect(regionName(raw)).toBe(expected);expect(regionName(regionName(raw))).toBe(expected);});
  it('uses the same region for source location, fallback and search; preserves source evidence',()=>{
    seed();const j=store.get('job:1');store.put(j.id,'job',{...j,sourcePosition:{education:'硕士',major:'不限专业',count:'1',location:'湖北省武汉市',description:''}},j.version);
    expect(jobPresentation(store.get(j.id),store.get('ann:v14')).displayRegion).toBe('湖北省 · 武汉市');
    expect(listRecords(store,'job',new URLSearchParams('q=湖北省')).total).toBe(2);
    expect(listRecords(store,'job',new URLSearchParams('q=湖北省武汉市')).total).toBe(1);
    expect(store.get(j.id).sourcePosition.location).toBe('湖北省武汉市');expect(store.get('job:2').province).toBe('湖北省');
  });
  it('shortens requirements without conflating degree-specific limits',()=>{
    expect(majorSummary({majorRequirements:[{unrestricted:true}]})).toBe('不限专业');
    expect(majorSummary({majorRequirements:[{names:['农学']}],majorReason:'硕士 土壤学 → 农学（目录）'})).toBe('招收农学');
    expect(majorSummary({majorRequirements:[{levels:['本科'],unrestricted:true},{levels:['硕士'],names:['土壤学']}]})).toBe('本科：不限专业；硕士：招收土壤学');
  });
  it('filters on the refreshed verdict instead of displaying unknown jobs under 专业符合',()=>{
    seed();store.save('profile',{title:'本人',education:[{level:'硕士',major:'土壤学',code:'090301'}]});
    const j=store.get('job:2');store.put(j.id,'job',{...j,majorStatus:'matched',majorRequirements:[],sourcePosition:undefined},j.version);
    const result=listRecords(store,'job',new URLSearchParams('status=专业符合'));
    expect(result.items.map(j=>j.id)).toEqual(['job:1']);expect(result.items[0].majorStatus).toBe('unrestricted');
  });
});
describe('manual application intent',()=>{
  it('keeps old automatic 收藏 unselected and filters only explicit 拟投递',()=>{
    seed();const old=store.get('job:1');store.put(old.id,'job',{...old,status:'收藏'},old.version);
    expect(applicationStatus(store.get(old.id))).toBe('未选择');expect(store.get('job:2').status).toBe('未选择');
    expect(listRecords(store,'job',new URLSearchParams('status=拟投递')).total).toBe(0);
    const current=store.get('job:1');updateJobProgress(store,current.id,{version:current.version,status:'拟投递'});
    expect(listRecords(store,'job',new URLSearchParams('status=拟投递')).items.map(j=>j.id)).toEqual(['job:1']);
    const changed=store.get(current.id);updateJobProgress(store,changed.id,{version:changed.version,status:'未选择'});expect(listRecords(store,'job',new URLSearchParams('status=拟投递')).total).toBe(0);
  });
  it('patches progress without erasing analyst fields and rejects stale devices',()=>{
    seed();const j=store.get('job:1');const current=store.put(j.id,'job',{...j,analysisCurrent:true,specialSourceFact:'kept'},j.version);
    updateJobProgress(store,j.id,{version:current.version,status:'拟投递',notes:'准备简历'});
    expect(store.get(j.id)).toMatchObject({notes:'准备简历',status:'拟投递',analysisCurrent:true,specialSourceFact:'kept'});
    expect(()=>updateJobProgress(store,j.id,{version:current.version,status:'未选择'})).toThrow('已被另一设备');
    expect(()=>updateJobProgress(store,j.id,{version:store.get(j.id).version,status:'专业符合'})).toThrow();
    expect(store.list('exam')).toHaveLength(0);
  });
  it('keeps the users choice on a new analysis and never selects a new job',async()=>{
    const dir=store.db.location() as string;
    const config={dataDir:resolve(dir,'..'),origin:'http://localhost',host:'127.0.0.1',port:8788,adminUsername:'fixture',passwordHash:'unused',masterKey:'f'.repeat(64),python:'unused',distDir:resolve('dist')} as Config;
    saveAI(store,{baseUrl:'https://example.invalid/v1',model:'fixture',key:'fixture',dailyLimit:20},config);
    store.put('ai:ann','announcement',{title:'示例公司招聘',body:'法务，本科及以上，不限专业。',url:'https://example.edu.cn/a',type:'企业招聘',source:'手动录入',contentHash:'fixture',fileIds:[],materialsComplete:true,candidates:[]});
    const result={relevant:true,type:'企业招聘',summary:'示例公司招聘',dates:[],jobs:[{title:'法务',match:'待核对',reasons:'学历待核对',evidence:'不限专业',majorRequirements:[{unrestricted:true,evidence:'不限专业'}]}]};
    vi.mocked(requestPublic).mockResolvedValue({status:200,headers:{},url:'',body:Buffer.from(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}))});
    await analyze(store,config,'ai:ann');let job=store.list('job')[0];expect(job.status).toBe('未选择');
    updateJobProgress(store,job.id,{version:job.version,status:'拟投递',notes:'我的记录'});
    store.enqueueAnalysis('ai:ann',true);await analyze(store,config,'ai:ann');job=store.list('job')[0];expect(job.status).toBe('拟投递');expect(job.notes).toBe('我的记录');
  });
});
describe('job calendar uses the parent announcement',()=>{
  it('adds selected parent nodes, independent of job intent; repeat requests do not duplicate or overwrite',()=>{
    seed();const preview=jobCalendar(store,'job:1');expect(preview.stages.map((s:any)=>s.label)).toEqual(['报名开始','报名截止','笔试']);
    const result=addJobCalendar(store,'job:1',{version:preview.version,stageIds:preview.stages.map((s:any)=>s.id),follow:true});
    let exam=store.get(result.id);expect(exam.title).toBe('湖北省2027年选调生招录公告');expect(exam.stages).toHaveLength(3);expect(exam.tracking).toMatchObject({enabled:true,passed:false});
    const changed=store.save('exam',{...exam,stages:exam.stages.map((s:any,i:number)=>i===0?{...s,date:'2026-10-02'}:s)},exam.id,exam.version);
    expect(addJobCalendar(store,'job:2',{version:preview.version,stageIds:[preview.stages[0].id]}).alreadyAdded).toBe(true);
    expect(store.list('exam')).toHaveLength(1);expect(store.get(result.id).version).toBe(changed.version);expect(store.get(result.id).stages[0].date).toBe('2026-10-02');expect(store.get('job:1').status).toBe('未选择');
    expect(mergeMilestones(store.get(result.id),{stages:[]} as any,[],false).stages.filter(s=>s.date)).toHaveLength(3);
  });
  it('cannot fabricate dates, import interview stages or use an old announcement version',()=>{
    const ann=seed(),preview=jobCalendar(store,'job:1');
    expect(()=>addJobCalendar(store,'job:1',{version:ann.version,stageIds:['candidate:4']})).toThrow('日期已变化');
    expect(()=>addJobCalendar(store,'job:1',{version:ann.version,stageIds:[]})).toThrow();
    store.put(ann.id,'announcement',{...ann,candidates:[]},ann.version);
    expect(()=>addJobCalendar(store,'job:1',{version:preview.version,stageIds:['candidate:0']})).toThrow('公告已有更新');
    expect(jobCalendar(store,'job:1').stages).toHaveLength(0);expect(store.list('exam')).toHaveLength(0);
  });
  it('reuses archived and agent-created calendars, preserving their existing UID',()=>{
    seed();const ann=store.get('ann:v14');store.put('exam:agent:existing','exam',schemas.exam.parse({title:ann.title,announcementId:ann.id,type:ann.type,url:ann.url,stages:[stage('报名截止','2026-10-12')],archived:true}));
    const preview=jobCalendar(store,'job:1');expect(preview.existing.id).toBe('exam:agent:existing');
    expect(addJobCalendar(store,'job:1',{version:preview.version,stageIds:['candidate:1']})).toMatchObject({id:'exam:agent:existing',alreadyAdded:true,archived:true});expect(store.list('exam')).toHaveLength(1);
  });
  it('preserves deselected milestones during following and leaves all AI counters unchanged',()=>{
    seed();const preview=jobCalendar(store,'job:1');const result=addJobCalendar(store,'job:1',{version:preview.version,stageIds:['candidate:1'],follow:false});
    const exam=store.get(result.id);expect(exam.tracking.enabled).toBe(false);expect(exam.tracking.suppressed).toEqual(['registration_start','written']);expect(requestPublic).not.toHaveBeenCalled();expect(store.list('job')).toHaveLength(2);
  });
  it('publishes the announcement title and stable event IDs to a calendar subscriber',()=>{
    seed();const preview=jobCalendar(store,'job:1');addJobCalendar(store,'job:1',{version:preview.version,stageIds:['candidate:1'],follow:false});
    const config={masterKey:'c'.repeat(64),origin:'https://example.invalid'} as Config;
    updateSubscription(store,config,{action:'enable',version:0});const token=subscriptionLink(store,config).url.split('/').at(-1)!.slice(0,-4);
    const first=calendarFeed(store,config,token).body.replace(/\r\n /g,'');
    expect(first).toContain('SUMMARY:湖北省2027年选调生招录公告 · 报名截止');expect(first).not.toContain('岗位 1');
    addJobCalendar(store,'job:2',{version:preview.version,stageIds:['candidate:1']});const second=calendarFeed(store,config,token).body.replace(/\r\n /g,'');
    expect(second.match(/UID:(.+)/g)).toEqual(first.match(/UID:(.+)/g));expect(second.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });
});
