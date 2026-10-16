import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../backend/db.ts';
import {hash,saveAI,type Config} from '../backend/config.ts';
import {analysisContext,analyze,callAI,parseAnalysis} from '../backend/ai.ts';
import {analysisRecovery} from '../backend/analysis-recovery.ts';
import {announcementReport} from '../backend/announcement-report.ts';
import {isCampusGuidanceImage} from '../backend/analysis-materials.ts';
import {AIServiceError,aiCooldown,clearAICooldown,httpFailure,markAIWait,postponeAI} from '../backend/ai-failure.ts';
import {runWorkerTick} from '../backend/worker.ts';
import {fileTool} from '../backend/files.ts';
import {requestPublic} from '../backend/net.ts';
import {todayCN} from '../backend/model.ts';

vi.mock('../backend/files.ts',()=>({fileTool:vi.fn()}));
vi.mock('../backend/net.ts',async original=>({...await original<typeof import('../backend/net.ts')>(),requestPublic:vi.fn()}));
const campusHash='41d362352bbe3f63f8f770686363d2ea695e43b838fd87bc8509b52ec503cb9a';
const base={relevant:true,type:'选调',summary:'公开选调公告',commonEligibility:[],commonCoverage:'complete',applicationItems:[],applicationCoverage:'complete',dates:[],jobs:[],uncertainties:[]};
const reply=(status=200,value:any={choices:[{message:{content:JSON.stringify(base)},finish_reason:'stop'}]})=>({status,headers:{},url:'https://example.invalid/v1/chat/completions',body:Buffer.from(JSON.stringify(value))});
let store:Store,config:Config;
beforeEach(()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-15T10:00:00+08:00'));
  mkdirSync('.check/analysis-v14-17/tests',{recursive:true});store=new Store(mkdtempSync(resolve('.check/analysis-v14-17/tests/case-')));
  config={dataDir:store.dir,origin:'http://127.0.0.1',host:'127.0.0.1',port:0,adminUsername:'fixture',passwordHash:'unused',masterKey:randomBytes(32).toString('hex'),python:'never-executed',distDir:resolve('dist')};
  saveAI(store,{baseUrl:'https://example.invalid/v1',model:'fixture',key:'not-a-real-key',vision:true,unlimited:true,dailyLimit:100},config);
  for(const key of ['last-auto-crawl','last-auto-follow','last-auto-backup'])store.setSetting(key,todayCN());
  vi.mocked(fileTool).mockReset();vi.mocked(requestPublic).mockReset();
});
afterEach(()=>{store.db.close();vi.useRealTimers();});
function seed(files:any[]=[],materialErrors:string[]=[]){
  const body='公开选调，岗位为管理岗，专业不限。';
  store.put('ann','announcement',{title:'测试选调公告',url:'https://source.example/notice',body,published:todayCN(),contentHash:hash(body),fileIds:files.map(f=>f.id),materialErrors,candidates:[],analysisStatus:'pending'});
  for(const f of files)store.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?)').run(f.id,'ann',f.name,'https://source.example/'+f.id,f.mime||'image/png',10,f.sha256||'digest',f.text||'',f.error||'');
}
const campus=(extra:any={})=>({id:'campus',name:'正文图片.jpg',mime:'image/jpeg',sha256:campusHash,...extra});
const doc=(extra:any={})=>({id:'doc',name:'高校名单.doc',mime:'application/msword',error:'此文件格式暂不能自动读取，原件已保存，请手动核对',...extra});
const readJob=(id='analyze:ann')=>store.prepare('SELECT * FROM jobs WHERE id=?').get(id) as any;

