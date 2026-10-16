import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../backend/db.ts';
import {hash,saveAI,type Config} from '../backend/config.ts';
import {analyze,callAI,parseAnalysis,AIOutputError} from '../backend/ai.ts';
import {requestPublic} from '../backend/net.ts';
import {analysisRecovery} from '../backend/analysis-recovery.ts';
import {announcementReport} from '../backend/announcement-report.ts';
import {announcementScreenView} from '../backend/recruitment-reader.ts';
import {announcementAnalysisLabel,announcementAnalysisNotice} from '../shared/announcement-metadata.ts';
import {runWorkerTick} from '../backend/worker.ts';
import {todayCN} from '../backend/model.ts';
import {queueStatus} from '../backend/queue-status.ts';

vi.mock('../backend/net.ts',async original=>({...await original<typeof import('../backend/net.ts')>(),requestPublic:vi.fn()}));
let store:Store,config:Config;
const base={relevant:true,type:'选调',summary:'公开选调公告',commonEligibility:[],commonCoverage:'complete',applicationItems:[],applicationCoverage:'complete',dates:[],jobs:[]};
const reply=(value:any,finish_reason='stop')=>({status:200,headers:{},url:'https://api.example/v1/chat/completions',body:Buffer.from(JSON.stringify({choices:[{message:{content:typeof value==='string'?value:JSON.stringify(value)},finish_reason}],usage:{prompt_tokens:20,completion_tokens:10}}))});
beforeEach(()=>{
  mkdirSync('.check/tests/resilience-v14-16',{recursive:true});
  const dataDir=mkdtempSync(resolve('.check/tests/resilience-v14-16/case-'));
  store=new Store(dataDir);config={dataDir,origin:'http://127.0.0.1:8788',host:'127.0.0.1',port:8788,adminUsername:'fixture',passwordHash:'unused',masterKey:randomBytes(32).toString('hex'),python:process.env.JINDU_TEST_PYTHON||'python',distDir:resolve('dist')};
  saveAI(store,{baseUrl:'https://api.example/v1',model:'fixture',key:'not-a-real-key',dailyLimit:1000},config);
  for(const key of ['last-auto-crawl','last-auto-follow','last-auto-backup'])store.setSetting(key,todayCN());
  vi.mocked(requestPublic).mockReset();
});
afterEach(()=>store.db.close());
async function plan(texts:string[]){
  const body=texts.join('\n');const a=store.put('ann','announcement',{title:'测试选调',url:'https://source.example/a',body,contentHash:hash(body),materialsComplete:true,candidates:[],analysisStatus:'pending',status:'pending'});
  await analyze(store,config,a.id,0);
  const work=store.getSetting<any>('analysis:ann',{});work.segments=texts.map(text=>({text,partName:text,depth:0,imageId:''}));store.setSetting('analysis:ann',work);
  return a;
}
const input=(options:any)=>JSON.parse(options.body).messages[1].content as string;
async function drain(limit=40){for(let n=0;n<limit;n++)if(await analyze(store,config,'ann',1))return;throw new Error('analysis did not finish within bounded test calls');}

