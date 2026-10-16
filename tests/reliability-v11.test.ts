import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { mkdirSync,mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes,randomUUID } from 'node:crypto';
import { Store } from '../backend/db.ts';
import { saveAI,type Config } from '../backend/config.ts';
import { analyze,callAI,parseAnalysis } from '../backend/ai.ts';
import { requestPublic } from '../backend/net.ts';
import { saveFile,fileTool } from '../backend/files.ts';
import { detail,persistNotice } from '../backend/crawler.ts';
import { documentLinks,isAttachmentLink } from '../backend/attachment-links.ts';
import { queueTurn,runTurn } from '../backend/agent.ts';
import { runWorkerTick } from '../backend/worker.ts';
import { todayCN } from '../backend/model.ts';
import { beginUsage,finishUsage,usageSummary } from '../backend/usage.ts';
import { matchJob } from '../backend/matching.ts';
import { majorHierarchy } from '../shared/majors.ts';
import { catalogExcerpt,isMajorCatalog } from '../backend/major-catalog.ts';
import { prefilterRow } from '../backend/job-tables.ts';
import { normalizeAnalysisEvidence } from '../backend/analysis-output.ts';

vi.mock('../backend/net.ts',async original=>({...await original<typeof import('../backend/net.ts')>(),requestPublic:vi.fn()}));
vi.mock('../backend/files.ts',()=>({saveFile:vi.fn(),fileTool:vi.fn()}));
let store:Store,config:Config;
beforeEach(()=>{
  mkdirSync('.check/v11/tests',{recursive:true});const dataDir=mkdtempSync(resolve('.check/v11/tests/case-'));
  store=new Store(dataDir);config={dataDir,origin:'http://127.0.0.1:8788',host:'127.0.0.1',port:8788,adminUsername:'test',passwordHash:'unused',masterKey:randomBytes(32).toString('hex'),python:'unused',distDir:resolve('dist')};
  for(const key of ['last-auto-crawl','last-auto-follow','last-auto-backup'])store.setSetting(key,todayCN());
  saveAI(store,{baseUrl:'https://example.invalid/v1',model:'fixture',key:'fixture-not-a-secret',dailyLimit:100},config);
  vi.mocked(requestPublic).mockReset();vi.mocked(saveFile).mockReset();vi.mocked(fileTool).mockReset();
  vi.mocked(saveFile).mockImplementation(async (_s,_c,_id,url,name,raw)=>({id:'original',name,url,mime:'text/html',text:raw?.toString().replace(/<[^>]*>/g,'')||'',error:'',links:[]}));
});
afterEach(()=>store.db.close());
const base={relevant:true,type:'事业单位',summary:'公告摘要',dates:[],jobs:[],commonEligibility:[],commonCoverage:'complete',applicationItems:[],applicationCoverage:'complete'};
const response=(value:unknown)=>({status:200,headers:{},url:'',body:Buffer.from(JSON.stringify({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}))});
const seed=(body='土壤调查岗，招硕士土壤学专业。')=>store.put('ann','announcement',{title:'公告',body,url:'https://example.edu.cn/notice',published:'2026-09-21',contentHash:'one',fileIds:[],materialErrors:[],candidates:[]});

