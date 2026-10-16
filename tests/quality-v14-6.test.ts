import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../backend/db.ts';
import {saveAI,type Config} from '../backend/config.ts';
import {requestPublic} from '../backend/net.ts';
import {analyze} from '../backend/ai.ts';
import {recruitmentReader,announcementScreenView} from '../backend/recruitment-reader.ts';
import {announcementReport} from '../backend/announcement-report.ts';
import {listRecords} from '../backend/listings.ts';
import {positionFacts,sourceRows} from '../shared/source-position.ts';
import {jobPlaces,locationText} from '../shared/job-location.ts';
import {majorRequirementText} from '../shared/job-display.ts';
import {reviewTableJobs} from '../backend/position-quality.ts';
import {matchJob} from '../backend/matching.ts';
import {jobDetail} from '../backend/job-actions.ts';
import {schedulePositionRepairs,positionRepairPlan} from '../backend/position-repair.ts';

vi.mock('../backend/net.ts',async original=>({...await original<typeof import('../backend/net.ts')>(),requestPublic:vi.fn()}));
const fixture=JSON.parse(readFileSync(new URL('./fixtures/source-rows-v14-6.json',import.meta.url),'utf8'));
let store:Store,config:Config;
const profile={id:'profile',title:'我的条件',education:[{level:'硕士',major:'土壤学',code:'090301'}]};
beforeEach(()=>{
 mkdirSync('.check/quality-v14-6/tests',{recursive:true});const dir=mkdtempSync(resolve('.check/quality-v14-6/tests/case-'));
 store=new Store(dir);config={dataDir:dir,host:'127.0.0.1',port:8899,origin:'http://127.0.0.1:8899',python:'unused',distDir:resolve('dist'),masterKey:randomBytes(32).toString('hex'),adminUsername:'fixture',passwordHash:'unused'};
 store.put('profile','profile',profile);vi.mocked(requestPublic).mockReset();
});
afterEach(()=>store.db.close());
function seed(rows:any[],sheet='岗位表'){
 const parsed={tables:[{sheet,rows,headers:[],notes:[],complete:true}],text:rows.map(r=>r.text).join('\n'),error:''};
 store.put('ann','announcement',{title:'四川省2027年选调公告',type:'选调',province:'四川',body:'选调岗位',published:'2026-09-23',analysisStatus:'done',contentHash:'source-one',fileIds:['file'],materialErrors:[],tableScreening:{candidates:rows.length}});
 store.db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?)').run('file','ann','岗位.xlsx','','xlsx',100,'hash',parsed.text,'');store.setSetting('workbook-v2:file',parsed);
 for(const row of rows)store.put('row-'+row.row,'job',{title:'职位',type:'选调',province:'四川省',organization:'北京市总部',announcementId:'ann',sourceRow:{fileId:'file',fileName:'岗位.xlsx',sheet,row:row.row,rowId:'id-'+row.row},sourceRowId:'id-'+row.row,majorRequirements:[],eligibilityCoverage:'unknown',analysisIncomplete:true,status:'关注',notes:'保留我的备注'});
}
const page=(q='')=>listRecords(store,'job',new URLSearchParams(q));
describe('parser facts and canonical places',()=>{
 it('recovers the city from the real multiline selection-region header for every Sichuan row',()=>{
  seed(fixture.sichuan.map((r:any)=>r.row),'市（州）选调职位表');
  const old=store.list('job').map(j=>JSON.stringify(j));
  for(const job of page().items){expect(job.displayRegion).toBe(job.sourceRow.row===638?'四川省 · 雅安市':'四川省 · 巴中市');expect(job.sourcePosition.fields).toBeTruthy();}
  expect(page('province=四川&city=巴中').total).toBe(3);expect(page('city=雅安市').total).toBe(1);
  expect(store.list('job').map(j=>JSON.stringify(j))).toEqual(old);expect(requestPublic).not.toHaveBeenCalled();
 });
 it('uses the same place on cards, details, filters and announcement reports',()=>{
  seed([fixture.sichuan[2].row],'市（州）选调职位表');
  const full=page().items[0],card=page('view=cards').items[0],report=announcementReport(store,store.get('ann'));
  expect(card.displayRegion).toBe(full.displayRegion);expect(report.jobs[0].displayRegion).toBe(full.displayRegion);
  expect(jobDetail(store,full.id).displayRegion).toBe(full.displayRegion);
  expect(listRecords(store,'announcement',new URLSearchParams('city=巴中市')).total).toBe(1);
  expect(full.status).toBe('关注');expect(full.notes).toBe('保留我的备注');
 });
 it('shows the Hunan row requirements despite missing analysis and does not blame an existing profile',()=>{
  seed([fixture.hunan],'市州直机关');const item=page().items[0];
  expect(item.sourcePosition).toMatchObject({education:'本科及以上',major:'机械类'});
  expect(majorRequirementText(item)).toBe('机械类');expect(item.profileState).toBe('ready');expect(item.eligibilityProfile).toBe('我的条件');expect(item.majorStatus).toBe('unknown');
  const report=announcementReport(store,store.get('ann')),screen=announcementScreenView(report);
  expect(report.analysisStatus).toBe('partial');expect(report.analysisCoverage).toMatchObject({total:1,incomplete:1});
  expect(screen.jobs[0].sourcePosition.fields).toEqual(fixture.hunan.fields);
 });
 it('keeps rows from different files separate even with equal sheet names and row numbers',()=>{
  seed([fixture.hunan],'市州直机关');
  store.db.prepare('UPDATE records SET data=json_set(data,\'$.sourceRow.fileId\',\'other\') WHERE kind=\'job\'').run();
  const j=page().items[0];expect(j.sourcePosition).toBeUndefined();expect(j.analysisQuality.issues).toContain('岗位原表行尚未读取');
 });
 it('recovers a complete multiline row from retained text when there is no workbook cache',()=>{
  seed([fixture.hunan],'市州直机关');store.db.prepare('DELETE FROM settings WHERE key=?').run('workbook-v2:file');
  const j=page().items[0];expect(j.sourcePosition.education).toBe('本科及以上');expect(j.sourcePosition.major).toBe('机械类');
  expect(sourceRows(fixture.hunan.text).get('市州直机关\0'+87)).toEqual(fixture.hunan.fields.map(({column,...f}:any)=>f));
 });
 it('refreshes the canonical city after parser data changes without a job-version change',()=>{
  seed([fixture.sichuan[2].row],'市（州）选调职位表');expect(page('city=巴中市').total).toBe(1);
  const parsed=store.getSetting<any>('workbook-v2:file',{});parsed.tables[0].rows[0].fields.find((f:any)=>/市/.test(f.header)).value='雅安市';store.setSetting('workbook-v2:file',parsed);
  expect(page('city=巴中市').total).toBe(0);expect(page('city=雅安市').items[0].displayRegion).toBe('四川省 · 雅安市');
 });
 it('does not infer headquarters cities and handles municipalities and multiple locations',()=>{
  expect(locationText(jobPlaces({organization:'北京市总部',province:'湖北'}))).toBe('湖北省');
  expect(jobPlaces({sourcePosition:{location:'上海、武汉'}})).toEqual([{province:'上海市',city:'上海市'},{province:'湖北省',city:'武汉市'}]);
  expect(jobPlaces({province:'地点待确认'})).toEqual([]);
 });
});
describe('coverage and profile states',()=>{
 it('distinguishes no profile, no education, ambiguous selection and failed professional matching',()=>{
  const j={majorRequirements:[],eligibilityCoverage:'unknown'};
  expect(matchJob(j,[],'').profileState).toBe('missing');
  expect(matchJob(j,[{...profile,education:[]}],'').profileState).toBe('education_missing');
  expect(matchJob(j,[profile,{...profile,id:'other'}],'').profileState).toBe('selection_required');
  expect(matchJob(j,[profile],'')).toMatchObject({profileId:'profile',profileState:'ready',majorStatus:'unknown'});
 });
 it('detects duplicate IDs, omitted major cells and invented IDs while preserving original facts',()=>{
  const row={rowId:'one',text:fixture.hunan.text,sourcePosition:positionFacts(fixture.hunan.fields),title:'岗位'};
  const base={sourceRowId:'one',majorRequirements:[],eligibilityCoverage:'complete'};
  for(const jobs of [[],[base],[base,base],[{...base,sourceRowId:'invented'}]]){
   const review=reviewTableJobs([row],jobs);expect(review.retryRows).toHaveLength(1);expect(review.jobs[0].sourcePosition.major).toBe('机械类');
  }
 });
 it('does not turn unknown fields into unrestricted requirements',()=>{
  const facts=positionFacts([{header:'学历',value:'本科及以上'}]);expect(facts.major).toBe('');
  expect(majorRequirementText({sourcePosition:facts,majorRequirements:[],majorStatus:'unknown'})).not.toBe('不限专业');
 });
});