describe('compatible model responses without guessing facts',()=>{
  it.each([
    ['fenced','```json\n'+JSON.stringify(base)+'\n```'],
    ['explanation','分析结果如下：\n'+JSON.stringify(base)+'\n以上为分析结果。'],
    ['BOM','\uFEFF'+JSON.stringify(base)],
    ['encoded',JSON.stringify(JSON.stringify(base))],
    ['quoted braces',JSON.stringify({...base,summary:'说明含有 {括号}、"引号" 与 \\ 转义'})],
  ])('accepts an unambiguous %s response',(_label,text)=>expect(parseAnalysis(text).type).toBe('选调'));
  it.each(['{} {}','['+JSON.stringify(base)+']',JSON.stringify(base)+'\n{"another":true}','{"relevant":true,','null','{"summary":"unclosed { string}'])('rejects incomplete or ambiguous output: %s',text=>expect(()=>parseAnalysis(text)).toThrow(AIOutputError));
  it.each(['2026年10月5日','2026/10/5','2026.10.5',' 2026-10-5 '])('normalizes explicit full dates in all sections: %s',date=>{
    const result=parseAnalysis(JSON.stringify({...base,dates:[{label:'报名',date,time:'9：00',evidence:'原文日期'}],commonEligibility:[{label:'政治条件',mode:'all',evidence:'党员取得时间',criteria:[{kind:'political',label:'党员',evidence:'党员取得时间',asOf:date}]}],applicationItems:[{kind:'material',label:'报名表',evidence:'提交报名表',deadline:date}]}));
    expect(result.dates[0]).toMatchObject({date:'2026-10-05',time:'09:00'});expect(result.commonEligibility[0].criteria[0].asOf).toBe('2026-10-05');expect(result.applicationItems[0].deadline).toBe('2026-10-05');
  });
  it.each(['2026-02-30','2026年13月1日','报名截止前','10月5日','2026-10-05T00:00:00Z'])('does not erase or invent an invalid/ambiguous qualification date: %s',asOf=>{
    expect(()=>parseAnalysis(JSON.stringify({...base,commonEligibility:[{label:'政治条件',mode:'all',evidence:'原文条件',criteria:[{kind:'political',label:'党员',evidence:'原文条件',asOf}]}]}))).toThrow(AIOutputError);
  });
  it('accepts text-block responses while recording exactly one request and its usage',async()=>{
    const json=JSON.stringify(base),r=reply(base),data=JSON.parse(r.body.toString());data.choices[0].message.content=[{type:'text',text:json.slice(0,20)},{type:'text',text:json.slice(20)}];r.body=Buffer.from(JSON.stringify(data));
    vi.mocked(requestPublic).mockResolvedValue(r);expect(parseAnalysis(await callAI(store,config,[],6000,120000,'announcement',{parse:parseAnalysis})).type).toBe('选调');
    expect(store.db.prepare('SELECT outcome,total_tokens FROM ai_requests').get()).toMatchObject({outcome:'success',total_tokens:30});expect(requestPublic).toHaveBeenCalledTimes(1);
  });
  it('does not turn unknown content blocks or a length-limited prefix into valid analysis',async()=>{
    const r=reply(base),data=JSON.parse(r.body.toString());data.choices[0].message.content=[{type:'refusal',text:JSON.stringify(base)}];r.body=Buffer.from(JSON.stringify(data));
    vi.mocked(requestPublic).mockResolvedValueOnce(r).mockResolvedValueOnce(reply(base,'length'));
    await expect(callAI(store,config,[])).rejects.toMatchObject({code:'empty'});await expect(callAI(store,config,[])).rejects.toMatchObject({code:'truncated'});
  });
  it.each([null,{},[],{choices:null}])('classifies an invalid HTTP 200 response envelope without a runtime exception',async value=>{
    vi.mocked(requestPublic).mockResolvedValue({status:200,headers:{},url:'',body:Buffer.from(JSON.stringify(value))});
    await expect(callAI(store,config,[])).rejects.toBeInstanceOf(AIOutputError);
    expect(store.db.prepare('SELECT outcome FROM ai_requests').get()).toMatchObject({outcome:'error'});
  });
});

