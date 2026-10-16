import { describe,it,expect,beforeEach,afterEach,vi } from 'vitest';
import { mkdtempSync,mkdirSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes,randomUUID } from 'node:crypto';
import { Store } from '../backend/db.ts';
import { saveAI,type Config } from '../backend/config.ts';
import { analyze } from '../backend/ai.ts';
import { requestPublic } from '../backend/net.ts';
import { tableSegments,prefilterRow } from '../backend/job-tables.ts';
import { eligibilityFactsSchema,eligibilityGroupsSchema,evaluateEligibility } from '../shared/eligibility.ts';
import { matchJob } from '../backend/matching.ts';
import { majorHierarchy } from '../shared/majors.ts';
import { recruitmentTurn } from '../backend/recruitment-agent.ts';
import { queueTurn,runTurn } from '../backend/agent.ts';

vi.mock('../backend/net.ts',async original=>({...await original<typeof import('../backend/net.ts')>(),requestPublic:vi.fn()}));
let store:Store,config:Config;
const fixture=JSON.parse(readFileSync(new URL('./fixtures/positions-v10.json',import.meta.url),'utf8'));
const education=[{level:'本科',major:'土地资源管理',code:'120404'},{level:'硕士',major:'土壤学',code:'090301'}];
const facts=eligibilityFactsSchema.parse({politicalStatus:'中共党员',freshGraduate:'yes',freshGraduateYear:'2027'});
const profiles=[{id:'profile',title:'申请档案',education,eligibility:facts}];
const body='全体报考者须为2027届应届毕业生。报名时在线提交推荐表（PDF）；资格复审提交毕业证复印件。';
beforeEach(()=>{
  mkdirSync('.check/v10/tests',{recursive:true});const dataDir=mkdtempSync(resolve('.check/v10/tests/case-'));
  store=new Store(dataDir);config={dataDir,host:'127.0.0.1',port:8899,origin:'http://127.0.0.1:8899',python:'unused',distDir:resolve('dist'),masterKey:randomBytes(32).toString('hex'),adminUsername:'fixture',passwordHash:'unused'};
  store.put('profile','profile',profiles[0]);
  saveAI(store,{baseUrl:'https://example.invalid/v1',model:'fixture',key:'fixture-not-a-real-key',dailyLimit:100},config);
  vi.mocked(requestPublic).mockReset();
});
afterEach(()=>store.db.close());
function seed(){store.put('ann','announcement',{title:'2027选调岗位',body,url:'https://example.edu.cn/jobs',published:'2026-09-21',contentHash:'one',fileIds:['file'],materialErrors:[],candidates:[]});store.db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?)').run('file','ann','岗位.xlsx','https://example.edu.cn/岗位.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',100,'digest',fixture.text,'');store.setSetting('workbook-v2:file',fixture);}
const response=(object:unknown)=>({status:200,body:Buffer.from(JSON.stringify({choices:[{message:{content:JSON.stringify(object)}}],usage:{prompt_tokens:20,completion_tokens:10}})),url:'',headers:{}});
const base={relevant:true,type:'选调',summary:'岗位筛选',uncertainties:[],dates:[],jobs:[],commonCoverage:'complete',applicationCoverage:'complete',commonEligibility:[],applicationItems:[]};
function model(rowOverrides?:(job:any)=>any){
  vi.mocked(requestPublic).mockImplementation(async (_url,options:any)=>{
    const text=JSON.parse(options.body).messages[1].content as string;
    if(text.includes('岗位行ID：')){
      const segments=await tableSegments(store,config,[{id:'file',name:'岗位.xlsx'}],profiles);
      const rows=segments.segments.flatMap(s=>s.rows||[]).filter(r=>text.includes(r.rowId));
      const jobs=rows.map(row=>{
        const master=row.text.includes('【报考专业 / 硕士】农学')?'农学':row.text.includes('农业资源与环境')?'农业资源与环境':'土壤学';
        const evidence=row.text.match(/【(?:报考专业 \/ 硕士|专业要求)】[^|]+/)?.[0].trim()||row.text;
        const party=row.text.includes('【政治面貌】中共党员')?'中共党员':row.text.includes('【政治面貌】群众')?'群众':'';
        const clause=party?'【政治面貌】'+party:'';
        const job={title:'专业技术',organization:row.organization,profileId:'profile',sourceRowId:row.rowId,match:'符合',reasons:'核对岗位',evidence:row.text,majorRequirements:[{levels:['硕士'],names:[master],evidence}],eligibilityCoverage:'complete',eligibilityRequirements:party?[{label:'政治面貌',mode:'all',evidence:clause,criteria:[{kind:'political',label:party,evidence:clause,accepted:[party]}]}]:[],applicationCoverage:'complete',applicationItems:[]};
        if(row.text.includes('【报考专业 / 本科】土地资源管理'))job.majorRequirements.push({levels:['本科'],names:['土地资源管理'],evidence:'【报考专业 / 本科】土地资源管理'});
        const experience=row.text.match(/【经历要求】(土壤调查[^|]+)/)?.[1]?.trim();
        if(experience)(job.eligibilityRequirements as any[]).push({label:'经历要求',mode:'all',evidence:experience,criteria:[{kind:'experience',label:experience,evidence:experience,accepted:['土壤调查'],minMonths:12,asOf:'2026-09-01'}]});
        return rowOverrides?rowOverrides(job):job;
      });
      return response({...base,jobs});
    }
    if(text.includes('正文：\n'+body))return response({...base,commonEligibility:[{label:'应届要求',mode:'all',evidence:'全体报考者须为2027届应届毕业生',criteria:[{kind:'freshGraduate',label:'2027届应届',evidence:'2027届应届毕业生',accepted:['2027']}]}],applicationItems:[{kind:'material',label:'推荐表',detail:'PDF',phase:'报名',method:'在线提交',evidence:'报名时在线提交推荐表（PDF）'},{kind:'material',label:'毕业证复印件',phase:'资格复审',evidence:'资格复审提交毕业证复印件'}]});
    return response(base);
  });
}
describe('spreadsheet recruitment workflow',()=>{
  it('filters all professional levels, preserves unknown references and excludes only closed unrelated lists',()=>{
    const field=(value:string)=>[{column:1,header:'专业要求',value}];
    for(const value of ['农学','农业资源与环境','土壤学','09','0903','090301','公共管理类','土地资源管理','120404'])expect(prefilterRow(field(value),profiles)).toBe('candidate');
    expect(prefilterRow(field('详见专业目录'),profiles)).toBe('review');expect(prefilterRow(field('计算机科学与技术'),profiles)).toBe('excluded');expect(prefilterRow(field('计算机科学与技术'),[])).toBe('review');
    expect(majorHierarchy(education[1]).category).toBe('农业资源与环境');
  });
  it('keeps headers and IDs for multiple sheets and avoids AI calls for unrelated rows',async()=>{
    seed();const result=await tableSegments(store,config,[{id:'file',name:'岗位.xlsx'}],profiles);
    expect(result.stats).toMatchObject({rows:4,candidates:3,excluded:1});expect(result.segments.flatMap(s=>s.rows||[]).map(r=>r.positionCode)).toEqual(['001','002','004']);expect(requestPublic).not.toHaveBeenCalled();
  });
  it('merges document requirements and application materials into distinct same-name posts without touching calendars',async()=>{
    seed();model();expect(await analyze(store,config,'ann',1)).toBe(false);
    const calls=vi.mocked(requestPublic).mock.calls.length;
    while(await analyze(store,config,'ann',1)===false){}
    expect(vi.mocked(requestPublic).mock.calls.length).toBeLessThanOrEqual(calls+4);
    const jobs=store.list('job');expect(jobs).toHaveLength(3);
    const first=jobs.find(j=>j.positionCode==='001'),second=jobs.find(j=>j.positionCode==='002');
    expect(first).toMatchObject({match:'符合',matchedLevel:'硕士',sourceRow:{sheet:'省直选调',row:4}});
    expect(first.applicationItems.map((i:any)=>[i.label,i.phase])).toEqual([['推荐表','报名'],['毕业证复印件','资格复审']]);expect(second.match).toBe('不符合');expect(first.id).not.toBe(second.id);expect(store.list('exam')).toHaveLength(0);
    const before=vi.mocked(requestPublic).mock.calls.length;await analyze(store,config,'ann');expect(vi.mocked(requestPublic).mock.calls.length).toBe(before);
    const p=store.get('profile');store.save('profile',{...p,eligibility:{...p.eligibility,politicalStatus:'群众'}},p.id,p.version);expect(store.get(first.id).match).toBe('不符合');expect(vi.mocked(requestPublic).mock.calls.length).toBe(before);
  });
  it('never borrows a political requirement from a neighboring row',async()=>{
    seed();model(job=>job.sourceRowId&&job.evidence.includes('【政治面貌】中共党员')?{...job,eligibilityRequirements:[{label:'群众',mode:'all',evidence:'【政治面貌】群众',criteria:[{kind:'political',label:'群众',evidence:'【政治面貌】群众',accepted:['群众']}]}]}:job);
    while(await analyze(store,config,'ann')===false){}expect(store.list('job').find(j=>j.positionCode==='001').match).toBe('待核对');
  });
  it('repairs cached table quotations at finalization without repeating model calls',async()=>{
    seed();model();await analyze(store,config,'ann');
    const work=store.getSetting<any>('analysis:ann',{});
    for(const result of work.results)for(const job of result.jobs.filter((j:any)=>j.sourceRowId))for(const r of job.majorRequirements)r.evidence='[原岗位行引用] '+r.evidence;
    store.setSetting('analysis:ann',work);const calls=vi.mocked(requestPublic).mock.calls.length;
    expect(await analyze(store,config,'ann')).toBe(true);
    expect(vi.mocked(requestPublic).mock.calls.length).toBe(calls);
    const first=store.list('job').find(j=>j.positionCode==='001');
    expect(first.majorStatus).toBe('matched');
    expect(first.majorRequirements.every((r:any)=>!r.evidence.startsWith('[原岗位行引用]'))).toBe(true);
    expect(store.getSetting<any>('analysis:ann',{}).index).toBe(work.index);
  });
  it('retains missing AI rows as unresolved instead of silently dropping them',async()=>{
    seed();model(job=>({...job,sourceRowId:'invented'}));while(await analyze(store,config,'ann')===false){}expect(store.list('job')).toHaveLength(3);expect(store.list('job').every(j=>j.match==='待核对')).toBe(true);
  });
  it('checks lower-degree application rules independently of professional matching',()=>{
    const evidence='本科土地资源管理专业';const job={majorRequirements:[{levels:['本科'],names:['土地资源管理'],evidence}],eligibilityRequirements:[],eligibilityCoverage:'complete',analysisIncomplete:false};
    expect(matchJob(job,profiles,evidence)).toMatchObject({majorStatus:'matched',match:'待核对',matchedLevel:'本科'});
    const rule='必须以最高学历报考';expect(matchJob({...job,degreePolicy:{policy:'highest',evidence:rule}},profiles,evidence+rule).match).toBe('不符合');
    const allow='允许以非最高学历报考';expect(matchJob({...job,degreePolicy:{policy:'any',evidence:allow}},profiles,evidence+allow).match).toBe('符合');
  });
  it('searches saved results without AI and requests clarification for ambiguous announcements',async()=>{
    seed();model();await analyze(store,config,'ann');vi.mocked(requestPublic).mockClear();
    const answer=await recruitmentTurn(store,config,{id:'turn',text:'查看2027选调岗位材料'},{intent:'recruitment_search',query:'2027选调岗位',terms:[],announcementId:'ann'});expect(answer.reply).toContain('推荐表');expect(requestPublic).not.toHaveBeenCalled();
    store.put('ann2','announcement',{title:'另一个2027选调岗位',body});const ambiguous=await recruitmentTurn(store,config,{id:'turn2',text:'筛选2027选调'},{intent:'recruitment_analyze',query:'2027选调',terms:[]});expect(ambiguous.reply).toContain('多个公告');
  });
  it('does not promote stale job rows after an attachment changes',()=>{
    const source='硕士土壤学专业';const result=matchJob({majorRequirements:[{levels:['硕士'],names:['土壤学'],evidence:source}],eligibilityRequirements:[],eligibilityCoverage:'complete',analysisIncomplete:false,analysisCurrent:false},profiles,source);expect(result.match).toBe('待核对');
  });
  it('does not ignore hard experience requirements that appear only in preparation items',()=>{
    const professional='硕士土壤学专业',experience='须有土壤调查工作经历';
    const result=matchJob({majorRequirements:[{levels:['硕士'],names:['土壤学'],evidence:professional}],eligibilityRequirements:[],eligibilityCoverage:'complete',analysisIncomplete:false,applicationItems:[{kind:'experience',label:'土壤调查经验',required:true,evidence:experience}]},profiles,professional+experience);
    expect(result.match).toBe('待核对');expect(result.eligibilityChecks.groups[0].label).toBe('土壤调查经验');
  });
  it('checks a matching highest degree before considering the preferred masters route',()=>{
    const source='硕士、博士均招土壤学专业，必须以最高学历报考';const result=matchJob({majorRequirements:[{levels:['硕士','博士'],names:['土壤学'],evidence:source}],eligibilityRequirements:[],eligibilityCoverage:'complete',analysisIncomplete:false,degreePolicy:{policy:'highest',evidence:'必须以最高学历报考'}},[{...profiles[0],education:[...education,{level:'博士',major:'土壤学',code:'090301'}]}],source);expect(result).toMatchObject({match:'符合',matchedLevel:'博士'});
  });
  it('routes a real agent turn to saved recruitment results, and loads bundled skills',async()=>{
    seed();model();await analyze(store,config,'ann');vi.mocked(requestPublic).mockReset().mockResolvedValue(response({intent:'recruitment_search',query:'2027选调岗位',announcementId:'ann',terms:[]}));
    const turn=queueTurn(store,{id:randomUUID(),text:'查看2027选调岗位的报名材料'});await runTurn(store,config,turn.id);
    expect(store.get(turn.id)).toMatchObject({done:true,reportAnnouncementId:'ann'});expect(store.get(turn.id).reply).toContain('推荐表');expect(store.list('exam')).toHaveLength(0);expect(JSON.parse((vi.mocked(requestPublic).mock.calls[0][1] as any).body).messages[0].content).toContain('岗位筛选与报考准备');
  });
});
describe('experience and certificates',()=>{
  const evidence='土壤调查工作满12个月，截至2026年9月1日';
  const group=eligibilityGroupsSchema.parse([{label:'工作经验',mode:'all',evidence,criteria:[{kind:'experience',label:'土壤调查工作',evidence,accepted:['土壤调查'],levels:['工作'],minMonths:12,asOf:'2026-09-01'}]}]);
  it('does not count an internship as work or pool short unrelated periods',()=>{
    const f=eligibilityFactsSchema.parse({experiencesStatus:'complete',experiences:[{name:'土壤调查',type:'实习',start:'2024-01-01',end:'2026-08-01'},{name:'土壤调查',type:'工作',start:'2026-01-01',end:'2026-08-01'}]});expect(evaluateEligibility(group,f,evidence,'2026-09-21').status).toBe('unmet');
  });
  it('requires dates and rejects expired certificates',()=>{
    const clause='报名须有土壤检测资格证';const groups=eligibilityGroupsSchema.parse([{label:'证书',mode:'all',evidence:clause,criteria:[{kind:'certificate',label:'土壤检测资格证',accepted:['土壤检测资格证'],evidence:clause}]}]);
    const f=eligibilityFactsSchema.parse({certificatesStatus:'complete',certificates:[{name:'土壤检测资格证',date:'2024-01-01',expires:'2025-12-31'}]});expect(evaluateEligibility(groups,f,clause,'2026-09-21').status).toBe('unmet');expect(evaluateEligibility(groups,eligibilityFactsSchema.parse({}),clause).status).toBe('missing');
  });
});
