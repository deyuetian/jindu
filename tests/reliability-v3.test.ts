import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { mkdirSync,mkdtempSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../backend/db.ts';
import { saveAI,hash,type Config } from '../backend/config.ts';
import { AIOutputError,analyze,callAI } from '../backend/ai.ts';
import { requestPublic } from '../backend/net.ts';
import { detail,needsDetail } from '../backend/crawler.ts';
import { makeBackup,restoreBackup } from '../backend/backup.ts';
import { initializeWorker,runWorkerTick } from '../backend/worker.ts';
import { todayCN } from '../backend/model.ts';

vi.mock('../backend/net.ts',async original=>({...await original<typeof import('../backend/net.ts')>(),requestPublic:vi.fn()}));
let store:Store,config:Config;
beforeEach(()=>{
  mkdirSync('.check/tests/reliability-v3',{recursive:true});
  const dataDir=mkdtempSync(resolve('.check/tests/reliability-v3/case-'));
  store=new Store(dataDir);config={dataDir,origin:'http://127.0.0.1:8788',host:'127.0.0.1',port:8788,adminUsername:'test-only',passwordHash:'unused',masterKey:randomBytes(32).toString('hex'),python:process.env.JINDU_TEST_PYTHON||'python',distDir:resolve('dist')};
  for(const key of ['last-auto-crawl','last-auto-follow','last-auto-backup'])store.setSetting(key,todayCN());
  saveAI(store,{baseUrl:'https://api.example.com/v1',model:'test-only',key:'not-a-real-secret'},config);
  vi.mocked(requestPublic).mockReset();
});
afterEach(()=>store.db.close());
const answer=(extra:any={})=>({relevant:true,type:'事业单位',summary:'测试摘要',province:'',uncertainties:[],dates:[],jobs:[],...extra});
const response=(value:any,finish_reason='stop')=>({status:200,headers:{},url:'https://api.example.com/v1/chat/completions',body:Buffer.from(JSON.stringify({choices:[{message:{content:typeof value==='string'?value:JSON.stringify(value)},finish_reason}],usage:{prompt_tokens:21,completion_tokens:13}}))});
function notice(body='测试公告正文',extra:any={}){return store.put('ann:reliability','announcement',{title:'测试招聘',body,url:'https://source.example/notice',published:'2026-09-21',contentHash:hash(body),candidates:[],status:'pending',analysisStatus:'pending',materialsComplete:true,...extra});}

describe('bounded analysis recovery',()=>{
  it('classifies empty length-limited output as truncation and records all usage',async()=>{
    vi.mocked(requestPublic).mockResolvedValue(response('','length'));
    await expect(callAI(store,config,[])).rejects.toMatchObject({code:'truncated'});
    expect(store.db.prepare('SELECT calls,input_tokens,output_tokens FROM usage').get()).toMatchObject({calls:1,input_tokens:21,output_tokens:13});
  });
  it('preserves completed segments across truncation and reopening the database',async()=>{
    const a=notice('FIRST_SEGMENT '+'.'.repeat(13000));
    vi.mocked(requestPublic).mockResolvedValue(response(answer({summary:'后续成功'})))
      .mockResolvedValueOnce(response(answer({summary:'第一段已完成'})))
      .mockResolvedValueOnce(response('','length'));
    expect(await analyze(store,config,a.id,1)).toBe(false);
    expect(await analyze(store,config,a.id,1)).toBe(false);
    expect(store.getSetting<any>('analysis:'+a.id,{})).toMatchObject({index:1,repairs:1,results:[{summary:'第一段已完成'}]});
    const reopened=new Store(config.dataDir);
    try{let done=false;for(let n=0;n<10&&!done;n++)done=await analyze(reopened,config,a.id,1)===true;expect(done).toBe(true);}finally{reopened.db.close();}
    const calls=vi.mocked(requestPublic).mock.calls.map(([,options])=>JSON.parse(options!.body!).messages[1].content);
    expect(calls.filter(text=>text.includes('FIRST_SEGMENT'))).toHaveLength(1);
    expect(store.get(a.id).summary).toContain('第一段已完成');
  });
  it('stops malformed output after the initial request plus four repairs, including later restarts',async()=>{
    const a=notice('较短的测试公告');vi.mocked(requestPublic).mockResolvedValue(response('not JSON'));
    for(let n=0;n<4;n++)expect(await analyze(store,config,a.id,1)).toBe(false);
    await expect(analyze(store,config,a.id,1)).rejects.toBeInstanceOf(AIOutputError);
    await expect(analyze(store,config,a.id,1)).rejects.toBeInstanceOf(AIOutputError);
    expect(requestPublic).toHaveBeenCalledTimes(5);expect(store.getSetting<any>('analysis:'+a.id,{}).stopped).toBe(true);
  });
  it('preserves a successful checkpoint when the daily quota is exhausted',async()=>{
    const a=notice('额度测试'.repeat(4000));saveAI(store,{baseUrl:'https://api.example.com/v1',model:'test-only',dailyLimit:1},config);
    vi.mocked(requestPublic).mockResolvedValue(response(answer()));expect(await analyze(store,config,a.id,1)).toBe(false);
    await expect(analyze(store,config,a.id,1)).rejects.toMatchObject({status:429});
    expect(store.getSetting<any>('analysis:'+a.id,{})).toMatchObject({index:1,repairs:0});expect(requestPublic).toHaveBeenCalledTimes(1);
  });
  it('manual retry resets the repair budget but keeps already completed segments',async()=>{
    const a=notice('PRESERVED_FIRST_SEGMENT '+'.'.repeat(13000));
    vi.mocked(requestPublic).mockResolvedValue(response('not JSON')).mockResolvedValueOnce(response(answer({summary:'无需重新付费的成功段'})));
    expect(await analyze(store,config,a.id,1)).toBe(false);for(let n=0;n<4;n++)expect(await analyze(store,config,a.id,1)).toBe(false);
    expect(await analyze(store,config,a.id,1)).toBe(false);
    const before=store.getSetting<any>('analysis:'+a.id,{});expect(before.segments[1].outcome).toBe('failed');
    store.enqueueAnalysis(a.id,true);const resumed=store.getSetting<any>('analysis:'+a.id,{});
    expect(resumed).toMatchObject({index:1,repairs:0,stopped:false,results:before.results});
    vi.mocked(requestPublic).mockResolvedValue(response(answer()));await analyze(store,config,a.id);
    expect(vi.mocked(requestPublic).mock.calls.filter(([,options])=>JSON.parse(options!.body!).messages[1].content.includes('PRESERVED_FIRST_SEGMENT'))).toHaveLength(1);
    expect(vi.mocked(requestPublic).mock.calls.every(([,options])=>JSON.parse(options!.body!).max_tokens===6000)).toBe(true);
  });
  it('checkpoints skipped oversized images and retains their incomplete warning',async()=>{
    const images=['f'.repeat(64),'e'.repeat(64)],a=notice('图片公告',{fileIds:images});saveAI(store,{baseUrl:'https://api.example.com/v1',model:'test-only',vision:true},config);
    for(const image of images)store.db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?)').run(image,a.id,'超大图'+image[0]+'.png','https://source.example/'+image[0]+'.png','image/png',6000001,image,'','');
    vi.mocked(requestPublic).mockResolvedValue(response(answer()));expect(await analyze(store,config,a.id,1)).toBe(false);
    expect(await analyze(store,config,a.id,1)).toBe(false);expect(store.getSetting<any>('analysis:'+a.id,{}).index).toBe(2);
    expect(await analyze(store,config,a.id,1)).toBe(true);expect(requestPublic).toHaveBeenCalledTimes(1);
    expect(store.get(a.id)).toMatchObject({analysisStatus:'partial'});expect(store.get(a.id).uncertainties.filter((s:string)=>s.includes('超过本次分析大小限制'))).toHaveLength(2);
  });
});