describe('campus guidance images are optional saved originals',()=>{
  it('recognizes a confirmed reused image and clearly labelled future guides, not official evidence',()=>{
    expect(isCampusGuidanceImage(campus())).toBe(true);
    expect(isCampusGuidanceImage(campus({sha256:'new',name:'2027届选调生校内报考提示.png'}))).toBe(true);
    expect(isCampusGuidanceImage(campus({sha256:'new',name:'校内提示图片.png'}))).toBe(true);
    expect(isCampusGuidanceImage(campus({sha256:'new',name:'官方报考条件.jpg'}))).toBe(false);
    expect(isCampusGuidanceImage(campus({sha256:'new',name:'高校名单.png'}))).toBe(false);
    expect(isCampusGuidanceImage(campus({sha256:'new',name:'校内报考提示.doc',mime:'application/msword'}))).toBe(false);
    expect(isCampusGuidanceImage(campus({sha256:'new'}))).toBe(false);
  });
  it('omits campus input before any image/model read while retaining the original and other images',async()=>{
    seed([campus(),{id:'official',name:'官方资格.png'}]);const before=store.prepare('SELECT * FROM files').all();
    const context=await analysisContext(store,config,'ann');
    expect(context.pendingImages.map(f=>f.id)).toEqual(['official']);expect(context.initial.some(s=>s.imageId==='campus')).toBe(false);
    expect(context.files.some(f=>f.id==='campus')).toBe(false);expect(fileTool).not.toHaveBeenCalled();expect(requestPublic).not.toHaveBeenCalled();
    expect(store.prepare('SELECT * FROM files').all()).toEqual(before);
  });
  it('does not turn intentionally skipped images into unread warnings when vision is disabled',async()=>{
    store.setSetting('ai',{model:'fixture',vision:false});seed([campus(),{id:'official',name:'官方岗位.png'}]);
    const context=await analysisContext(store,config,'ann');expect(context.issues).toEqual(['官方岗位.png：未启用模型图片读取，需核对原件']);
  });
  it('keeps an error when an official and campus image share the same generic filename',async()=>{
    seed([campus({error:'读取失败'}),{id:'official',name:'正文图片.jpg',error:'读取失败'}],['正文图片.jpg：读取失败']);
    expect((await analysisContext(store,config,'ann')).issues).toContain('正文图片.jpg：读取失败');
  });
  it('reuses official saved work, excludes a legacy campus result and finishes without another AI call',async()=>{
    seed([campus()]);const c=await analysisContext(store,config,'ann');
    const official={...parseAnalysis(JSON.stringify(base)),_source:c.initial[0].text,_table:false,_imageId:''};
    const oldImage={...parseAnalysis(JSON.stringify({...base,commonCoverage:'unknown',applicationCoverage:'partial',uncertainties:['校内扫码登记要求未确认']})),_source:'',_imageId:'campus'};
    store.setSetting('analysis:ann',{signature:c.legacySignature,sourceHash:c.ann.contentHash,index:2,segments:[c.initial[0],{text:'',depth:0,imageId:'campus'}],results:[official,oldImage],repairs:0,issues:[]});
    await analyze(store,config,'ann');const after=store.getSetting<any>('analysis:ann',{});
    expect(after.results[0]).toEqual(official);expect(after.results[1]._retired).toBe(true);expect(after.signature).toBe(c.signature);
    expect(analysisRecovery(after)).toMatchObject({total:1,saved:1,processed:1,pending:0,parts:[]});
    expect(store.get('ann')).toMatchObject({analysisStatus:'done',uncertainties:[]});expect(requestPublic).not.toHaveBeenCalled();
    expect(announcementReport(store,store.get('ann'))).toMatchObject({commonCoverage:'complete',uncertainties:[]});
  });
  it('does not reuse conclusions if personal conditions or other signature inputs changed',async()=>{
    seed([campus()]);const c=await analysisContext(store,config,'ann');
    store.setSetting('analysis:ann',{signature:'different-profile',sourceHash:c.ann.contentHash,index:1,segments:[c.initial[0]],results:[{...base,_source:c.initial[0].text}],issues:[]});
    await analyze(store,config,'ann',0);expect(store.getSetting<any>('analysis:ann',{}).results).toEqual([]);expect(requestPublic).not.toHaveBeenCalled();
  });
  it('finishes when only the ignored image exhausted its budget and does not downgrade a complete job',async()=>{
    seed([campus()]);const c=await analysisContext(store,config,'ann');
    const result={...parseAnalysis(JSON.stringify({...base,jobs:[{title:'管理岗',organization:'测试单位',match:'符合',reasons:'岗位专业不限',evidence:'专业不限',majorRequirements:[{levels:[],names:[],codes:[],unrestricted:true,evidence:'专业不限'}],eligibilityCoverage:'complete',eligibilityRequirements:[],applicationCoverage:'complete',applicationItems:[]}]})),_source:c.initial[0].text,_imageId:''};
    store.setSetting('analysis:ann',{signature:c.legacySignature,sourceHash:c.ann.contentHash,recoveryVersion:1,index:2,segments:[{...c.initial[0],outcome:'complete',resultIndex:0},{imageId:'campus',text:'',outcome:'failed',failure:{code:'format',message:'图片格式问题'}}],results:[result],stopped:true,issues:[]});
    await analyze(store,config,'ann');expect(store.get('ann').analysisStatus).toBe('done');
    expect(store.list('job')[0]).toMatchObject({applicationCoverage:'complete',eligibilityCoverage:'complete',analysisIncomplete:false});
    expect(analysisRecovery(store.getSetting('analysis:ann',{}))).toMatchObject({total:1,saved:1,pending:0});expect(requestPublic).not.toHaveBeenCalled();
  });
  it('hides old campus process/uncertainty output in a read-only report without editing saved analysis',async()=>{
    seed([campus()]);const c=await analysisContext(store,config,'ann');
    const old={index:2,segments:[c.initial[0],{imageId:'campus'}],results:[{...base,_source:c.initial[0].text},{...base,_imageId:'campus',commonCoverage:'unknown',uncertainties:['校内扫码登记时间需要确认'],applicationItems:[{kind:'procedure',label:'校内扫码',evidence:'校内扫码'}]}]};
    store.setSetting('analysis:ann',old);const ann=store.get('ann');store.put('ann','announcement',{...ann,analysisStatus:'partial'},ann.version);
    const report=announcementReport(store,store.get('ann'));expect(report.commonCoverage).toBe('complete');expect(report.uncertainties).toEqual([]);expect(report.applicationProcess).toEqual([]);expect(store.getSetting('analysis:ann',null)).toEqual(old);
  });
});

