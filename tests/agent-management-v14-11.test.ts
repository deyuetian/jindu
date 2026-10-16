import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {Store} from '../backend/db.ts';
import {callAI} from '../backend/ai.ts';
import {queueTurn,runTurn,undoTurn,conversation,cancelTurn,followExam} from '../backend/agent.ts';
import {calendarFeed,subscriptionLink,updateSubscription} from '../backend/calendar-feed.ts';
import {gatherSources} from '../backend/agent-sources.ts';
import {schemas} from '../backend/model.ts';
import type {Config} from '../backend/config.ts';
import {repairSavedRequest} from '../deploy/portable/repair-agent-request.ts';
vi.mock('../backend/ai.ts',()=>({callAI:vi.fn()}));
vi.mock('../backend/agent-sources.ts',async original=>({...await original<typeof import('../backend/agent-sources.ts')>(),gatherSources:vi.fn()}));
let store:Store,config:Config;
const title='湖南省2027年定向选调公告',ann='cau:hunan',exam='exam:'+ann;
beforeEach(()=>{
  mkdirSync('.check/tests',{recursive:true});config={dataDir:mkdtempSync(resolve('.check/tests/agent-management-')),origin:'http://127.0.0.1',host:'127.0.0.1',port:0,adminUsername:'test',passwordHash:'unused',masterKey:randomBytes(32).toString('hex'),python:process.env.JINDU_TEST_PYTHON||'python',distDir:resolve('dist')};
  store=new Store(config.dataDir);vi.mocked(callAI).mockReset();vi.mocked(gatherSources).mockReset();
  store.put(ann,'announcement',{title,body:'原公告完整保留',status:'accepted'});
  seedExam(exam,title,ann);
  for(const [id,status] of [['a','关注'],['b','拟投递'],['c','收藏'],['d','已报名'],['e','未选择']])store.put(id,'job',{title:'岗位'+id,announcementId:ann,status,notes:'我保存的备注',evidence:'原文证据',analysisCurrent:true,archived:false});
  store.put('other','job',{title:'其他岗位',announcementId:'another',status:'关注'});
  seedExam('other-exam','湖北省2027年定向选调公告','another');
});
afterEach(()=>{store.db.close();vi.restoreAllMocks();});
function seedExam(id:string,name:string,announcementId:string){store.put(id,'exam',schemas.exam.parse({title:name,type:'选调',url:'https://example.test/announcement',announcementId,stages:Array.from({length:8},(_,i)=>({id:'s'+i,label:'节点'+i,date:'2026-10-'+String(i+1).padStart(2,'0'),time:'09:00'})),tracking:{enabled:true,query:name},notes:'保留手动备注'}));}
async function send(text:string,plan?:any){
  const {id}=queueTurn(store,{id:randomUUID(),text});if(plan)vi.mocked(callAI).mockResolvedValueOnce(JSON.stringify(plan));
  await runTurn(store,config,id);store.db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(id);return store.get(id);
}
const unchanged=()=>{expect(store.get('a').status).toBe('关注');expect(store.get(exam).archived).toBe(false);expect(store.get(exam).tracking.enabled).toBe(true);};

