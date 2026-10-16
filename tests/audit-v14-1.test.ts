import {describe,it,expect,afterEach,vi} from 'vitest';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../backend/db.ts';
import {calendarCandidates} from '../backend/job-actions.ts';
import {goalSchema} from '../shared/model.ts';
import {api} from '../src/api.ts';

const stores:Store[]=[];
function fixture(){
  mkdirSync('.check/v14-1-audit/tests',{recursive:true});
  const store=new Store(mkdtempSync(resolve('.check/v14-1-audit/tests/case-')));stores.push(store);
  const stage=(id:string,label:string,date:string)=>({id,label,date,time:'',evidence:'示例公告日期',inferredYear:false});
  const candidates=[stage('start','报名开始','2026-10-01'),stage('results','成绩查询',''),stage('interview','面试','2026-12-01')];
  const ann=store.put('audit:notice','announcement',{title:'湖北省2027年选调生招录公告',type:'选调',url:'https://example.invalid/notice',candidates,status:'pending'});
  const exam={title:'岗位 11',calendarKind:'exam',type:'选调',province:'湖北',url:ann.url,notes:'',stages:candidates};
  return {store,ann,exam};
}
afterEach(()=>{for(const store of stores.splice(0))store.db.close();vi.unstubAllGlobals();});

describe('calendar imports from both entry points',()=>{
  it('keeps unpublished dates without importing interview or trusting a passed flag in an import',()=>{
    const {store,ann,exam}=fixture();
    const result=store.accept(ann.id,ann.version,{...exam,tracking:{query:'test',passed:true,enabled:true}});
    const saved=store.get(result.id);
    expect(saved.title).toBe(ann.title);
    expect(saved.stages.map((s:any)=>s.label)).toEqual(['报名开始','成绩查询']);
    expect(saved.stages[1]).toMatchObject({date:'',origin:'ai',milestone:'results'});
    expect(saved.tracking).toMatchObject({passed:false,enabled:true});
    expect(calendarCandidates(ann).map((s:any)=>s.label)).toEqual(['报名开始']);
  });
  it('preserves deliberate date edits and an explicit choice to disable following',()=>{
    const {store,ann,exam}=fixture();
    const result=store.accept(ann.id,ann.version,{...exam,stages:[{...exam.stages[0],date:'2026-10-02'}],tracking:{query:'test',enabled:false}});
    const saved=store.get(result.id);
    expect(saved.stages[0]).toMatchObject({date:'2026-10-02',manualEdited:true,origin:'manual'});
    expect(saved.tracking).toMatchObject({enabled:false,suppressed:['results']});
  });
  it('does not accept an import containing only later stages or invent a date',()=>{
    const {store,ann,exam}=fixture();
    expect(()=>store.accept(ann.id,ann.version,{...exam,stages:[exam.stages[2]]})).toThrow('请至少填写');
    expect(store.list('exam')).toHaveLength(0);
    expect(store.get(ann.id).status).toBe('pending');
  });
  it('protects an existing Agent calendar even when it uses a different identity and is archived',()=>{
    const {store,ann,exam}=fixture();
    store.put('agent:calendar','exam',{...exam,announcementId:ann.id,archived:true});
    expect(()=>store.accept(ann.id,ann.version,exam)).toThrow('已加入日历');
    expect(store.list('exam')).toHaveLength(1);
    expect(store.get('agent:calendar').archived).toBe(true);
  });
  it('keeps stale requests from overwriting the calendar or announcement',()=>{
    const {store,ann,exam}=fixture();
    store.put(ann.id,'announcement',{...ann,status:'ignored'},ann.version);
    expect(()=>store.accept(ann.id,ann.version,exam)).toThrow('公告已更新');
    expect(store.list('exam')).toHaveLength(0);
    expect(store.get(ann.id).status).toBe('ignored');
  });
});

describe('actionable form errors',()=>{
  it('explains an invalid goal in Chinese while retaining support for fractional targets',()=>{
    const goal={title:'学习',total:0,completed:0,unit:'小时',due:'',notes:''};
    const parsed=goalSchema.safeParse(goal);
    expect(parsed.success).toBe(false);
    if(!parsed.success)expect(parsed.error.issues[0].message).toBe('目标总量须大于 0');
    expect(goalSchema.safeParse({...goal,total:0.25}).success).toBe(true);
  });
  it('distinguishes a wrong password from an expired session',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:'账号或密码不正确'}),{status:401})));
    await expect(api('/login',{method:'POST'})).rejects.toThrow('账号或密码不正确');
    await expect(api('/state')).rejects.toThrow('登录已过期，请重新登录');
  });
});
