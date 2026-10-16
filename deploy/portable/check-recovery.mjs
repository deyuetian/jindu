// Runtime-only smoke check. Synthetic records; AI remains blocked by cooldown.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '../../backend/db.ts';
import {saveAI} from '../../backend/config.ts';
import {schemas,todayCN} from '../../backend/model.ts';
import {AIServiceError,AIServicePaused,networkFailure,httpFailure,postponeAI,aiCooldown} from '../../backend/ai-failure.ts';
import {callAI} from '../../backend/ai.ts';
import {queueStatus} from '../../backend/queue-status.ts';
import {conversation,queueTurn} from '../../backend/agent.ts';
import {markNoticesSeen} from '../../backend/agent-notices.ts';
import {runWorkerTick} from '../../backend/worker.ts';
const store=new Store(mkdtempSync(join(tmpdir(),'jindu-recovery-'))),config={dataDir:store.dir,origin:'http://127.0.0.1',masterKey:randomBytes(32).toString('hex')};
try{
  saveAI(store,{baseUrl:'https://example.invalid/v1',model:'fixture',key:'fixture',dailyLimit:10},config);
  assert.equal(networkFailure(Object.assign(new Error('must not be logged'),{code:'EAI_AGAIN'})).code,'dns');
  assert.equal(httpFailure(429,{error:{type:'insufficient_quota'}}).retryable,false);
  assert.equal(httpFailure(503,{},'120').retryAfterMs,120000);
  const until=postponeAI(store,new AIServiceError('rate_limit',true,429,120000));
  await assert.rejects(callAI(store,config,[]),AIServicePaused);assert.equal(aiCooldown(store).until,until);
  const title='湖南省2027年定向选调公告';store.put('ann','announcement',{title,contentHash:'fixture'});store.enqueueAnalysis('ann');
  assert.equal(queueStatus(store)[0].stateLabel,'等待 AI 接口恢复');
  store.put('exam','exam',schemas.exam.parse({title,type:'选调',url:'https://example.invalid',announcementId:'ann',stages:[],tracking:{enabled:true,query:title}}));
  store.put('old-exam','exam',schemas.exam.parse({title:'旧日历',type:'选调',url:'',archived:true,stages:[]}));
  for(const [id,examId] of [['unread','exam'],['historical','old-exam']])store.put(id,'agent_turn',schemas.agent_turn.parse({createdAt:new Date().toISOString(),notice:true,done:true,examId,reply:'合成通知'}));
  assert.equal(store.snapshot().agentUnread,1);assert.equal(conversation(store).filter(t=>t.noticeUnread).length,1);
  assert.equal(markNoticesSeen(store,{ids:['unread','historical']}).changed,1);assert.equal(store.snapshot().agentUnread,0);assert.equal(store.get('historical').seen,false);
  store.put('chosen','job',{title:'测试岗位',announcementId:'ann',status:'关注'});
  for(const key of ['last-auto-crawl','last-auto-follow','last-auto-backup'])store.setSetting(key,todayCN());
  const {id}=queueTurn(store,{id:randomUUID(),text:'取消关注湖南定向，并删除其日历'});await runWorkerTick(store,config);
  assert.equal(store.get(id).done,true);assert.equal(store.get('chosen').status,'未选择');assert.equal(store.get('exam').archived,true);
  assert.equal(store.prepare('SELECT COUNT(*) n FROM ai_requests').get().n,0);
  console.log(JSON.stringify({passed:true,typedFailures:true,cooldown:true,offlineManagement:true,unreadConsistency:true,scopedRead:true,externalAICalls:0,productionDataUsed:false}));
}finally{store.db.close();}