describe('independent segment recovery and bounded partial completion',()=>{
  it('survives more than four recoverable errors in separate parts without rerunning successes',async()=>{
    await plan(['A','B','C','D','E','F']);const attempts=new Map<string,number>();
    vi.mocked(requestPublic).mockImplementation(async(_url,opts)=>{const part=input(opts).match(/仅依据本部分：\n([^\n]+)/)![1];const n=(attempts.get(part)||0)+1;attempts.set(part,n);return reply(n===1?'not JSON':base);});
    await drain();expect([...attempts.values()]).toEqual([2,2,2,2,2,2]);expect(store.get('ann').analysisStatus).toBe('done');expect(analysisRecovery(store.getSetting('analysis:ann',{}))).toMatchObject({saved:6,pending:0,total:6});
  });
  it('isolates a bad middle part, continues the rest, and retries only that part after reopening',async()=>{
    await plan(['GOOD_FIRST','BAD_MIDDLE','GOOD_LAST']);
    const exam=store.put('exam:keep','exam',{title:'已归档的日历',announcementId:'ann',archived:true,tracking:{enabled:false},stages:[{id:'keep',date:'2026-10-15',label:'人工节点'}]});
    vi.mocked(requestPublic).mockImplementation(async(_url,opts)=>reply(input(opts).includes('仅依据本部分：\nBAD_MIDDLE\n')?'bad output':base));
    await drain();expect(requestPublic).toHaveBeenCalledTimes(7);expect(store.get('ann')).toMatchObject({analysisStatus:'partial',analysisPendingParts:1});
    const oldResults=store.getSetting<any>('analysis:ann',{}).results;
    const detail=announcementScreenView(announcementReport(store,store.get('ann')));expect(detail.analysisRecovery).toMatchObject({saved:2,pending:1,parts:[{part:2,name:'BAD_MIDDLE',code:'format'}]});
    store.db.close();store=new Store(config.dataDir);store.enqueueAnalysis('ann',true);
    expect(store.getSetting<any>('analysis:ann',{}).results).toEqual(oldResults);
    vi.mocked(requestPublic).mockClear().mockResolvedValue(reply(base));await drain();
    expect(requestPublic).toHaveBeenCalledTimes(1);expect(input(vi.mocked(requestPublic).mock.calls[0][1])).toContain('仅依据本部分：\nBAD_MIDDLE\n');
    expect(store.get('ann')).toMatchObject({analysisStatus:'done',analysisPendingParts:0,analysisError:''});expect(store.get('exam:keep')).toEqual(exam);
    expect(announcementReport(store,store.get('ann')).uncertainties.some((s:string)=>s.includes('BAD_MIDDLE'))).toBe(false);
  });
  it('keeps original rows and attention when a table result never parses, then replaces placeholders on resume',async()=>{
    await plan(['BODY','TABLE']);let work=store.getSetting<any>('analysis:ann',{});
    work.segments[1]={text:'【岗位名称】科研岗 | 【专业要求】土壤学',table:true,partName:'岗位表',depth:0,imageId:'',rows:[{rowId:'row1',fileId:'file',fileName:'岗位表.xlsx',sheet:'岗位表',row:2,positionCode:'1',title:'科研岗',organization:'研究院',text:'【岗位名称】科研岗 | 【专业要求】土壤学'}]};store.setSetting('analysis:ann',work);
    vi.mocked(requestPublic).mockImplementation(async(_url,opts)=>reply(input(opts).includes('岗位行ID：')?'bad':base));await drain();
    const job=store.list('job').find(j=>j.sourceRowId==='row1');expect(job).toMatchObject({match:'待核对',majorStatus:'unknown',sourcePosition:{major:'土壤学'}});
    store.put(job.id,'job',{...job,status:'关注',notes:'我的备注',archived:true},job.version);
    store.enqueueAnalysis('ann',true);vi.mocked(requestPublic).mockClear().mockResolvedValue(reply({...base,jobs:[{sourceRowId:'row1',title:'科研岗',match:'待核对',reasons:'已核对原表',evidence:'【专业要求】土壤学',majorRequirements:[{names:['土壤学'],evidence:'【专业要求】土壤学'}],eligibilityCoverage:'complete',applicationCoverage:'complete'}]}));await drain();
    expect(requestPublic).toHaveBeenCalledTimes(1);expect(store.list('job').filter(j=>j.sourceRowId==='row1')).toHaveLength(1);expect(store.get(job.id)).toMatchObject({status:'关注',notes:'我的备注',archived:true});
    expect(store.getSetting<any>('analysis:ann',{}).results.filter((r:any)=>r._table)).toHaveLength(1);
  });
  it('does not publish a false completed result when every part is invalid',async()=>{
    const a=await plan(['ONLY']);store.put('ann','announcement',{...a,summary:'旧的已核对结果',candidates:[{label:'旧日期',date:'2026-10-15'}]},a.version);
    vi.mocked(requestPublic).mockResolvedValue(reply('broken'));for(let i=0;i<4;i++)expect(await analyze(store,config,'ann',1)).toBe(false);
    await expect(analyze(store,config,'ann',1)).rejects.toMatchObject({code:'format'});await expect(analyze(store,config,'ann',1)).rejects.toThrow('未完成部分');
    expect(requestPublic).toHaveBeenCalledTimes(5);expect(store.get('ann')).toMatchObject({summary:'旧的已核对结果',candidates:[{label:'旧日期'}]});
    store.enqueueAnalysis('ann',true);vi.mocked(requestPublic).mockResolvedValue(reply(base));await drain();expect(requestPublic).toHaveBeenCalledTimes(6);
  });
  it('does not charge the active part for errors that occurred in old successful parts',async()=>{
    await plan(['LEGACY_DONE','CURRENT']);let w=store.getSetting<any>('analysis:ann',{});delete w.recoveryVersion;w.index=1;w.repairs=4;w.results=[{...parseAnalysis(JSON.stringify(base)),_source:'LEGACY_DONE'}];store.setSetting('analysis:ann',w);
    vi.mocked(requestPublic).mockResolvedValueOnce(reply('bad')).mockResolvedValue(reply(base));expect(await analyze(store,config,'ann',1)).toBe(false);expect(await analyze(store,config,'ann',1)).toBe(true);expect(requestPublic).toHaveBeenCalledTimes(2);
  });
  it('keeps the retry budget across restarts instead of silently starting another round',async()=>{
    await plan(['ONE']);vi.mocked(requestPublic).mockResolvedValue(reply('bad'));for(let i=0;i<4;i++)await analyze(store,config,'ann',1);
    store.db.close();store=new Store(config.dataDir);await expect(analyze(store,config,'ann',1)).rejects.toThrow();expect(requestPublic).toHaveBeenCalledTimes(5);
  });
  it('pauses a systematic output failure after three exhausted parts, preserving earlier successes',async()=>{
    await plan(['GOOD','BAD1','BAD2','BAD3','UNTOUCHED']);
    vi.mocked(requestPublic).mockImplementation(async(_url,opts)=>reply(input(opts).includes('仅依据本部分：\nGOOD\n')?base:'broken'));
    await expect(drain()).rejects.toThrow('连续 3 个部分');expect(requestPublic).toHaveBeenCalledTimes(16);
    const work=store.getSetting<any>('analysis:ann',{});expect(work).toMatchObject({index:4,stopped:true,consecutiveOutputFailures:3});expect(work.results).toHaveLength(1);
    expect(vi.mocked(requestPublic).mock.calls.some(([,opts])=>input(opts).includes('仅依据本部分：\nUNTOUCHED\n'))).toBe(false);
    store.enqueueAnalysis('ann',true);vi.mocked(requestPublic).mockClear().mockResolvedValue(reply(base));await drain();expect(requestPublic).toHaveBeenCalledTimes(4);expect(store.get('ann').analysisStatus).toBe('done');
  });
  it('invalidates unfinished checkpoints when the announcement source changes',async()=>{
    await plan(['ORIGINAL']);vi.mocked(requestPublic).mockResolvedValue(reply('bad'));await analyze(store,config,'ann',1);
    const a=store.get('ann');store.put('ann','announcement',{...a,body:'CHANGED',contentHash:hash('CHANGED')},a.version);store.enqueueAnalysis('ann',true);
    expect(store.getSetting('analysis:ann',null)).toBeNull();vi.mocked(requestPublic).mockClear().mockResolvedValue(reply(base));await drain();expect(input(vi.mocked(requestPublic).mock.calls[0][1])).toContain('CHANGED');
  });
  it('does not classify a gateway HTTP 500 with non-JSON body as a field-format problem',async()=>{
    await plan(['ONE']);vi.mocked(requestPublic).mockResolvedValue({status:500,headers:{},url:'',body:Buffer.from('<h1>Internal Server Error</h1>')});
    await expect(analyze(store,config,'ann',1)).rejects.toMatchObject({code:'unavailable',httpStatus:500});expect(store.getSetting<any>('analysis:ann',{}).segments[0].outputRepairs||0).toBe(0);
  });
  it('clears an obsolete service-error reason after a successful segment, without resetting failed parts',async()=>{
    await plan(['ONE','TWO']);store.enqueueAnalysis('ann');store.setSetting('job-error:analyze:ann',{code:'unavailable',httpStatus:500});
    vi.mocked(requestPublic).mockResolvedValue(reply(base));await runWorkerTick(store,config);
    expect(store.getSetting('job-error:analyze:ann',null)).toBeNull();expect(queueStatus(store).find(r=>r.id==='analyze:ann')).toMatchObject({completed:1,total:2,failure:null});
  });
  it('uses consistent labels and distinguishes partial results from a terminal failure',()=>{
    expect(announcementAnalysisLabel({analysisStatus:'partial',analysisPendingParts:2})).toBe('部分完成 · 可继续');
    expect(announcementAnalysisNotice({analysisStatus:'partial',analysisPendingParts:2})).toContain('2 个部分仍待处理');
    expect(announcementAnalysisLabel({analysisStatus:'error'})).toBe('分析未完成');
  });
});