describe('analysis output and bounded correction',()=>{
  it('converts a real 24:00 deadline without rejecting other extracted requirements',()=>{
    const evidence='报名截止时间为2026年10月31日24:00。';
    const result=parseAnalysis(JSON.stringify({...base,dates:[{label:'报名截止',date:'2026-10-31',time:'24:00',evidence,inferredYear:false}]}));
    expect(result.dates[0]).toMatchObject({date:'2026-11-01',time:'00:00',evidence});
    expect(parseAnalysis(JSON.stringify({...base,dates:[{label:'截止',date:'2026-12-31',time:'24:00'}]})).dates[0].date).toBe('2027-01-01');
  });
  it('does not guess invalid dates, midnight minutes, missing required fields or job conditions',()=>{
    for(const [date,time] of [['2026-02-30','24:00'],['2026-10-31','24:01']])expect(()=>parseAnalysis(JSON.stringify({...base,dates:[{label:'截止',date,time}]}))).toThrow();
    expect(()=>parseAnalysis('{"jobs":[]}')).toThrow();
    expect(()=>parseAnalysis(JSON.stringify({...base,jobs:[{title:'岗位',match:'符合'}]}))).toThrow();
  });
  it('normalizes explicit degree wording without changing profession categories or guessing ambiguous graduate levels',()=>{
    const job={title:'岗位',match:'待核对',reasons:'原文核对',evidence:'硕士研究生及以上农学类',majorRequirements:[{levels:['硕士研究生及以上'],names:['农学类'],evidence:'硕士研究生及以上农学类'}]};
    const result=parseAnalysis(JSON.stringify({...base,jobs:[job]}));expect(result.jobs[0].majorRequirements[0]).toMatchObject({levels:['硕士','博士'],names:['农学类']});
    expect(()=>parseAnalysis(JSON.stringify({...base,jobs:[{...job,majorRequirements:[{...job.majorRequirements[0],levels:['研究生']}]}]}))).toThrow();
  });
  it('accepts a citation-prefixed verbatim quote but never repairs a fabricated or neighboring-row condition',()=>{
    const value={evidence:'[岗位表第4行] 【专业要求】土壤学',other:{evidence:'[岗位表第5行] 【政治面貌】中共党员'}};
    normalizeAnalysisEvidence(value,'[岗位表 第4行] 【岗位】A | 【专业要求】土壤学 | 【政治面貌】不限');
    expect(value.evidence).toBe('【专业要求】土壤学');expect(value.other.evidence).toBe('[岗位表第5行] 【政治面貌】中共党员');
  });
  it('corrects schema fields without splitting or repeating already successful segments',async()=>{
    const a=seed('原文'.repeat(4000));
    vi.mocked(requestPublic).mockResolvedValueOnce(response(base)).mockResolvedValueOnce(response({...base,type:'bad-enum'})).mockResolvedValue(response(base));
    expect(await analyze(store,config,a.id,1)).toBe(false);
    expect(await analyze(store,config,a.id,1)).toBe(false);
    const work=store.getSetting<any>('analysis:'+a.id,{});expect(work.index).toBe(1);expect(work.segments).toHaveLength(2);expect(work.segments[1].repairHint).toContain('type');
    expect(await analyze(store,config,a.id,1)).toBe(true);
    const requests=vi.mocked(requestPublic).mock.calls.map(([,o])=>JSON.parse(o!.body!));expect(requests[2].messages[0].content).toContain('上一次结果未通过字段校验');
    expect(store.db.prepare('SELECT outcome FROM ai_requests ORDER BY rowid').all()).toEqual([{outcome:'success'},{outcome:'error'},{outcome:'success'}]);
    expect(usageSummary(store).periods.today).toMatchObject({calls:3,total:90,failed:1});
  });
});