describe('failed legacy Word extraction is not permanently cached',()=>{
  it('re-reads failed DOC, includes recovered requirements and clears only the obsolete warning',async()=>{
    const f=doc();seed([f],[f.name+'：'+f.error,'其他附件下载失败']);vi.mocked(fileTool).mockResolvedValue({text:'允许报考的高校：中国农业大学。',error:''});
    const first=await analysisContext(store,config,'ann');const second=await analysisContext(store,config,'ann');
    expect(fileTool).toHaveBeenCalledTimes(1);expect(first.initial.some(s=>s.text.includes('中国农业大学'))).toBe(true);expect(second.signature).toBe(first.signature);
    expect(first.issues).toEqual(['其他附件下载失败']);expect(second.issues).toEqual(first.issues);
    expect(store.prepare('SELECT sha256,size,error FROM files').get()).toMatchObject({sha256:'digest',size:10,error:''});
    expect(requestPublic).not.toHaveBeenCalled();
  });
  it('does not run a parser or write failed caches during read-only checks',async()=>{
    seed([doc()]);const before=store.prepare('SELECT * FROM files').all();await analysisContext(store,config,'ann',true);
    expect(store.prepare('SELECT * FROM files').all()).toEqual(before);expect(store.getSetting('document-read:doc',null)).toBeNull();expect(fileTool).not.toHaveBeenCalled();
  });
  it('bounds damaged-document retries per run and retries when the user explicitly continues',async()=>{
    seed([doc()]);vi.mocked(fileTool).mockResolvedValue({text:'',error:'DOC 无法转换，可能损坏或受密码保护；原件保留'});
    await analysisContext(store,config,'ann');await analysisContext(store,config,'ann');expect(fileTool).toHaveBeenCalledTimes(1);
    store.enqueueAnalysis('ann',true);vi.mocked(fileTool).mockResolvedValue({text:'已经恢复的高校名单',error:''});await analysisContext(store,config,'ann');
    expect(fileTool).toHaveBeenCalledTimes(2);expect(store.prepare('SELECT text,error FROM files').get()).toMatchObject({text:'已经恢复的高校名单',error:''});
    store.enqueueAnalysis('ann',true);await analysisContext(store,config,'ann');expect(fileTool).toHaveBeenCalledTimes(2);
  });
  it('keeps recovered text and an explicit error if a parser fails or returns no readable content',async()=>{
    seed([doc({text:'已保存的部分内容'})]);vi.mocked(fileTool).mockRejectedValue(new Error('internal path/secret'));
    const c=await analysisContext(store,config,'ann');expect(c.files[0].text).toBe('已保存的部分内容');expect(c.issues.join()).not.toContain('secret');expect(c.issues.join()).toContain('原件已保存');
  });
  it('invalidates a failed extraction cache when the file content changes',async()=>{
    seed([doc()]);vi.mocked(fileTool).mockResolvedValue({text:'',error:'无法读取'});await analysisContext(store,config,'ann');
    store.prepare('UPDATE files SET sha256=? WHERE id=?').run('new-digest','doc');vi.mocked(fileTool).mockResolvedValue({text:'更正后的内容',error:''});await analysisContext(store,config,'ann');
    expect(fileTool).toHaveBeenCalledTimes(2);expect(store.prepare('SELECT text FROM files').get()).toMatchObject({text:'更正后的内容'});
  });
  it('retains the successful old checkpoint when recovered official material requires a new plan',async()=>{
    seed([doc()]);const c=await analysisContext(store,config,'ann',true);
    const old={signature:c.signature,sourceHash:c.ann.contentHash,index:1,segments:c.initial,results:[{...base,_source:c.initial[0].text}],issues:c.issues};store.setSetting('analysis:ann',old);
    vi.mocked(fileTool).mockResolvedValue({text:'新增完整学校范围：中国农业大学。',error:''});await analyze(store,config,'ann',0);
    expect(store.getSetting('analysis-before-materials:ann:'+hash(JSON.stringify(old)),null)).toEqual(old);
    const next=store.getSetting<any>('analysis:ann',{});expect(next.index).toBe(0);expect(next.segments.some((s:any)=>s.text.includes('新增完整学校范围'))).toBe(true);expect(requestPublic).not.toHaveBeenCalled();
  });
});

