// Synthetic records only. No network, production config, AI provider or worker.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../../backend/db.ts';
import {schemas} from '../../backend/model.ts';
import {queueTurn,runTurn,undoTurn,conversation} from '../../backend/agent.ts';
import {repairSavedRequest} from './repair-agent-request.ts';
import {spawnSync} from 'node:child_process';

const store=new Store(mkdtempSync(join(tmpdir(),'jindu-agent-management-')));
const title='湖南省2027年定向选调公告',ann='synthetic-ann',exam='exam:'+ann;
const config={origin:'http://127.0.0.1',dataDir:store.dir};
try {
  store.put(ann,'announcement',{title,body:'合成测试公告'});
  store.put(exam,'exam',schemas.exam.parse({title,type:'选调',url:'',announcementId:ann,stages:[{id:'registration',label:'报名截止',date:'2026-10-01',time:'18:00'}],tracking:{enabled:false,query:title}}));
  store.put('chosen','job',{title:'关注岗位',announcementId:ann,status:'关注',notes:'保留我的备注'});
  store.put('legacy','job',{title:'历史自动收藏',announcementId:ann,status:'收藏'});
  const original=store.get(exam);
  const {id}=queueTurn(store,{id:randomUUID(),text:'不再关注湖南省2027年定向选调公告，他对应的日历内的进程也要删除！考试更新指令是什么？'});
  await runTurn(store,config,id);
  assert.equal(store.get('chosen').status,'未选择');assert.equal(store.get('legacy').status,'收藏');
  assert.equal(store.get(exam).archived,true);assert.match(store.get(id).reply,/已取消 1 个岗位/);
  assert.match(store.get(id).reply,/1 个有日期的节点/);assert.match(store.get(id).reply,/不需要专用指令/);
  await runTurn(store,config,id);assert.equal(store.get('chosen').version,2);
  undoTurn(store,id);assert.equal(store.get('chosen').status,'关注');assert.equal(store.get('chosen').notes,'保留我的备注');
  assert.deepEqual(store.get(exam).stages,original.stages);assert.equal(store.get(exam).archived,false);assert.equal(store.get(exam).tracking.enabled,false);
  assert.equal(conversation(store)[0].before,undefined);
  // Exercise the deployment helper from the runtime image, rather than relying
  // on its presence in the source archive. Import failure blocks cutover.
  const spec={receiptId:'repair:synthetic-container-check',text:'删掉湖南定向及其日历',announcementId:ann,expected:[
    {id:'chosen',kind:'job',version:store.get('chosen').version},
    {id:exam,kind:'exam',version:store.get(exam).version}
  ]};
  assert.equal(repairSavedRequest(store,spec).status,'completed');
  assert.equal(store.get('chosen').status,'未选择');assert.equal(store.get(exam).archived,true);
  assert.equal(repairSavedRequest(store,spec).status,'already-completed');
  undoTurn(store,spec.receiptId);assert.equal(store.get('chosen').status,'关注');
  assert.deepEqual(store.get(exam).stages,original.stages);assert.equal(store.get(exam).archived,false);
  assert.equal(store.get('legacy').status,'收藏');
  // Invalid input must reach schema validation without opening any database.
  const cli=spawnSync(process.execPath,['--experimental-strip-types','deploy/portable/repair-agent-request.ts','--apply'],{input:'{}',encoding:'utf8'});
  assert.notEqual(cli.status,0);assert.match(cli.stderr,/ZodError/);assert.doesNotMatch(cli.stderr,/MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/);
  assert.equal(store.prepare('SELECT COUNT(*) n FROM ai_requests').get().n,0);
  console.log(JSON.stringify({passed:true,combinedAction:true,pausedCalendarRemoval:true,repeatSafe:true,atomicUndo:true,historyHidden:true,packagedRepairHelper:true,guardedRepairAndUndo:true,repairCliSchemaCheck:true,externalAICalls:0,productionDataUsed:false}));
} finally {store.db.close();}