describe('attachments are optional and explicit',()=>{
  it('ignores recruitment/navigation links and decoration while retaining real attachment formats',()=>{
    const links=documentLinks('<a href="/job">岗位详情</a><a href="/apply">报名入口</a><a href="/news">招聘通知</a><img src="/logo.png"><a href="/positions.xlsm">岗位表</a><a href="/download?id=1">附件1</a>','https://example.edu.cn/');
    expect(links.filter(isAttachmentLink).map(l=>l.name)).toEqual(['岗位表','附件1']);
    expect(isAttachmentLink({url:'https://example.edu.cn/a.xlsx',name:'表格'})).toBe(true);
    expect(isAttachmentLink({url:'https://example.edu.cn/1.png',name:'扫码报名'})).toBe(false);
    expect(isAttachmentLink({url:'https://example.edu.cn/poster.png',name:'岗位要求',image:true})).toBe(true);
  });
  it('collects and analyzes a body-only posting without downloading attachments or running file tools',async()=>{
    const body='土壤调查岗，招硕士土壤学专业；报名须提交个人简历。';
    await persistNotice(store,config,{id:'ann',title:'调查岗',html:'<p>'+body+'</p><a href="/apply">报名入口</a><img src="/logo.png">',origin:'https://example.edu.cn/a',external:'',published:'2026-09-21',range:{startDate:'2026-09-01',endDate:''},sourceName:'学校',sourceId:'cau'});
    expect(saveFile).toHaveBeenCalledTimes(1);expect(vi.mocked(saveFile).mock.calls[0][5]).toBeInstanceOf(Buffer);expect(requestPublic).not.toHaveBeenCalled();
    expect(store.get('ann')).toMatchObject({attachmentCount:0,materialsComplete:true});
    store.put('profile','profile',{education:[{level:'硕士',major:'土壤学',code:'090301'}]});
    const material={kind:'material',label:'个人简历',evidence:'报名须提交个人简历'};
    vi.mocked(requestPublic).mockResolvedValue(response({...base,applicationItems:[material],jobs:[{title:'土壤调查岗',organization:'学校',profileId:'profile',match:'符合',reasons:'原文条件满足',evidence:body,majorRequirements:[{levels:['硕士'],names:['土壤学'],evidence:'招硕士土壤学专业'}],eligibilityCoverage:'complete',applicationCoverage:'complete'}]}));
    expect(await analyze(store,config,'ann',1,'recruitment')).toBe(true);expect(fileTool).not.toHaveBeenCalled();expect(saveFile).toHaveBeenCalledTimes(1);
    expect(store.get('ann')).toMatchObject({analysisVersion:6,analysisStatus:'done'});
    expect(store.list('job')[0]).toMatchObject({match:'符合',applicationItems:[{label:'个人简历'}]});
    expect(store.list('exam')).toHaveLength(0);expect(usageSummary(store).recent[0]).toMatchObject({purpose:'recruitment'});
  });
  it('keeps a real broken attachment incomplete instead of treating it as absent',async()=>{
    vi.mocked(saveFile).mockImplementation(async (_s,_c,_id,url,name,raw)=>{if(!raw)throw new Error('unavailable');return {id:'original',name,url,mime:'text/html',text:'正文',error:'',links:[]};});
    await persistNotice(store,config,{id:'ann',title:'公告',html:'<p>正文</p><a href="/positions.xlsx">岗位表</a>',origin:'https://example.edu.cn/a',external:'',published:'2026-09-21',range:{startDate:'2026-09-01',endDate:''},sourceName:'学校'});
    expect(store.get('ann').materialsComplete).toBe(false);expect(store.get('ann').materialErrors[0]).toContain('岗位表');expect(saveFile).toHaveBeenCalledTimes(2);
  });
});

describe('withdrawn school postings',()=>{
  const item={id:'withdrawn',title:'源站已撤回的公告',createDate:'2026-09-21'};
  it('finishes the crawl and records the source reason rather than retrying a known withdrawal three times',async()=>{
    store.setSetting('source-status',{run:'test',running:true});
    store.enqueue('detail:test','detail',{run:'test',item,recruit:true,sourceId:'cau'});
    vi.mocked(requestPublic).mockResolvedValue({status:200,headers:{},url:'',body:Buffer.from(JSON.stringify({state:0,msg:'招聘信息不存在或审核不通过'}))});
    await runWorkerTick(store,config);
    expect(store.db.prepare('SELECT state,attempts FROM jobs WHERE id=?').get('detail:test')).toEqual({state:'done',attempts:0});
    expect(store.getSetting<any>('source-status',{})).toMatchObject({running:false,error:'',unavailable:[{id:'cau:withdrawn'}]});
    await detail(store,config,{item,recruit:true,sourceId:'cau'});expect(requestPublic).toHaveBeenCalledTimes(1);expect(store.list('announcement')).toHaveLength(0);
    store.setSetting('source-unavailable:cau:withdrawn',{listingHash:'changed',retryAfter:Date.now()+86400000});
    await detail(store,config,{item,recruit:true});expect(requestPublic).toHaveBeenCalledTimes(2);
  });
  it('does not hide genuine upstream failures as withdrawal',async()=>{
    vi.mocked(requestPublic).mockResolvedValue({status:200,headers:{},url:'',body:Buffer.from(JSON.stringify({state:0,msg:'系统繁忙'}))});
    await expect(detail(store,config,{item,recruit:true})).rejects.toMatchObject({status:502});
    expect(store.getSetting('source-unavailable:cau:withdrawn',null)).toBeNull();
  });
});

