import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../backend/db.ts';
import {saveAI,type Config} from '../backend/config.ts';
import {requestPublic} from '../backend/net.ts';
import {saveFile,fileTool} from '../backend/files.ts';
import {detail} from '../backend/crawler.ts';
import {cauRecruitmentContent,webPositionSegments} from '../backend/cau-recruitment.ts';
import {analyze,parseAnalysis} from '../backend/ai.ts';
import {queueStatus} from '../backend/queue-status.ts';
import {announcementTitle,announcementIntroduction,cleanIntroduction,mergeIntroduction,reviewNotes} from '../shared/announcement-presentation.ts';
import {formatDateTime} from '../shared/datetime.ts';
import {eligibilityFactsSchema} from '../shared/eligibility.ts';
import {htmlText} from '../backend/school-crawler.ts';

vi.mock('../backend/net.ts',async original=>({...await original<typeof import('../backend/net.ts')>(),requestPublic:vi.fn()}));
vi.mock('../backend/files.ts',()=>({saveFile:vi.fn(),fileTool:vi.fn()}));
const fixture=JSON.parse(readFileSync(new URL('./fixtures/cau-positions-v12.json',import.meta.url),'utf8'));
const profile={id:'profile',title:'求职条件',education:[{level:'本科',major:'土地资源管理',code:'120404'},{level:'硕士',major:'土壤学',code:'090301'}],includeUnrestricted:true,eligibility:eligibilityFactsSchema.parse({freshGraduate:'yes',freshGraduateYear:'2027'})};
const base={relevant:true,type:'企业招聘',summary:'招聘介绍',dates:[],jobs:[],commonEligibility:[],commonCoverage:'complete',applicationItems:[],applicationCoverage:'complete'};
const response=(value:unknown)=>({status:200,headers:{},url:'',body:Buffer.from(JSON.stringify(value))});
const aiResponse=(value:unknown)=>response({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10}});
let store:Store,config:Config;
beforeEach(()=>{
  mkdirSync('.check/v12/tests',{recursive:true});const dataDir=mkdtempSync(resolve('.check/v12/tests/case-'));
  store=new Store(dataDir);config={dataDir,origin:'http://127.0.0.1:8788',host:'127.0.0.1',port:8788,adminUsername:'fixture',passwordHash:'unused',masterKey:randomBytes(32).toString('hex'),python:'unused',distDir:resolve('dist')};
  saveAI(store,{baseUrl:'https://example.invalid/v1',model:'fixture',key:'fixture-only',dailyLimit:100},config);store.put(profile.id,'profile',profile);
  vi.mocked(requestPublic).mockReset();vi.mocked(saveFile).mockReset();vi.mocked(fileTool).mockReset();
  vi.mocked(saveFile).mockImplementation(async(_s,_c,_id,url,name,raw)=>({id:'source-html',name,url,mime:'text/html',text:htmlText(raw?.toString()||''),error:'',links:[]}));
});
afterEach(()=>store.db.close());
function seed(){const source=cauRecruitmentContent(fixture);return store.put('ann','announcement',{title:fixture.title,body:htmlText(source.html),sourcePositions:source.positions,sourceFileIds:['source-html'],url:'https://example.edu.cn/notice',published:'2026-09-22',contentHash:'web-positions-v12',fileIds:[],materialErrors:[],candidates:[]});}
function model(omitFirst=false){
  vi.mocked(requestPublic).mockImplementation(async(_url,options:any)=>{
    const text=JSON.parse(options.body).messages[1].content as string;
    const rows=webPositionSegments(store.get('ann'),[profile]).segments.flatMap(s=>s.rows||[]).filter(r=>text.includes(r.rowId));
    if(rows.length)return aiResponse({...base,jobs:rows.slice(omitFirst?1:0).map(row=>({title:'错误岗位名称',organization:'错误单位',sourceRowId:row.rowId,profileId:'profile',match:'符合',reasons:'岗位要求：本科、硕士；条件核查：专业不限。',evidence:row.text,majorRequirements:[{levels:['本科','硕士'],names:[],unrestricted:true,evidence:row.text}],eligibilityRequirements:[],eligibilityCoverage:'complete',applicationItems:[],applicationCoverage:'complete'}))});
    // A hallucinated duplicate from the general body must not replace the source rows.
    return aiResponse({...base,summary:'正文明确面向2027届毕业生。用户是否符合需核对。',introduction:{year:{text:'2027',evidence:fixture.title}},jobs:[{title:'业务方向',organization:'新城控股',match:'待核对',reasons:'',evidence:'业务方向'}]});
  });
}
describe('complete website position collection',()=>{
  it('keeps all 11 source jobs with education, major, quantity, location and full preferences',()=>{
    const result=cauRecruitmentContent(fixture);expect(result.positions).toHaveLength(11);expect(result.errors).toEqual([]);
    const law=result.positions.find(p=>p.title==='法务')!;
    expect(law).toMatchObject({education:'本科,硕士',major:'不限专业',count:'10',location:'上海市'});
    expect(law.description).toContain('优先');expect(result.html).toContain('【学历】本科,硕士');expect(result.html).toContain('【岗位描述与任职要求】');
  });
  it('persists the source API position list and does not invent or download absent attachments',async()=>{
    vi.mocked(requestPublic).mockResolvedValue(response({state:1,object:{recruitmentinfo:fixture}}));
    await detail(store,config,{item:{id:'notice',title:fixture.title,startTime:'2026-09-22'},recruit:true,range:{startDate:'2026-09-01',endDate:''}});
    const item=store.get('cau:notice');expect(item.sourcePositions).toHaveLength(11);expect(item.body).toContain('【岗位名称】法务');
    expect(item.body).toContain('【专业】不限专业');expect(item.attachmentCount).toBe(0);expect(item.candidates).toEqual([]);
    expect(saveFile).toHaveBeenCalledTimes(1);expect(fileTool).not.toHaveBeenCalled();
  });
  it('detects missing source rows and escapes markup in position fields',()=>{
    const result=cauRecruitmentContent({...fixture,positionNum:12,recruitmentPositionList:[...fixture.recruitmentPositionList.slice(1),{id:'last',positionName:'<b>开发</b>',positionDescription:'<script>steal()</script>本科要求'}]});
    expect(result.errors.join()).toContain('12 个岗位');expect(result.positions.at(-1)?.title).toBe('开发');expect(result.positions.at(-1)?.description).not.toContain('steal');
  });
  it('uses stable source identities and keeps descriptions for semantic eligibility checks',()=>{
    seed();const result=webPositionSegments(store.get('ann'),[profile]),rows=result.segments.flatMap(s=>s.rows||[]);
    expect(rows).toHaveLength(11);expect(new Set(rows.map(r=>r.rowId)).size).toBe(11);expect(rows.every(r=>r.positionCode==='')).toBe(true);
    expect(rows.map(r=>r.rowId)).toEqual(webPositionSegments(store.get('ann'),[profile]).segments.flatMap(s=>s.rows||[]).map(r=>r.rowId));
    expect(result.segments.every(s=>(s.rows?.length||0)<=3)).toBe(true);
  });
  it('analyzes all source jobs once, keeps their actual facts, and resumes without duplicate calls',async()=>{
    seed();model();expect(await analyze(store,config,'ann',1)).toBe(false);expect(store.getSetting<any>('analysis:ann',{}).index).toBe(1);
    while(await analyze(store,config,'ann',1)===false){}
    const jobs=store.list('job'),law=jobs.find(j=>j.title==='法务');expect(jobs).toHaveLength(11);
    expect(law.sourcePosition).toMatchObject({education:'本科,硕士',major:'不限专业',location:'上海市'});expect(law.sourcePosition.description).toContain('优先');
    expect(jobs.map(j=>j.title).sort()).toEqual(cauRecruitmentContent(fixture).positions.map(p=>p.title).sort());expect(law.positionCode).toBe('');
    expect(store.get('ann').displayTitle).toBe('新城控股2027年度校园招聘');expect(store.get('ann').candidates).toEqual([]);
    expect(fileTool).not.toHaveBeenCalled();const count=vi.mocked(requestPublic).mock.calls.length;await analyze(store,config,'ann');expect(requestPublic).toHaveBeenCalledTimes(count);
  });
  it('retains omitted AI rows with their original requirements and an unresolved result',async()=>{
    seed();model(true);while(await analyze(store,config,'ann')===false){}const jobs=store.list('job');expect(jobs).toHaveLength(11);
    const law=jobs.find(j=>j.title==='法务');expect(law.match).toBe('待核对');expect(law.sourcePosition.major).toBe('不限专业');
  });
  it('never presents model-invented webpage fields as collected source facts',async()=>{
    store.put('ann','announcement',{title:'调查招聘',body:'调查岗，本科、硕士均可，专业不限。',url:'https://example.edu.cn/notice',contentHash:'plain',fileIds:[],materialErrors:[]});
    vi.mocked(requestPublic).mockResolvedValue(aiResponse({...base,jobs:[{title:'调查岗',organization:'示例单位',match:'待核对',reasons:'条件待核对',evidence:'调查岗，本科、硕士均可，专业不限',sourcePosition:{education:'博士',major:'臆造专业',count:'100',location:'外地',description:'未经原文支持'}}]}));
    await analyze(store,config,'ann');expect(store.list('job')).toHaveLength(1);expect(store.list('job')[0].sourcePosition).toBeUndefined();
  });
});
describe('introduction and title presentation',()=>{
  it('simplifies recruitment titles without modifying selection-exam titles or guessing a year',()=>{
    expect(announcementTitle({title:fixture.title,introduction:{organization:fixture.corporationName,year:'2027'}})).toBe('新城控股2027年度校园招聘');
    const title='甘肃省2027年选调应届优秀大学毕业生公告';expect(announcementTitle({title,type:'选调',displayTitle:'错误简写'})).toBe(title);
    expect(announcementTitle({title:'某企业校园招聘',published:'2026-09-22'})).toBe('某企业校园招聘');
    expect(announcementTitle({title:'以竞技精神，搏卓越未来',summary:'竞技世界（北京）网络技术有限公司2027届校园招聘。'})).toBe('竞技世界（北京）网络技术有限公司2027年度校园招聘');
  });
  it('accepts only quoted facts and places profile checks outside the factual introduction',()=>{
    const source='甲企业2027年度校园招聘，面向2027届毕业生，硕士，土壤学，调查岗，北京。';
    const fact=(text:string)=>({text,evidence:source});
    const intro=mergeIntroduction([{_source:source,introduction:{organization:fact('甲企业'),year:fact('2027'),audience:fact('2027届毕业生'),education:fact('硕士'),majors:fact('土壤学'),positions:fact('调查岗'),locations:fact('北京'),application:fact('明天截止')}}]);
    expect(intro.application).toBeUndefined();expect(intro.majors).toBe('土壤学');
    const text=announcementIntroduction({title:'甲企业2027年度校园招聘',introduction:intro});expect(text).toContain('面向2027届毕业生；学历要求：硕士；专业要求：土壤学');expect(text).not.toContain('正文');
    expect(mergeIntroduction([{_source:source,introduction:{year:fact('2027届毕业生')}}]).year).toBeUndefined();
  });
  it('keeps old results readable without another model request',()=>{
    expect(cleanIntroduction('正文明确面向2027届毕业生。用户是否符合需核对。本部分未提供岗位表。')).toBe('面向2027届毕业生。');
    expect(reviewNotes(['报考规则为unknown','正文或附件分段分析，请结合完整岗位条款复核','报考规则为unknown'])).toEqual(['报考规则尚待确认']);
    expect(parseAnalysis(JSON.stringify(base)).introduction).toEqual({});expect(requestPublic).not.toHaveBeenCalled();
  });
});
describe('background detail and dates',()=>{
  it('shows the actual announcement, saved progress, current sheet and retry state without raw payloads',()=>{
    seed();store.enqueue('job','analyze',{id:'ann',secret:'not-for-display'});store.db.prepare("UPDATE jobs SET state='running' WHERE id='job'").run();
    const segments=[{text:'正文'},...webPositionSegments(store.get('ann'),[profile]).segments];store.setSetting('analysis:ann',{index:1,segments});
    let status=queueStatus(store)[0];expect(status).toMatchObject({title:fixture.title,stateLabel:'正在处理',phase:'分析岗位要求',completed:1,total:segments.length,announcementId:'ann'});expect(status.partName).toContain('网页岗位');expect(JSON.stringify(status)).not.toContain('not-for-display');
    store.db.prepare("UPDATE jobs SET state='retry',available_at=?,error='接口暂时不可用' WHERE id='job'").run(Date.parse('2026-09-22T04:00:00Z'));
    status=queueStatus(store)[0];expect(status.stateLabel).toBe('等待重试');expect(status.nextAttemptAt).toBe('2026-09-22T04:00:00.000Z');
  });
  it('identifies collection and attachment jobs before an announcement exists',()=>{
    store.enqueue('detail','detail',{item:{title:'新公告'},sourceName:'示例大学就业网'});store.enqueue('crawl','crawl',{sourceName:'示例大学就业网',page:3});
    expect(queueStatus(store).find(j=>j.id==='detail')).toMatchObject({title:'新公告',phase:'读取公告及岗位明细'});
    expect(queueStatus(store).find(j=>j.id==='crawl')?.phase).toContain('第 3 页');
  });
  it('uses one explicit date-time format, including midnight and year rollover',()=>{
    expect(formatDateTime('2026-12-31T16:00:00Z')).toBe('2027-01-01 00:00:00');expect(formatDateTime('2024-02-29T02:03:04Z')).toBe('2024-02-29 10:03:04');expect(formatDateTime('invalid')).toBe('时间待核对');
  });
});