describe('incremental and restored queues',()=>{
  it('reanalyzes repaired attachments once and preserves the previous summary until replacement',async()=>{
    const item={id:'repair-file',title:'附件修复测试',createDate:'2026-09-21'};let available=false;
    vi.mocked(requestPublic).mockImplementation(async url=>{
      if(url.includes('/ajax_view'))return {status:200,headers:{},url,body:Buffer.from(JSON.stringify({state:1,object:{article:{title:item.title,createDate:item.createDate,articleData:{content:'<p>正文</p><a href="https://source.example/file.html">附件</a>'}}}}))};
      if(!available)throw new Error('simulated temporary failure');return {status:200,headers:{'content-type':'text/html'},url,body:Buffer.from('<p>附件正文</p>')};
    });
    await detail(store,config,{item,recruit:false});let a=store.get('cau:'+item.id);
    store.db.prepare("UPDATE jobs SET state='done' WHERE type='analyze'").run();store.put(a.id,'announcement',{...a,analysisStatus:'partial',summary:'已有摘要'},a.version);
    available=true;await detail(store,config,{item,recruit:false});a=store.get(a.id);
    expect(a).toMatchObject({summary:'已有摘要',analysisStatus:'pending',materialsComplete:true});expect(needsDetail(a,item,false)).toBe(false);
    await detail(store,config,{item,recruit:false});expect(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='analyze' AND state!='done'").get()).toMatchObject({n:1});
  });
  it('restores one analysis task per unfinished notice without rerunning finished or partial notices',async()=>{
    const a=notice();for(const [id,status] of [['ann:done','done'],['ann:partial','partial'],['ann:failed','error']])store.put(id,'announcement',{...a,analysisStatus:status});
    store.setSetting('analysis-requeue:'+a.id,{reset:true});const b=await makeBackup(store,config);
    await restoreBackup(store,config,join(config.dataDir,'backups',b.name));
    expect(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='analyze'").get()).toMatchObject({n:2});
    expect(store.getSetting('analysis-requeue:'+a.id,false)).toBe(false);
    store.recoverAnalyses();expect(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='analyze' AND state!='done'").get()).toMatchObject({n:2});
  });
  it('does not repeat the one-time recovery migration on every startup',()=>{
    const a=notice('待恢复',{analysisStatus:'error'});store.enqueueAnalysis(a.id);initializeWorker(store);store.db.prepare("UPDATE jobs SET state='error',attempts=5 WHERE type='analyze'").run();
    initializeWorker(store);expect(store.db.prepare("SELECT state,attempts FROM jobs WHERE id=?").get('analyze:'+a.id)).toMatchObject({state:'error',attempts:5});
  });
  it('handles a requeue request received while yielding a completed analysis segment',async()=>{
    const a=notice('长公告'.repeat(5000));store.enqueueAnalysis(a.id);
    vi.mocked(requestPublic).mockImplementation(async()=>{store.enqueueAnalysis(a.id);return response(answer());});
    await runWorkerTick(store,config);
    expect(store.db.prepare("SELECT state FROM jobs WHERE id=?").get('analyze:'+a.id)).toMatchObject({state:'pending'});
    expect(store.getSetting<any>('analysis:'+a.id,{}).index).toBe(1);expect(store.getSetting('analysis-requeue:'+a.id,false)).toBe(false);
  });
  it('handles an explicit reset received while a model request fails',async()=>{
    const a=notice();store.enqueueAnalysis(a.id);store.setSetting('analysis:'+a.id,{old:'checkpoint'});
    vi.mocked(requestPublic).mockImplementation(async()=>{store.enqueueAnalysis(a.id,true);return {status:503,headers:{},url:'',body:Buffer.from('{}')};});
    await runWorkerTick(store,config);
    expect(store.db.prepare("SELECT state FROM jobs WHERE id=?").get('analyze:'+a.id)).toMatchObject({state:'pending'});
    expect(store.get(a.id).analysisStatus).toBe('pending');expect(store.getSetting('analysis:'+a.id,null)).toMatchObject({index:0,results:[],repairs:0});expect(store.getSetting('analysis-requeue:'+a.id,false)).toBe(false);
  });
  it('coalesces a non-reset requeue at completion without repeating the successful model request',async()=>{
    const a=notice();store.enqueueAnalysis(a.id);
    vi.mocked(requestPublic).mockImplementation(async()=>{store.enqueueAnalysis(a.id);return response(answer());});
    await runWorkerTick(store,config);expect(store.db.prepare("SELECT state FROM jobs WHERE id=?").get('analyze:'+a.id)).toMatchObject({state:'pending'});
    await runWorkerTick(store,config);expect(store.db.prepare("SELECT state FROM jobs WHERE id=?").get('analyze:'+a.id)).toMatchObject({state:'done'});expect(requestPublic).toHaveBeenCalledTimes(1);
  });
});

describe('configuration waiting jobs',()=>{
  it('wakes all AI types only with complete configuration and enough remaining quota',()=>{
    for(const type of ['analyze','agent','follow']){store.enqueue(type,type,{id:type});store.db.prepare("UPDATE jobs SET state='waiting_config',attempts=2 WHERE id=?").run(type);}
    saveAI(store,{baseUrl:'',model:''},config);expect(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE state='waiting_config'").get()).toMatchObject({n:3});
    saveAI(store,{baseUrl:'https://api.example.com/v1',model:'test-only'},config);expect(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE state='pending' AND attempts=2").get()).toMatchObject({n:3});
    store.db.prepare("UPDATE jobs SET state='waiting_quota'").run();store.db.prepare('INSERT INTO usage(day,calls) VALUES(?,60)').run(todayCN());
    saveAI(store,{baseUrl:'https://api.example.com/v1',model:'test-only',dailyLimit:60},config);expect(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE state='waiting_quota'").get()).toMatchObject({n:3});
    saveAI(store,{baseUrl:'https://api.example.com/v1',model:'test-only',dailyLimit:61},config);expect(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE state='pending'").get()).toMatchObject({n:3});expect(requestPublic).not.toHaveBeenCalled();
  });
});

describe('current job evidence after reanalysis',()=>{
  it('merges verified professional clauses across segments and preserves application state',async()=>{
    const profile=store.save('profile',{title:'本人',education:[{level:'本科',major:'土地资源管理',code:'120404'}]});
    const requirement={levels:['本科'],names:['公共管理类'],codes:[],unrestricted:false,evidence:'本岗位要求本科公共管理类专业',catalog:''};
    const a=notice('岗位概要\n'+'.'.repeat(6100)+'\n'+requirement.evidence);
    const job={title:'土地管理岗',organization:'测试单位',profileId:profile.id,match:'符合',reasons:'分段核对',evidence:'岗位原文',majorRequirements:[]};
    const jid=`job:${a.id}:${hash(JSON.stringify([job.organization,job.title,job.profileId])).slice(0,24)}`;
    store.put(jid,'job',{...job,announcementId:a.id,status:'已报名',notes:'保留我的备注',archived:false,majorStatus:'matched'});
    vi.mocked(requestPublic).mockResolvedValueOnce(response(answer({jobs:[job]}))).mockResolvedValueOnce(response(answer({jobs:[{...job,majorRequirements:[requirement]}]})));
    expect(await analyze(store,config,a.id)).toBe(true);
    expect(store.get(jid)).toMatchObject({majorStatus:'matched',status:'已报名',notes:'保留我的备注',analysisCurrent:true});expect(store.get(jid).majorRequirements).toHaveLength(1);
    store.db.prepare('DELETE FROM settings WHERE key=?').run('analysis:'+a.id);vi.mocked(requestPublic).mockResolvedValue(response(answer()));
    await analyze(store,config,a.id);expect(store.get(jid)).toMatchObject({majorStatus:'unknown',match:'待核对',status:'已报名',notes:'保留我的备注',analysisCurrent:false});
  });
});