describe('bounded row recovery',()=>{
 const base={relevant:true,type:'选调',summary:'招录公告',uncertainties:[],dates:[],jobs:[],commonEligibility:[],commonCoverage:'complete',applicationItems:[],applicationCoverage:'complete'};
 const reply=(v:any)=>({status:200,headers:{},url:'',body:Buffer.from(JSON.stringify({choices:[{message:{content:JSON.stringify(v)}}]}))});
 const rows=[1,2].map(n=>({row:n,fields:[{column:1,header:'岗位名称',value:'岗位'+n},{column:2,header:'学历',value:'硕士'},{column:3,header:'专业要求',value:'土壤学'}],text:`[岗位表 第 ${n} 行] 【岗位名称】岗位${n} | 【学历】硕士 | 【专业要求】土壤学`}));
 function model(alwaysOmit=false){
  let tableCall=0;
  vi.mocked(requestPublic).mockImplementation(async (_url,opts:any)=>{
   const prompt=JSON.parse(opts.body).messages[1].content;const ids=[...prompt.matchAll(/岗位行ID：([a-z0-9]+)/g)].map((m:any)=>m[1]);
   if(!ids.length)return reply(base);tableCall++;
   return reply({...base,jobs:(alwaysOmit?[]:tableCall===1?ids.slice(0,1):ids).map((id:string)=>({title:'岗位',sourceRowId:id,match:'符合',reasons:'已核对',evidence:'【专业要求】土壤学',majorRequirements:[{levels:['硕士'],names:['土壤学'],evidence:'【专业要求】土壤学'}],eligibilityCoverage:'complete',applicationCoverage:'complete'}))});
  });
 }
 it('retries only the missing row and keeps the successful row across restarts',async()=>{
  seed(rows);saveAI(store,{baseUrl:'https://example.invalid/v1',model:'fixture',key:'fixture-only',dailyLimit:100},config);model();
  expect(await analyze(store,config,'ann')).toBe(false);const saved=store.getSetting<any>('analysis:ann',{});expect(saved.segments.at(-1).pendingRowIds).toHaveLength(1);
  store.db.close();store=new Store(config.dataDir);
  expect(await analyze(store,config,'ann')).toBe(true);
  const prompts=vi.mocked(requestPublic).mock.calls.map(([,o]:any)=>JSON.parse(o.body).messages[1].content).filter((s:string)=>s.includes('岗位行ID：'));
  expect([...prompts[0].matchAll(/岗位行ID：/g)]).toHaveLength(2);expect([...prompts[1].matchAll(/岗位行ID：/g)]).toHaveLength(1);
  expect(store.list('job').filter(j=>j.id.startsWith('job:ann:')&&j.analysisCurrent!==false)).toHaveLength(2);expect(store.get('ann').analysisStatus).toBe('done');
 });
 it('stops after two repairs and reports incomplete rows instead of declaring success',async()=>{
  seed(rows);saveAI(store,{baseUrl:'https://example.invalid/v1',model:'fixture',key:'fixture-only',dailyLimit:100},config);model(true);
  let done=false;for(let i=0;i<5&&!done;i++)done=await analyze(store,config,'ann')===true;
  expect(done).toBe(true);expect(requestPublic).toHaveBeenCalledTimes(4);expect(store.get('ann').analysisStatus).toBe('partial');
  const jobs=store.list('job').filter(j=>j.id.startsWith('job:ann:')&&j.analysisCurrent!==false);expect(jobs).toHaveLength(2);expect(jobs.every(j=>j.sourcePosition.major==='土壤学')).toBe(true);
 });
 it('does not resend completed rows when the missing-row response is truncated',async()=>{
  seed([...rows,...rows.map((r,n)=>({...r,row:n+3,text:r.text.replace('第 '+r.row+' 行','第 '+(n+3)+' 行')}))]);
  saveAI(store,{baseUrl:'https://example.invalid/v1',model:'fixture',key:'fixture-only',dailyLimit:100},config);
  let n=0;const requests:string[][]=[];
  vi.mocked(requestPublic).mockImplementation(async(_url,opts:any)=>{
   const prompt=JSON.parse(opts.body).messages[1].content,ids=[...prompt.matchAll(/岗位行ID：([a-z0-9]+)/g)].map((m:any)=>m[1]);
   if(!ids.length)return reply(base);requests.push(ids);n++;
   if(n===2)return {status:200,headers:{},url:'',body:Buffer.from(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{}'}}]}))};
   return reply({...base,jobs:(n===1?ids.slice(0,1):ids).map((sourceRowId:string)=>({title:'岗位',sourceRowId,match:'符合',reasons:'核对完成',evidence:'【专业要求】土壤学',majorRequirements:[{levels:['硕士'],names:['土壤学'],evidence:'【专业要求】土壤学'}],eligibilityCoverage:'complete',applicationCoverage:'complete'}))});
  });
  let done=false;for(let i=0;i<6&&!done;i++)done=await analyze(store,config,'ann')===true;
  expect(done).toBe(true);expect(requests.map(r=>r.length)).toEqual([4,3,2,1]);
  expect(requests.slice(1).flat()).not.toContain(requests[0][0]);
  expect(store.list('job').filter(j=>j.id.startsWith('job:ann:')&&j.analysisCurrent!==false)).toHaveLength(4);
 });
 it('repairs a fixed historical row without changing successful jobs, notes, attention or calendar candidates',async()=>{
  seed(rows);saveAI(store,{baseUrl:'https://example.invalid/v1',model:'fixture',key:'fixture-only',dailyLimit:100},config);model();
  while(await analyze(store,config,'ann')===false){}
  const work=store.getSetting<any>('analysis:ann',{}),targets=store.list('job').filter(j=>j.id.startsWith('job:ann:'));
  const target=targets[0],other=JSON.stringify(targets[1]);
  store.put(target.id,'job',{...target,status:'关注',notes:'不丢失备注'},target.version);
  const ann=store.get('ann');store.put('ann','announcement',{...ann,candidates:[{id:'stable-calendar-id',date:'2026-10-01',label:'报名'}]},ann.version);
  const beforeDates=store.get('ann').candidates,calls=vi.mocked(requestPublic).mock.calls.length;
  const selection={announcementId:'ann',sourceHash:'source-one',signature:work.signature,rowIds:[target.sourceRowId]};
  await schedulePositionRepairs(store,[selection]);
  expect(await analyze(store,config,'ann')).toBe(true);
  expect(requestPublic).toHaveBeenCalledTimes(calls+1);
  expect(JSON.stringify(store.get(targets[1].id)).replace(',"kind":"job"','')).toContain(targets[1].title);
  expect(JSON.stringify(store.list('job').find(j=>j.id===targets[1].id))).toBe(other);
  expect(store.get(target.id)).toMatchObject({status:'关注',notes:'不丢失备注'});expect(store.get('ann').candidates).toEqual(beforeDates);
 });
 it('refuses a historical repair if the source or fixed row selection changed',async()=>{
  seed(rows);saveAI(store,{baseUrl:'https://example.invalid/v1',model:'fixture',key:'fixture-only',dailyLimit:100},config);model();
  while(await analyze(store,config,'ann')===false){}
  const work=store.getSetting<any>('analysis:ann',{});
  await expect(positionRepairPlan(store,{announcementId:'ann',sourceHash:'source-one',signature:'wrong',rowIds:['one']})).rejects.toThrow();
  await expect(positionRepairPlan(store,{announcementId:'ann',sourceHash:'source-one',signature:work.signature,rowIds:['invented']})).rejects.toThrow();
  expect(store.getSetting<any>('analysis:ann',{})).not.toHaveProperty('rowRepair');
 });
 it('accepts verified legacy checkpoints but stops a queued repair after profile changes',async()=>{
  seed(rows);saveAI(store,{baseUrl:'https://example.invalid/v1',model:'fixture',key:'fixture-only',dailyLimit:100},config);model();
  while(await analyze(store,config,'ann')===false){}
  const work=store.getSetting<any>('analysis:ann',{});delete work.sourceHash;store.setSetting('analysis:ann',work);
  const rowIds=[store.list('job').find(j=>j.id.startsWith('job:ann:')).sourceRowId];
  await schedulePositionRepairs(store,[{announcementId:'ann',sourceHash:'source-one',signature:work.signature,rowIds}]);
  const p=store.get('profile');store.put('profile','profile',{...p,education:[{level:'硕士',major:'法学'}]},p.version);
  const before=vi.mocked(requestPublic).mock.calls.length;
  await expect(analyze(store,config,'ann')).rejects.toThrow('补核已暂停');expect(requestPublic).toHaveBeenCalledTimes(before);
 });
});
