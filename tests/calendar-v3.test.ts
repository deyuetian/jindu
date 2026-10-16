import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {Store} from '../backend/db.ts';
import {callAI} from '../backend/ai.ts';
import {queueTurn,runTurn,followExam,explicitPass} from '../backend/agent.ts';
import {gatherSources,selectSources} from '../backend/agent-sources.ts';
import {majorHierarchy,matchMajor,type MajorRequirement} from '../shared/majors.ts';
import type {Config} from '../backend/config.ts';
vi.mock('../backend/ai.ts',()=>({callAI:vi.fn()}));
vi.mock('../backend/agent-sources.ts',async original=>({...await original<typeof import('../backend/agent-sources.ts')>(),gatherSources:vi.fn()}));
let store:Store,config:Config;
beforeEach(()=>{
  mkdirSync('.check/tests',{recursive:true});config={dataDir:mkdtempSync(resolve('.check/tests/calendar-v3-')),origin:'http://127.0.0.1',host:'127.0.0.1',port:0,adminUsername:'test',passwordHash:'unused',masterKey:randomBytes(32).toString('hex'),python:process.env.JINDU_TEST_PYTHON||'python',distDir:resolve('dist')};
  store=new Store(config.dataDir);vi.mocked(callAI).mockReset();vi.mocked(gatherSources).mockReset();
});
afterEach(()=>store.db.close());
async function send(text:string,plan:any) {
  const {id}=queueTurn(store,{id:randomUUID(),text});vi.mocked(callAI).mockResolvedValueOnce(JSON.stringify(plan));
  await runTurn(store,config,id);store.db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(id);return store.get(id);
}
const create={intent:'calendar_create',title:'读书会',stages:[{label:'开始',date:'2026-09-25',time:'14:00'},{label:'结束',date:'2026-09-25',time:'16:00'}]};
describe('personal calendar assistant',()=>{
  it('creates once, edits only requested fields, lists tasks and appointments, cancels and undoes without searching',async()=>{
    const turn=await send('9月25日下午2点到4点读书会，记到日历',create),exam=store.list('exam')[0];
    expect(exam.calendarKind).toBe('personal');expect(exam.tracking).toBeUndefined();
    await runTurn(store,config,turn.id);expect(store.list('exam')).toHaveLength(1);
    await send('读书会改到26日，时刻不变',{intent:'calendar_update',examId:exam.id,changes:exam.stages.map((s:any)=>({id:s.id,date:'2026-09-26'}))});
    const changed=store.get(exam.id);expect(changed.stages.map((s:any)=>s.time)).toEqual(['14:00','16:00']);
    expect(changed.stages.map((s:any)=>s.label)).toEqual(['开始','结束']);
    store.save('task',{title:'交报告',category:'日常',due:'2026-09-26',time:'18:00',priority:'普通',done:false,notes:''});
    const listed=await send('26号有哪些安排',{intent:'calendar_list',from:'2026-09-26',to:'2026-09-26'});
    expect(listed.reply).toContain('交报告');expect(listed.reply).toContain('读书会');
    const cancelled=await send('取消读书会',{intent:'calendar_cancel',examId:exam.id});expect(store.get(exam.id).archived).toBe(true);
    await send('撤销取消',{intent:'undo',turnId:cancelled.id});expect(store.get(exam.id).archived).toBe(false);
    await followExam(store,config,exam.id);expect(gatherSources).not.toHaveBeenCalled();
  });
  it('anchors relative dates to message creation, not a later queue processing date',async()=>{
    const {id}=queueTurn(store,{id:randomUUID(),text:'明天下午三点开组会'}),t=store.get(id);
    store.put(id,'agent_turn',{...t,createdAt:'2026-09-20T18:00:00.000Z'},t.version);
    vi.mocked(callAI).mockResolvedValue(JSON.stringify({intent:'clarify',reply:'请补充组会结束时刻或仅记录开始'}));await runTurn(store,config,id);
    expect(JSON.stringify(vi.mocked(callAI).mock.calls[0][2])).toContain('2026-09-21');
  });
  it('rejects unknown node ids and protects later manual edits from undo',async()=>{
    await send('建立读书会',create);const e=store.list('exam')[0];
    const failed=await send('改期',{intent:'calendar_update',examId:e.id,changes:[{id:'foreign',date:'2026-10-01'}]});
    expect(failed.reply).toContain('没有找到');expect(store.get(e.id).version).toBe(e.version);
    const changed=await send('改名',{intent:'calendar_update',examId:e.id,title:'周五读书会'});
    const current=store.get(e.id);store.save('exam',{...current,notes:'手动备注'},e.id,current.version);
    await expect(send('撤销',{intent:'undo',turnId:changed.id})).rejects.toThrow('此后已有修改');
    expect(store.get(e.id).notes).toBe('手动备注');
  });
  it('clarifies invalid date order and never turns another person passing into authorization',async()=>{
    const reply=await send('建日程',{...create,stages:[create.stages[1],{...create.stages[0],time:'17:00'}]});
    expect(reply.reply).toContain('结束不能早于开始');expect(store.list('exam')).toHaveLength(0);
    for(const text of ['我知道小王通过了考试','我听到他笔试通过了','如果我通过了笔试'])expect(explicitPass(text)).toBe(false);
    expect(explicitPass('我已通过浙江选调考试的笔试')).toBe(true);
  });
  it('does not apply an update bundled into cancellation and atomically records an undo',async()=>{
    const first=await send('建立读书会',create);const e=store.get(first.examId);
    const mixed=await send('取消结束节点',{intent:'calendar_cancel',examId:e.id,stageIds:[e.stages[1].id],changes:[{id:e.stages[0].id,date:'2026-09-24'}]});
    expect(mixed.reply).toContain('尚未修改');expect(store.get(e.id).stages).toEqual(e.stages);
    const {id}=queueTurn(store,{id:randomUUID(),text:'撤销上一次'});vi.mocked(callAI).mockResolvedValueOnce(JSON.stringify({intent:'undo'}));
    const original=store.put.bind(store);const fault=vi.spyOn(store,'put').mockImplementation((recordId,kind,data,version)=>{if(recordId===id&&data.done)throw new Error('simulated interruption');return original(recordId,kind,data,version);});
    await expect(runTurn(store,config,id)).rejects.toThrow('simulated interruption');fault.mockRestore();
    expect(store.get(e.id).archived).toBe(false);expect(store.get(first.id).undone).toBe(false);
    await runTurn(store,config,id);expect(store.get(e.id).archived).toBe(true);expect(store.get(first.id).undone).toBe(true);expect(store.get(id).done).toBe(true);
  });
});
describe('professional catalogues and evidence',()=>{
  const edu=[{level:'本科',major:'土地资源管理',code:'120404'},{level:'硕士',major:'土壤学',code:'090301'}];
  const profiles=[{id:'mine',education:edu,includeUnrestricted:false}];
  const requirement=(v:Partial<MajorRequirement>):MajorRequirement=>({levels:[],names:[],codes:[],unrestricted:false,evidence:'',catalog:'',...v});
  const match=(v:Partial<MajorRequirement>,p=profiles)=>{const r=requirement(v);return matchMajor([r],p,r.evidence);};
  it('uses degree-specific verified parent categories and detects the old wrong code',()=>{
    expect(majorHierarchy({...edu[0],code:'120405'}).verified).toBe(false);
    expect(majorHierarchy(edu[0])).toMatchObject({category:'公共管理类',categoryCode:'1204',disciplineCode:'12'});
    expect(majorHierarchy(edu[1])).toMatchObject({category:'农业资源与环境',categoryCode:'0903',disciplineCode:'09'});
    for(const name of ['土地资源管理','公共管理类','管理学'])expect(match({levels:['本科'],names:[name],evidence:'本科专业要求：'+name}).status).toBe('matched');
    for(const code of ['090301','0903','09'])expect(match({levels:['硕士'],codes:[code],evidence:'硕士专业代码：'+code}).status).toBe('matched');
    expect(match({levels:['硕士'],codes:['1204'],evidence:'硕士专业代码：1204'}).status).toBe('excluded');
    expect(match({levels:['本科'],names:['公共管理类'],catalog:'某省公务员专业目录',evidence:'本科要求：公共管理类'}).status).toBe('unknown');
  });
  it('never promotes unsupported evidence, adjacent codes or unrelated majors',()=>{
    expect(matchMajor([requirement({names:['土地资源管理'],evidence:'岗位要求土地资源管理'})],profiles,'岗位要求计算机科学与技术').status).toBe('unknown');
    expect(match({codes:['120405'],evidence:'本科招聘代码：120405',levels:['本科']}).status).toBe('excluded');
    expect(match({names:['计算机科学与技术'],evidence:'本科招聘：计算机科学与技术',levels:['本科']}).status).toBe('excluded');
    expect(match({names:['土壤学'],evidence:'博士专业为土壤学',levels:['博士']}).status).toBe('excluded');
    expect(match({names:[],evidence:'农学相关专业'}).status).toBe('unknown');
    expect(match({names:['公共管理类'],evidence:'本科公共管理类（不含土地资源管理）',levels:['本科']}).status).toBe('excluded');
    expect(match({names:['公共管理类'],evidence:'硕士专业要求：公共管理类'}).status).toBe('unknown');
    expect(match({names:['土地资源管理'],evidence:'本科土地资源管理且硕士计算机科学与技术',levels:['本科']}).status).toBe('unknown');
    expect(match({names:['土地资源管理'],evidence:'要求土地资源管理'},[]).status).toBe('unknown');
    expect(match({names:['公共管理类'],evidence:'本科公共管理类，不含城市管理、土地资源管理专业',levels:['本科']}).status).toBe('unknown');
    expect(match({names:['公共管理类'],evidence:'本科公共管理类（1204），不含120404',levels:['本科']}).status).toBe('excluded');
  });
  it('matches unrestricted positions independently of preferences and rechecks profile changes',()=>{
    expect(match({unrestricted:true,evidence:'本岗位专业不限'}).status).toBe('unrestricted');
    expect(match({unrestricted:true,evidence:'本岗位专业不限'},[{...profiles[0],includeUnrestricted:true}]).status).toBe('unrestricted');
    store.put('ann','announcement',{title:'招聘',body:'专业要求',analysisStatus:'done'});
    store.put('job','job',{title:'岗位',announcementId:'ann',majorStatus:'matched',match:'符合'});
    const p=store.save('profile',{title:'本人',education:edu});
    expect(p.education[0].categoryCode).toBe('1204');expect(p.education[1].categoryCode).toBe('0903');
    expect(store.get('job').majorStatus).toBe('unknown');expect(store.db.prepare("SELECT state FROM jobs WHERE id='analyze:ann'").get()).toBeUndefined();
  });
});
describe('repeats and source selection',()=>{
  it('changes future repeats to weekly, carries time and priority, retains history and avoids duplicate dates',()=>{
    const first=store.save('task',{title:'学习',category:'学习',due:'2026-09-20',time:'09:00',priority:'普通',done:false,notes:'',repeat:'daily'});
    store.repeat('2026-09-22');
    store.save('task',{...first,repeat:'weekly',time:'15:00',priority:'重要'},first.id,first.version);
    store.repeat('2026-09-27');store.repeat('2026-09-27');
    const all=store.list('task');expect(all.map(t=>t.due).sort()).toEqual(['2026-09-20','2026-09-21','2026-09-22','2026-09-27']);
    expect(all.find(t=>t.due==='2026-09-27')).toMatchObject({time:'15:00',priority:'重要'});
    const historic=all.find(t=>t.due==='2026-09-21');store.save('task',{...historic,done:true},historic.id,historic.version);
    store.repeat('2026-10-04');expect(store.list('task').find(t=>t.due==='2026-10-04')).toMatchObject({repeat:'weekly',time:'15:00',priority:'重要'});
  });
  it('includes fresh official material despite long local files and fingerprints changes outside the excerpt',()=>{
    const source=(id:string,text:string)=>({id,text,title:id,url:'https://example.gov.cn/'+id,published:''});
    const local=[source('local','旧'.repeat(200000))],fresh=[source('new','新的官方更正'+ '正文'.repeat(60000))];
    const a=selectSources(fresh,local);expect(a.docs[0].id).toBe('new');expect(a.docs[0].text).toContain('新的官方更正');expect(a.docs.reduce((n,d)=>n+d.text.length,0)).toBeLessThanOrEqual(100000);
    const b=selectSources([{...fresh[0],text:fresh[0].text+'末尾更正'}],local);expect(b.fingerprint).not.toBe(a.fingerprint);expect(a.truncated).toBe(true);
  });
});