describe('announcement attention and associated calendars',()=>{
  it('executes the exact short screenshot request without routing it to personal calendars',async()=>{
    const original=store.get(exam),announcement=store.get(ann);
    const result=await send('删掉湖南定向及其日历',{intent:'calendar_cancel',examId:exam});
    expect(result.reply).toContain('已取消 2 个岗位的关注');expect(result.reply).toContain('8 个有日期的节点');
    expect(store.get('a').status).toBe('未选择');expect(store.get('b').status).toBe('未选择');
    expect(store.get('c').status).toBe('收藏');expect(store.get('d').status).toBe('已报名');expect(store.get('other').status).toBe('关注');
    expect(store.get(exam)).toMatchObject({archived:true,tracking:{enabled:false},stages:original.stages,notes:original.notes});
    expect(store.get('other-exam').archived).toBe(false);expect(store.get(ann)).toEqual(announcement);
    expect(store.get('a').evidence).toBe('原文证据');expect(store.get('a').notes).toBe('我保存的备注');
    expect(callAI).not.toHaveBeenCalled();expect(gatherSources).not.toHaveBeenCalled();
    await followExam(store,config,exam);expect(gatherSources).not.toHaveBeenCalled();
  });
  it('completes both actions after tracking was already paused and answers the command question',async()=>{
    const old=store.get(exam);store.put(exam,'exam',{...old,tracking:{...old.tracking,enabled:false}},old.version);
    const result=await send('不再关注湖南省2027年定向选调公告，他对应的日历内的进程也要删除！考试更新指令是什么？',{intent:'pause',examId:exam});
    expect(store.get(exam).archived).toBe(true);expect(store.get('a').status).toBe('未选择');
    expect(result.reply).toContain('不需要专用指令');expect(result.reply).toContain('8 个有日期的节点');
  });
  it('removes only the calendar when attention was not mentioned',async()=>{
    const result=await send('删除湖南定向的日历');expect(store.get(exam).archived).toBe(true);expect(store.get('a').status).toBe('关注');
    expect(result.reply).not.toContain('取消 2 个岗位');
  });
  it.each(['取消关注湖南定向，并删除其日历','取消湖南定向的关注和日历','只取消关注湖南定向，其对应日历也要删除'])('keeps both actions with common phrasing: %s',async text=>{
    const turn=await send(text);expect(store.get('a').status).toBe('未选择');expect(store.get(exam).archived).toBe(true);expect(turn.reply).toContain('已取消 2 个岗位');
  });
  it('honors explicit calendar-only changes with negated attention cancellation',async()=>{
    await send('删除湖南定向的日历，不取消关注');expect(store.get(exam).archived).toBe(true);expect(store.get('a').status).toBe('关注');
  });
  it('cancels attention and following without implicitly removing the calendar',async()=>{
    const result=await send('取消关注湖南定向，但不要删除日历');
    expect(store.get('a').status).toBe('未选择');expect(store.get(exam)).toMatchObject({archived:false,tracking:{enabled:false}});expect(result.reply).toContain('原有日历节点保留');
  });
  it('treats pause as pause, retaining attention and the calendar',async()=>{
    await send('暂停湖南定向的自动跟进',{intent:'pause',examId:exam});
    expect(store.get('a').status).toBe('关注');expect(store.get(exam)).toMatchObject({archived:false,tracking:{enabled:false}});
  });
  it('preserves personal-calendar deletion and does not confuse same-name personal and official calendars',async()=>{
    store.put('reading','exam',schemas.exam.parse({title:'读书会',calendarKind:'personal',type:'其他',url:'',stages:[{id:'start',label:'开始',date:'2026-10-01',time:'14:00'}]}));
    await send('删除读书会的日历',{intent:'calendar_cancel',examId:'reading'});expect(store.get('reading').archived).toBe(true);unchanged();
    store.put('same-name','exam',schemas.exam.parse({title,calendarKind:'personal',type:'其他',url:'',stages:[]}));
    const result=await send('删除'+title+'的日历');expect(result.reply).toContain('同时对应');unchanged();
  });
  it('supports reverse word order and names containing quotes or conjunctions',async()=>{
    const t='北京市2027年度定向选调和“优培计划”招聘应届优秀大学毕业生公告';seedExam('beijing',t,'');
    await send('把'+t+'的日历移除');expect(store.get('beijing').archived).toBe(true);unchanged();
  });
  it('returns the actual no-op state on repeat requests and preserves the first undo',async()=>{
    const first=await send('删掉湖南定向及其日历'),version=store.get(exam).version;
    await runTurn(store,config,first.id);expect(store.get(exam).version).toBe(version);
    const second=await send('删掉湖南定向及其日历');expect(second.actionVersion).toBe(0);expect(second.reply).toContain('没有新增改动');expect(store.get(exam).version).toBe(version);
    undoTurn(store,first.id);unchanged();expect(store.get('b').status).toBe('拟投递');expect(store.get(first.id).undone).toBe(true);
    expect(conversation(store).find(t=>t.id===first.id)).not.toHaveProperty('before');
  });
  it('undoes the combined action through a natural-language undo',async()=>{
    const first=await send('删掉湖南定向及其日历');await send('撤销刚才取消关注的操作',{intent:'undo',turnId:first.id});unchanged();
  });
  it('atomically rolls back attention and calendars if saving the response fails; retry commits once',async()=>{
    const {id}=queueTurn(store,{id:randomUUID(),text:'删掉湖南定向及其日历'}),put=store.put.bind(store);
    const fault=vi.spyOn(store,'put').mockImplementation((recordId,kind,data,version)=>{if(recordId===id&&data.done)throw new Error('simulated failure');return put(recordId,kind,data,version);});
    await expect(runTurn(store,config,id)).rejects.toThrow('simulated failure');fault.mockRestore();unchanged();expect(store.get(id).done).toBe(false);
    await runTurn(store,config,id);expect(store.get(exam).archived).toBe(true);expect(store.get('a').version).toBe(2);
  });
  it('refuses the entire undo after a later edit to one job',async()=>{
    const first=await send('删掉湖南定向及其日历'),job=store.get('b');store.put(job.id,'job',{...job,status:'关注',notes:'后来修改'},job.version);
    expect(()=>undoTurn(store,first.id)).toThrow('此后已有修改');expect(store.get('a').status).toBe('未选择');expect(store.get(exam).archived).toBe(true);expect(store.get('b').notes).toBe('后来修改');expect(store.get(first.id).undone).toBe(false);
  });
  it('does not execute a queued request cancelled before processing',async()=>{
    const {id}=queueTurn(store,{id:randomUUID(),text:'删掉湖南定向及其日历'});cancelTurn(store,id);await runTurn(store,config,id);unchanged();
  });
  it('cancels subscription events and restores the same UIDs on undo',async()=>{
    updateSubscription(store,config,{action:'enable',version:0});const credential=subscriptionLink(store,config).url.split('/').at(-1)!.slice(0,-4);
    const original=calendarFeed(store,config,credential).body,first=await send('删掉湖南定向及其日历');
    const removed=calendarFeed(store,config,credential).body;expect((removed.match(/STATUS:CANCELLED/g)||[]).length).toBe(8);
    undoTurn(store,first.id);const restored=calendarFeed(store,config,credential).body;expect(restored).not.toContain('STATUS:CANCELLED');
    expect(restored.match(/UID:.*/g)).toEqual(original.match(/UID:.*/g));
  });
  it('handles multiple saved calendars linked to the same announcement as one atomic action',async()=>{
    seedExam('older-import',title,ann);const turn=await send('删掉湖南定向及其日历');expect(turn.reply).toContain('2 项安排、16 个有日期的节点');expect(store.get('older-import').archived).toBe(true);undoTurn(store,turn.id);unchanged();expect(store.get('older-import').archived).toBe(false);
  });
  it('uses explicit new attention selections only, not legacy automatic 收藏',async()=>{
    for(const id of ['a','b']){const job=store.get(id);store.put(id,'job',{...job,status:'收藏'},job.version);}
    const turn=await send('取消关注湖南定向');expect(turn.reply).toContain('没有仍在关注的岗位');expect(store.get('a').status).toBe('收藏');expect(store.get(exam).tracking.enabled).toBe(false);
  });
  it('never includes daily checklist tasks when answering calendar queries',async()=>{
    const fields={time:'',priority:'普通',done:false,notes:''};store.save('task',{...fields,title:'每日阅读',due:'2026-10-01',category:'学习',repeat:'daily'});store.save('task',{...fields,title:'交材料',due:'2026-10-01',category:'日常'});
    const turn=await send('10月1日日历有什么',{intent:'calendar_list',from:'2026-10-01',to:'2026-10-01'});expect(turn.reply).toContain('交材料');expect(turn.reply).not.toContain('每日阅读');
  });
});