describe('bounded cooldown and recovery of associated queued work',()=>{
  it('caps local service backoff at five minutes and rate-limit backoff at fifteen, retaining Retry-After',()=>{
    for(let i=0;i<10;i++)expect(postponeAI(store,new AIServiceError('unavailable',true))-Date.now()).toBeLessThanOrEqual(300000);
    for(let i=0;i<10;i++)expect(postponeAI(store,new AIServiceError('rate_limit',true))-Date.now()).toBeLessThanOrEqual(900000);
    expect(postponeAI(store,httpFailure(429,{},'10800'))-Date.now()).toBe(10800000);
    expect(postponeAI(store,httpFailure(503,{},new Date(Date.now()+3600000).toUTCString()))-Date.now()).toBe(3600000);
  });
  it('releases only tracked provider waits after a successful test, without resetting attempt budgets',async()=>{
    seed();store.enqueueAnalysis('ann');vi.mocked(requestPublic).mockResolvedValue(reply(503,{}));await runWorkerTick(store,config);
    expect(readJob()).toMatchObject({state:'retry',attempts:1});expect(readJob().available_at).toBeGreaterThan(Date.now());
    store.enqueue('backup:later','backup',{});store.prepare("UPDATE jobs SET state='retry',available_at=? WHERE id=?").run(Date.now()+3600000,'backup:later');
    vi.mocked(requestPublic).mockResolvedValue(reply());await callAI(store,config,[],128,1000,'test');
    expect(aiCooldown(store)).toBeNull();expect(readJob()).toMatchObject({state:'retry',attempts:1,available_at:0});expect(readJob('backup:later').available_at).toBeGreaterThan(Date.now());
    await runWorkerTick(store,config);expect(readJob().state).toBe('done');
  });
  it('does not clear a new failure that occurred while an older successful request was in flight',()=>{
    postponeAI(store,new AIServiceError('rate_limit',true));const before=aiCooldown(store);postponeAI(store,new AIServiceError('rate_limit',true));const current=aiCooldown(store);
    clearAICooldown(store,before);expect(aiCooldown(store)).toEqual(current);
  });
  it('preserves changed schedules, terminal errors, local quotas and different-provider waits',()=>{
    const until=postponeAI(store,new AIServiceError('rate_limit',true));
    for(const [id,state] of [['manual','retry'],['terminal','error'],['quota','waiting_quota'],['other','retry']] as const){
      store.enqueue(id,'analyze',{id});markAIWait(store,id,until);store.prepare('UPDATE jobs SET state=?,available_at=? WHERE id=?').run(state,until,id);
    }
    store.prepare('UPDATE jobs SET available_at=? WHERE id=?').run(until+5000,'manual');store.setSetting('ai-wait:other',{fingerprint:'other-provider',until});
    clearAICooldown(store);for(const id of ['manual','terminal','quota','other'])expect(readJob(id).available_at).toBeGreaterThan(Date.now());
  });
  it('does not treat an invalid successful HTTP envelope as recovery',async()=>{
    const until=postponeAI(store,new AIServiceError('unavailable',true));vi.mocked(requestPublic).mockResolvedValue(reply(200,{choices:[{message:{content:''}}]}));
    await expect(callAI(store,config,[],128,1000,'test')).rejects.toMatchObject({code:'empty'});expect(aiCooldown(store)?.until).toBe(until);
  });
});