describe('usage follows the actual completed action',()=>{
  it('classifies recruitment and calendar turns separately with exactly one counted request per turn',async()=>{
    vi.mocked(requestPublic).mockResolvedValueOnce(response({intent:'recruitment_search',query:'',terms:[]})).mockResolvedValueOnce(response({intent:'calendar_list',query:''}));
    for(const text of ['查看已保存岗位','查看日历']){queueTurn(store,{id:randomUUID(),text});await runWorkerTick(store,config);}
    expect(usageSummary(store).recent.map((r:any)=>r.purpose).sort()).toEqual(['calendar','recruitment']);expect(usageSummary(store).periods.today.calls).toBe(2);
  });
  it('leaves a failed planning call unclassified and counts measured usage',async()=>{
    vi.mocked(requestPublic).mockResolvedValue(response({intent:'invalid'}));const t=queueTurn(store,{id:randomUUID(),text:'查询'});
    await expect(runTurn(store,config,t.id)).rejects.toThrow();expect(usageSummary(store).recent[0]).toMatchObject({purpose:'agent',outcome:'error',total_tokens:30});
  });
  it('uses the selected time period for purpose totals',()=>{
    const r=beginUsage(store,'fixture','recruitment',100);finishUsage(store,r,'success',{input:20,output:10,total:30,complete:true});
    store.db.prepare("INSERT INTO ai_requests(id,day,model,purpose,started_at,outcome,total_tokens) VALUES('old','2020-01-01','fixture','calendar','2020-01-01T00:00:00Z','success',10)").run();
    const s=usageSummary(store);expect(s.purposePeriods.today).toEqual([{purpose:'recruitment',calls:1,total:30}]);expect(s.purposePeriods.all).toHaveLength(2);
  });
});

describe('notice-specific catalogues are Agent evidence, not new global classifications',()=>{
  const profile={id:'profile',education:[{level:'硕士',major:'土壤学',code:'090301'},{level:'本科',major:'土地资源管理',code:'120404'}]};
  const requirement='本岗位招硕士，植物保护与农业资源利用类。';
  const catalog='[目录 第 713 行] 研究生 土壤学 植物保护与农业资源利用类 | 本科 野生动物保护 自然保护类';
  const job={majorRequirements:[{levels:['硕士'],names:['植物保护与农业资源利用类'],evidence:requirement,catalog:'本公告专业目录'}],eligibilityRequirements:[],eligibilityCoverage:'complete',analysisIncomplete:false,catalogContext:true,catalogChecks:[{level:'硕士',major:'土壤学',decision:'matched',requirementEvidence:requirement,catalogEvidence:catalog,reason:'本公告目录将该硕士专业列在岗位要求类别中'}]};
  it('uses the Agent conclusion only for this job, with both quotes verified',()=>{
    const before=majorHierarchy(profile.education[0]);
    expect(matchJob(job,[profile],requirement+'\n'+catalog)).toMatchObject({match:'符合',matchedLevel:'硕士',majorStatus:'matched'});
    expect(matchJob({...job,catalogChecks:[]},[profile],requirement+'\n'+catalog).match).toBe('待核对');
    expect(matchJob(job,[profile],requirement).match).toBe('待核对');
    expect(matchJob({...job,catalogChecks:[{...job.catalogChecks[0],level:'本科'}]},[profile],requirement+'\n'+catalog).match).toBe('待核对');
    expect(majorHierarchy(profile.education[0])).toEqual(before);expect(before.category).toBe('农业资源与环境');
  });
  it('does not pre-exclude special catalogue categories before the Agent reads them',()=>{
    const fields=[{column:1,header:'专业要求',value:'植物保护与农业资源利用类'}];
    expect(prefilterRow(fields,[profile],true)).toBe('review');expect(prefilterRow(fields,[profile])).toBe('excluded');
  });
  it('retains real reference headers and rows without manufacturing global aliases or positions',()=>{
    const table={sheet:'专业目录',headers:[],rows:[],notes:[[1,['本公告专业目录']],[2,['研究生专业','本科专业']],[3,['土壤学','土地资源管理']]] as [number,string[]][]};
    expect(isMajorCatalog('专业目录.xlsx',table)).toBe(true);const text=catalogExcerpt({name:'专业目录.xlsx'},table,[profile]);
    expect(text).toContain('研究生专业');expect(text).toContain('第 3 行');expect(text).toContain('土壤学');
  });
});
