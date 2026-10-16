import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '../backend/db.ts';
import {saveAI,type Config} from '../backend/config.ts';
import {callAI} from '../backend/ai.ts';
import {requestPublic,safeError} from '../backend/net.ts';
import {runWorkerTick} from '../backend/worker.ts';
import {AIServiceError,AIServicePaused,networkFailure,httpFailure,aiCooldown,postponeAI} from '../backend/ai-failure.ts';
import {queueTurn,conversation} from '../backend/agent.ts';
import {queueStatus} from '../backend/queue-status.ts';
import {markNoticesSeen} from '../backend/agent-notices.ts';
import {schemas,todayCN} from '../backend/model.ts';

vi.mock('../backend/net.ts',async original=>({...await original<typeof import('../backend/net.ts')>(),requestPublic:vi.fn()}));
let store:Store,config:Config;
beforeEach(()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-13T09:00:00+08:00'));
  mkdirSync('.check/recovery-v14-12/tests',{recursive:true});
  const dataDir=mkdtempSync(resolve('.check/recovery-v14-12/tests/case-'));
  store=new Store(dataDir);config={dataDir,origin:'http://127.0.0.1',host:'127.0.0.1',port:0,adminUsername:'fixture',passwordHash:'unused',masterKey:randomBytes(32).toString('hex'),python:'unused',distDir:resolve('dist')};
  for(const key of ['last-auto-crawl','last-auto-follow','last-auto-backup'])store.setSetting(key,todayCN());
  saveAI(store,{baseUrl:'https://example.invalid/v1',model:'fixture',key:'test-key',unlimited:true,dailyLimit:100},config);
  vi.mocked(requestPublic).mockReset();
});
afterEach(()=>{store.db.close();vi.useRealTimers();vi.restoreAllMocks();});
const content={relevant:true,type:'其他',summary:'招聘公告',dates:[],jobs:[],commonEligibility:[],commonCoverage:'complete',applicationItems:[],applicationCoverage:'complete'};
const response=(status:number,value:any,headers:Record<string,string>={})=>({status,headers,url:'https://example.invalid',body:Buffer.from(JSON.stringify(value))});
const success=()=>response(200,{choices:[{message:{content:JSON.stringify(content)},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});
const seed=(id='ann',body='招聘公告，不限专业。')=>{store.put(id,'announcement',{title:id,body,url:'https://example.invalid/notice',published:todayCN(),contentHash:'source-'+id,fileIds:[],materialErrors:[],candidates:[]});store.enqueueAnalysis(id);};
const job=(id='ann')=>store.prepare('SELECT * FROM jobs WHERE id=?').get('analyze:'+id) as any;
const calls=()=>(store.prepare('SELECT COUNT(*) n FROM ai_requests').get() as {n:number}).n;
const later=(ms:number)=>{vi.setSystemTime(Date.now()+ms);for(const key of ['last-auto-crawl','last-auto-follow','last-auto-backup'])store.setSetting(key,todayCN());};

describe('AI failures and saved progress',()=>{
  it.each([[429,'rate_limit',true],[503,'unavailable',true],[408,'timeout',true],[401,'auth',false],[403,'auth',false],[400,'request',false]] as const)('classifies HTTP %s without exposing provider response',async(status,code,retryable)=>{
    vi.mocked(requestPublic).mockResolvedValue(response(status,{error:{message:'secret https://private.invalid/key'}}));
    const error=await callAI(store,config,[]).catch(e=>e);
    expect(error).toBeInstanceOf(AIServiceError);expect(error).toMatchObject({code,retryable,httpStatus:status});expect(error.message).not.toMatch(/secret|private/);expect(calls()).toBe(1);
  });
  it('distinguishes provider credit exhaustion from transient 429 and respects Retry-After',()=>{
    expect(httpFailure(429,{error:{type:'insufficient_quota'}})).toMatchObject({code:'quota',retryable:false});
    expect(httpFailure(429,null,'120').retryAfterMs).toBe(120000);
    expect(httpFailure(503,null,new Date(Date.now()+240000).toUTCString()).retryAfterMs).toBe(240000);
    expect(httpFailure(503,null,'nonsense').retryAfterMs).toBe(0);
  });
  it.each([['EAI_AGAIN','dns',true],['ECONNRESET','connection',true],['ETIMEDOUT','timeout',true],['CERT_HAS_EXPIRED','tls',false]] as const)('retains safe transport code %s',async(code,kind,retryable)=>{
    const raw=Object.assign(new Error('sensitive request URL and token'),{code});vi.mocked(requestPublic).mockRejectedValue(raw);
    const error=await callAI(store,config,[]).catch(e=>e);expect(error).toMatchObject({code:kind,retryable,transportCode:code});expect(safeError(raw)).not.toContain('sensitive');
  });
  it('supports nested transport causes and leaves unknown errors unclassified',()=>{
    expect(networkFailure(new Error('fetch failed',{cause:{code:'ENOTFOUND'}}))?.code).toBe('dns');expect(networkFailure(new Error('unknown'))).toBeUndefined();
  });
  it('pauses all AI requests after throttling without consuming calls, then resumes after Retry-After',async()=>{
    seed();seed('second');vi.mocked(requestPublic).mockResolvedValue(response(429,{}, {'retry-after':'120'}));
    await runWorkerTick(store,config);expect(job()).toMatchObject({state:'retry',attempts:1});expect(job().available_at-Date.now()).toBe(120000);
    await runWorkerTick(store,config);expect(job('second').state).toBe('pending');expect(calls()).toBe(1);
    await expect(callAI(store,config,[],6000,120000,'agent')).rejects.toBeInstanceOf(AIServicePaused);expect(calls()).toBe(1);
    expect(queueStatus(store).find(r=>r.id==='analyze:second')).toMatchObject({stateLabel:'等待 AI 接口恢复',nextAttemptAt:new Date(Date.now()+120000).toISOString()});
    later(120001);vi.mocked(requestPublic).mockResolvedValue(success());await runWorkerTick(store,config);expect(calls()).toBe(2);expect(aiCooldown(store)).toBeNull();
  });
  it('keeps successful segments and resumes only the unfinished segment after a connection failure',async()=>{
    seed('ann','招聘公告。'.repeat(1600));vi.mocked(requestPublic).mockResolvedValue(success());await runWorkerTick(store,config);
    const saved=store.getSetting<any>('analysis:ann',null);expect(saved.index).toBe(1);expect(saved.segments.length).toBeGreaterThan(1);
    vi.mocked(requestPublic).mockRejectedValue(Object.assign(new Error('private URL'),{code:'ECONNRESET'}));await runWorkerTick(store,config);
    expect(store.getSetting<any>('analysis:ann',null).results).toEqual(saved.results);expect(store.getSetting<any>('analysis:ann',null).index).toBe(1);
    later(60001);vi.mocked(requestPublic).mockResolvedValue(success());await runWorkerTick(store,config);
    expect(store.getSetting<any>('analysis:ann',null).index).toBe(2);expect(calls()).toBe(3);expect(job().state).toBe('done');
    expect(store.get('ann').analysisStatus).not.toBe('error');
  });
  it('uses longer waits and stops after six consecutive transient failures',async()=>{
    seed();vi.mocked(requestPublic).mockResolvedValue(response(503,{}));
    for(const [i,delay] of [60000,120000,300000,300000,300000,300000].entries()){
      await runWorkerTick(store,config);expect(job().attempts).toBe(i+1);expect(aiCooldown(store)!.until-Date.now()).toBe(delay);expect(job().state).toBe(i<5?'retry':'error');later(delay+1);
    }
    await runWorkerTick(store,config);expect(calls()).toBe(6);expect(store.get('ann').analysisError).toContain('已连续尝试 6 次');
    expect(store.getSetting<any>('job-error:analyze:ann',null)).toMatchObject({code:'unavailable',httpStatus:503,attempts:6});
  });
  it('does not keep retrying provider authentication, credit or TLS errors',async()=>{
    seed();vi.mocked(requestPublic).mockResolvedValue(response(401,{}));await runWorkerTick(store,config);expect(job().state).toBe('waiting_config');expect(aiCooldown(store)).toBeNull();
    store.enqueueAnalysis('ann');vi.mocked(requestPublic).mockResolvedValue(response(429,{error:{code:'insufficient_quota'}}));await runWorkerTick(store,config);expect(job().state).toBe('error');expect(aiCooldown(store)).toBeNull();
    store.enqueueAnalysis('ann');vi.mocked(requestPublic).mockRejectedValue(Object.assign(new Error('private'),{code:'CERT_HAS_EXPIRED'}));await runWorkerTick(store,config);expect(job().state).toBe('error');expect(job().error).toContain('安全证书');
  });
  it('keeps local daily usage limits distinct from upstream rate limits',async()=>{
    saveAI(store,{baseUrl:'https://example.invalid/v1',model:'fixture',unlimited:false,dailyLimit:1},config);
    seed();store.prepare('INSERT INTO usage(day,calls) VALUES(?,1)').run(todayCN());await runWorkerTick(store,config);
    expect(job().state).toBe('waiting_quota');expect(aiCooldown(store)).toBeNull();expect(requestPublic).not.toHaveBeenCalled();
  });
  it('runs unambiguous attention/calendar removals while the AI provider is cooling down',async()=>{
    const title='湖南省2027年定向选调公告';store.put('ann','announcement',{title});store.put('job','job',{title:'岗位',status:'关注',announcementId:'ann'});
    store.put('exam:ann','exam',schemas.exam.parse({title,type:'选调',url:'https://example.invalid',announcementId:'ann',stages:[],tracking:{enabled:true,query:title}}));
    postponeAI(store,new AIServiceError('rate_limit',true));const turn=queueTurn(store,{id:randomUUID(),text:'取消关注湖南定向，并删除其日历'});
    await runWorkerTick(store,config);expect(store.get(turn.id).done).toBe(true);expect(store.get('job').status).toBe('未选择');expect(store.get('exam:ann').archived).toBe(true);expect(requestPublic).not.toHaveBeenCalled();
  });
  it('invalidates cooldown after a changed provider or model without clearing saved work',()=>{
    postponeAI(store,new AIServiceError('rate_limit',true));expect(aiCooldown(store)).not.toBeNull();
    saveAI(store,{baseUrl:'https://example.invalid/v1',model:'new-fixture',dailyLimit:100},config);expect(aiCooldown(store)).toBeNull();
  });
});

function notice(id:string,examId:string,createdAt='2026-09-24T01:00:00Z'){store.put(id,'agent_turn',schemas.agent_turn.parse({createdAt,notice:true,done:true,examId,reply:'时间更新',before:'original-source'}));}
function exam(id:string,archived=false){store.put(id,'exam',schemas.exam.parse({title:id,type:'选调',url:'https://example.invalid',archived,stages:[]}));}
describe('assistant unread notifications',()=>{
  it('counts only active-calendar notices consistently in snapshot and conversation',()=>{
    exam('active');exam('archived',true);notice('n1','active');notice('n2','archived');notice('n3','missing');
    expect(store.snapshot().agentUnread).toBe(1);const turns=conversation(store);expect(turns.filter(t=>t.noticeUnread).map(t=>t.id)).toEqual(['n1']);
    expect(turns.find(t=>t.id==='n2')).toMatchObject({noticeActive:false,seen:false});expect(turns.find(t=>t.id==='n2')).not.toHaveProperty('before');expect(store.get('n2').before).toBe('original-source');
  });
  it('keeps older unread notices reachable even when there are more than 80 recent turns',()=>{
    exam('active');notice('old','active');
    for(let i=0;i<90;i++)store.put('chat:'+i,'agent_turn',schemas.agent_turn.parse({createdAt:new Date(Date.parse('2026-10-01')+i*60000).toISOString(),text:'消息',reply:'答复',done:true}));
    const turns=conversation(store);expect(turns).toHaveLength(81);expect(turns[0].id).toBe('old');expect(turns.filter(t=>t.noticeUnread)).toHaveLength(store.snapshot().agentUnread);
  });
  it('marks only specified displayed notices read and leaves later arrivals and history intact',()=>{
    exam('active');exam('archived',true);notice('visible','active');notice('below','active');notice('later','active');notice('history','archived');
    const before=store.get('visible');expect(markNoticesSeen(store,{ids:['visible','visible','missing','history']})).toEqual({ok:true,changed:1});
    expect(store.get('visible')).toMatchObject({reply:before.reply,before:before.before,seen:true,version:before.version+1});expect(store.snapshot().agentUnread).toBe(2);
    expect(store.get('later').seen).toBe(false);expect(store.get('history').seen).toBe(false);expect(markNoticesSeen(store,{ids:['visible']})).toEqual({ok:true,changed:0});
  });
  it('retains compatibility for explicitly marking all active notifications read',()=>{
    exam('active');notice('n1','active');expect(markNoticesSeen(store,{}).changed).toBe(1);expect(store.snapshot().agentUnread).toBe(0);
  });
});