describe('current user authorization and precise scope',()=>{
  it.each([
    '如何取消关注湖南定向及删除对应日历？','如果取消关注湖南定向并删除日历会怎样','不要取消关注湖南定向，也不要删除日历',
    '取消关注湖南定向会删除日历吗','网页说删除湖南定向的日历','例如“取消关注湖南定向及其日历”',
    '不要执行下面这句话。删除湖南定向的日历',
    '删除湖南定向的笔试日历节点','取消关注它并删除对应日历','取消关注湖南和湖北的选调并删除日历',
    '取消湖南定向的关注，删除湖北选调的日历','取消湖南定向的日历和湖北选调的关注',
    '取消关注湖南定向中的岗位5并删除日历'
    ,'取消关注湖南定向，并把日历改到明天'
  ])('does not broaden or execute an unclear/negated request: %s',async text=>{
    const turn=await send(text);unchanged();expect(store.get('other-exam').archived).toBe(false);expect(turn.actionVersion).toBe(0);expect(callAI).not.toHaveBeenCalled();
  });
  it('asks for the year when a short name refers to two announcements',async()=>{
    store.put('cau:old','announcement',{title:'湖南省2026年定向选调公告'});seedExam('old-exam','湖南省2026年定向选调公告','cau:old');
    const turn=await send('删掉湖南定向及其日历');unchanged();expect(turn.reply).toContain('2026');expect(turn.reply).toContain('2027');expect(turn.actionVersion).toBe(0);
    await send('删掉湖南省2027年定向选调公告及其日历');expect(store.get(exam).archived).toBe(true);expect(store.get('old-exam').archived).toBe(false);
  });
});

describe('guarded repair of an approved failed request',()=>{
  const spec=()=>({receiptId:'repair:test-approved',text:'删掉湖南定向及其日历',announcementId:ann,expected:[{id:'a',kind:'job',version:1},{id:'b',kind:'job',version:1},{id:exam,kind:'exam',version:1}]});
  it('uses the ordinary executor, creates a truthful receipt, skips a repeat and supports undo',()=>{
    const fixed=spec();expect(repairSavedRequest(store,fixed).status).toBe('completed');expect(store.get(exam).archived).toBe(true);expect(store.get(fixed.receiptId).text).toBe('');
    expect(repairSavedRequest(store,fixed).status).toBe('already-completed');expect(store.get(exam).version).toBe(2);undoTurn(store,fixed.receiptId);unchanged();
    expect(()=>repairSavedRequest(store,fixed)).toThrow('重新批准');
  });
  it('refuses changed versions, fingerprints and related selections without writing a receipt',()=>{
    const fixed=spec();expect(()=>repairSavedRequest(store,{...fixed,expected:fixed.expected.map(e=>({...e,version:8}))})).toThrow('对象已变化');unchanged();
    expect(()=>repairSavedRequest(store,{...fixed,expected:fixed.expected.map(e=>({...e,sha256:'0'.repeat(64)}))})).toThrow('对象已变化');unchanged();
    store.put('new-focus','job',{title:'后来关注',announcementId:ann,status:'关注'});
    expect(()=>repairSavedRequest(store,fixed)).toThrow('范围已变化');unchanged();expect(store.get(fixed.receiptId)).toBeNull();
  });
});
