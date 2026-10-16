import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../backend/db.ts';
import {saveAI,type Config} from '../backend/config.ts';
import {requestPublic} from '../backend/net.ts';
import {saveFile} from '../backend/files.ts';
import {analyze} from '../backend/ai.ts';
import {ensureCurrentNotice} from '../backend/crawler.ts';
import {queueStatus} from '../backend/queue-status.ts';
import {runWorkerTick} from '../backend/worker.ts';
import {matchMajor} from '../shared/majors.ts';
import {matchJob} from '../backend/matching.ts';
import {listRecords} from '../backend/listings.ts';
import {announcementReport} from '../backend/announcement-report.ts';
import {recruitmentTurn} from '../backend/recruitment-agent.ts';
import {consolidatedNotes,jobPresentation} from '../shared/recruitment-report.ts';
import {announcementIntroduction} from '../shared/announcement-presentation.ts';
import {eligibilityFactsSchema,eligibilityGroupsSchema} from '../shared/eligibility.ts';
import {htmlText} from '../backend/school-crawler.ts';
import {cauRecruitmentContent,webPositionSegments} from '../backend/cau-recruitment.ts';
import {applicationCoveredBy} from '../shared/recruitment-report.ts';

vi.mock('../backend/net.ts',async original=>({...await original<typeof import('../backend/net.ts')>(),requestPublic:vi.fn()}));
vi.mock('../backend/files.ts',()=>({saveFile:vi.fn(),fileTool:vi.fn()}));
const profile={id:'profile',title:'我的条件',education:[{level:'本科',major:'土地资源管理',code:'120404'},{level:'硕士',major:'土壤学',code:'090301'}],includeUnrestricted:false,eligibility:eligibilityFactsSchema.parse({freshGraduate:'yes',freshGraduateYear:'2027',politicalStatus:'群众'})};
const req={levels:['本科','硕士'],names:[],codes:[],unrestricted:true,evidence:'不限专业',catalog:''};
const source='不限专业。2027届应届毕业生。必须为中共党员。网上提交简历。联系在职员工获取内推码。';
const groups=eligibilityGroupsSchema.parse([{label:'招聘对象',mode:'all',evidence:'2027届应届毕业生',criteria:[{kind:'freshGraduate',label:'应届毕业年份',evidence:'2027届应届毕业生',accepted:['2027']}]}]);
const process=[{kind:'procedure',label:'网申投递',evidence:'网上提交简历',detail:'通过官网投递。',required:true,phase:'报名'},{kind:'material',label:'简历',evidence:'网上提交简历',detail:'提交电子简历。',required:true,phase:'报名'}];
const base={relevant:true,type:'企业招聘',summary:'企业校园招聘',dates:[],jobs:[],commonEligibility:groups,commonCoverage:'complete',applicationItems:process,applicationCoverage:'complete',uncertainties:[]};
const response=(d:any)=>({status:200,headers:{},url:'',body:Buffer.from(JSON.stringify(d))});
const aiResponse=(d:any)=>response({choices:[{message:{content:JSON.stringify(d)},finish_reason:'stop'}]});
let store:Store,config:Config;
beforeEach(()=>{mkdirSync('.check/v13/tests',{recursive:true});const dataDir=mkdtempSync(resolve('.check/v13/tests/case-'));store=new Store(dataDir);config={dataDir,origin:'http://127.0.0.1:8788',host:'127.0.0.1',port:8788,adminUsername:'fixture',passwordHash:'unused',masterKey:randomBytes(32).toString('hex'),python:'unused',distDir:resolve('dist')};saveAI(store,{baseUrl:'https://example.invalid/v1',model:'fixture',key:'fixture-only',dailyLimit:100},config);store.put(profile.id,'profile',profile);vi.mocked(requestPublic).mockReset();vi.mocked(saveFile).mockReset();});
afterEach(()=>store.db.close());
const seed=()=>store.put('ann','announcement',{title:'示例企业2027届校园招聘',body:source,url:'https://example.edu.cn/notice',source:'示例大学',contentHash:'new',published:'2026-09-22',analysisStatus:'done',status:'pending',fileIds:[],candidates:[]});
const job=(extra:any={})=>({title:'法务',organization:'示例企业',announcementId:'ann',majorRequirements:[req],eligibilityRequirements:groups,eligibilityCoverage:'complete',analysisIncomplete:false,applicationCoverage:'complete',applicationItems:process,status:'已报名',analysisCurrent:true,...extra});
function completed(){store.setSetting('analysis:ann',{index:1,segments:[{text:source}],results:[{...base,_source:source}],issues:[]});}

describe('unrestricted majors are eligibility facts, not preferences',()=>{
  it('matches both educational paths even if the historical preference is off',()=>{const j=matchJob(job(),[profile],source);expect(j.majorStatus).toBe('unrestricted');expect(j.match).toBe('符合');expect(j.majorPaths).toHaveLength(2);expect(j.majorPaths.every((p:any)=>p.status==='unrestricted')).toBe(true);});
  it('still enforces the corresponding education level and real hard qualifications',()=>{expect(matchMajor([{...req,levels:['博士']}],[profile],source).status).toBe('excluded');const political=eligibilityGroupsSchema.parse([{label:'政治面貌',mode:'all',evidence:'必须为中共党员',criteria:[{kind:'political',label:'中共党员',evidence:'必须为中共党员',accepted:['中共党员']}]}]);expect(matchJob(job({eligibilityRequirements:political}),[profile],source)).toMatchObject({majorStatus:'unrestricted',match:'不符合'});});
  it('does not require a special catalogue mapping for a verifiable unrestricted clause',()=>expect(matchJob(job({catalogContext:true}),[profile],source).majorStatus).toBe('unrestricted'));
  it('does not claim unrestricted without a matching quote',()=>expect(matchMajor([req],[profile],'仅限法学专业').status).toBe('unknown'));
  it('shows corrected legacy records before pagination and preserves application state',()=>{seed();store.put('j','job',job({majorStatus:'excluded'}));const page=listRecords(store,'job',new URLSearchParams('status=专业符合'));expect(page.total).toBe(1);expect(page.items[0]).toMatchObject({majorStatus:'unrestricted',status:'已报名',sourceAnnouncementTitle:'示例企业2027年度校园招聘'});expect(store.get('j').majorStatus).toBe('excluded');});
});
describe('current progress and bounded retries',()=>{
  it('publishes zero progress before the first request of a changed source, including failure',async()=>{seed();store.setSetting('analysis:ann',{signature:'old',index:9,segments:Array(9).fill({}),results:[]});store.setSetting('analysis-progress',{announcementId:'ann',part:9,total:9});vi.mocked(requestPublic).mockImplementation(async()=>{expect(store.getSetting<any>('analysis:ann',{}).index).toBe(0);expect(store.getSetting<any>('analysis-progress',{}).part).toBe(0);throw new Error('provider timeout');});await expect(analyze(store,config,'ann',1)).rejects.toMatchObject({code:'timeout',retryable:true});expect(store.getSetting<any>('analysis:ann',{}).index).toBe(0);});
  it('resets completed counters immediately on reanalysis without destroying resumable parts',()=>{seed();completed();store.setSetting('analysis-progress',{announcementId:'ann',part:1,total:1});store.enqueueAnalysis('ann',true);expect(store.getSetting<any>('analysis-progress',{}).part).toBe(0);expect(queueStatus(store)[0].completed).toBe(0);store.setSetting('analysis:ann',{signature:'resume',index:2,segments:Array(5).fill({}),results:[base,base],repairs:4,stopped:true});store.enqueueAnalysis('ann',true);expect(store.getSetting<any>('analysis:ann',{})).toMatchObject({index:2,repairs:0,stopped:false});});
  it('does not show an old completed cache as an in-progress total',()=>{seed();completed();store.enqueue('analyze:ann','analyze',{id:'ann'});expect(queueStatus(store)[0]).toMatchObject({completed:0,total:0});});
  it('restarts transient retry accounting after a successful checkpoint',async()=>{const ann=seed();store.put('ann','announcement',{...ann,body:source.repeat(300)},ann.version);store.setSetting('sources',{autoEnabled:false,sites:[]});store.setSetting('last-auto-backup',new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()));store.setSetting('last-auto-follow',new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()));store.enqueueAnalysis('ann');store.db.prepare("UPDATE jobs SET attempts=2 WHERE id='analyze:ann'").run();vi.mocked(requestPublic).mockResolvedValue(aiResponse(base));await runWorkerTick(store,config);expect(store.db.prepare("SELECT attempts,state FROM jobs WHERE id='analyze:ann'").get()).toMatchObject({attempts:0,state:'pending'});});
  it('shows the announcement and actual stage for an Agent recruitment analysis',()=>{seed();store.enqueue('turn','agent',{id:'turn'});store.setSetting('recruitment-target:turn','ann');store.setSetting('analysis:ann',{index:0,segments:[{table:true,rows:[{fileName:'岗位表.xlsx',sheet:'计划表'}]}]});expect(queueStatus(store)[0]).toMatchObject({title:'示例企业2027届校园招聘',phase:'分析岗位要求',announcementId:'ann',partName:'岗位表.xlsx / 计划表'});});
});
describe('whole-announcement reporting',()=>{
  it('shows shared eligibility and workflow once and leaves role-specific requirements inside roles',()=>{const ann=seed();completed();store.put('j1','job',job());store.put('j2','job',job({title:'审计'}));const r=announcementReport(store,ann);expect(r.commonEligibilityChecks.groups).toHaveLength(1);expect(r.applicationProcess).toHaveLength(2);expect(r.jobs.every((j:any)=>!j.specificApplicationItems.length&&!j.specificEligibilityChecks.groups.length)).toBe(true);expect(r.jobs[0].match).toBe('符合');expect(requestPublic).not.toHaveBeenCalled();});
  it('keeps common selection eligibility visible when there is no separate job table',()=>{const ann=seed();completed();expect(announcementReport(store,ann).commonEligibilityChecks.groups).toHaveLength(1);});
  it('never converts resume submission or contact details into a qualification',()=>{const j=matchJob(job({eligibilityRequirements:[],applicationItems:[{kind:'other',label:'本人联系电话',required:true,evidence:'网上提交简历'}]}),[profile],source);expect(j.eligibilityChecks.groups).toHaveLength(0);expect(j.match).toBe('符合');});
  it('removes only resolved attachment and cross-part absences, retaining real missing files',()=>{const r=consolidatedNotes({values:['附表1尚未读取，暂不能核实选调高校范围。','本部分未提供报名材料。','本部分未说明是否必须以最高学历报考。','公告未明确是否允许以非最高学历报考。','附件《另一份岗位资格表》尚未读取。'],files:[{id:'file1',name:'选调范围.doc',text:'示例大学属于选调范围',error:''}],results:[{_source:'示例大学属于选调范围',commonEligibility:[{label:'选调高校范围'}],applicationItems:[{kind:'procedure',evidence:'报名时上传简历'}]}]});expect(r).toEqual(['如需用非最高学历报考，请先确认招聘方是否接受。','附件《另一份岗位资格表》尚未读取。']);});
  it('preserves parser failures and unresolved restrictions',()=>{const r=consolidatedNotes({values:['招聘要求不含预备党员，是否满足需要核对。'],issues:['岗位表.doc：转换失败'],files:[{name:'岗位表.doc',text:'',error:'转换失败'}]});expect(r).toHaveLength(2);expect(r.join()).toContain('转换失败');expect(r.join()).toContain('不含预备党员');});
  it('preserves role-specific mandatory materials and genuine degree restrictions',()=>{expect(applicationCoveredBy({kind:'material',required:true,evidence:'报名时上传完整的个人简历'},[{kind:'material',required:false,evidence:'报名时上传完整的个人简历'}])).toBe(false);expect(consolidatedNotes({values:['此岗位必须以最高学历报考，不能使用本科专业。'],results:[{degreePolicy:{policy:'highest'}}]})).toEqual(['此岗位必须以最高学历报考，不能使用本科专业。']);});
  it('does not report a missing deadline when a named registration deadline was extracted',()=>expect(consolidatedNotes({values:['本部分未提供报名材料、报名方式、报名阶段及截止日期。'],dates:[{label:'网上报名截止',date:'2026-11-06'}]})).toEqual([]));
  it('removes repeated labels from the introduction',()=>expect(announcementIntroduction({title:'企业招聘',introduction:{audience:'面向2027届毕业生',positions:'招聘岗位（290人）'}})).toBe('企业招聘；面向2027届毕业生。'));
});
describe('faithful job identity',()=>{
  it('normalizes location and title without confusing a table serial with a position code',()=>{const j={title:'怀化市直岗位6',organization:'怀化市直单位',province:'湖南省',positionCode:'124',sourceRow:{sheet:'市州直机关',row:127,positionCode:''}};const v=jobPresentation(j,{title:'湖南省2027年选调公告'},'[市州直机关 第 127 行] 【序号】124 | 【岗位名称】怀化市直岗位6 | 【单位层级】市直单位');expect(v).toMatchObject({displayTitle:'怀化市 · 市直岗位 6',displayRegion:'湖南省 · 怀化市',displayOrganization:'市直单位',displayPositionCode:'',sourceSerial:'124',sourceAnnouncementTitle:'湖南省2027年选调公告'});expect(j.title).toBe('怀化市直岗位6');});
  it('keeps genuine position codes and distinct official names',()=>{expect(jobPresentation({title:'自然资源岗',positionCode:'A100',sourceRow:{positionCode:'A100'}},{title:'公开招聘'}).displayPositionCode).toBe('A100');});
});
describe('targeted source refresh and Agent reuse',()=>{
  it('reads the referenced recruitment body for an aggregated source row without inventing five headcounts or complete eligibility',async()=>{
    const positionTitle='星辰管培生、专业英才、科技菁英、客户经理、客服经理';
    const recruitment={title:'示例银行2027年度校园招聘',content:'<p>面向2027届毕业生。星辰管培生：参加综合培养。各岗位招录要求详见附件。</p>',corporationName:'示例银行',positionNum:1,recruitmentPositionList:[{id:'p',positionName:positionTitle,studentType:'本科,硕士,博士',majorName:'不限专业',demandNumber:'290',positionDescription:'详见招聘简章'}]};
    const collected=cauRecruitmentContent(recruitment);
    store.put('ann','announcement',{title:recruitment.title,url:'https://example.edu.cn/notice',published:'2026-09-22',body:htmlText(collected.html),sourcePositions:collected.positions,contentHash:'fresh-web',fileIds:[],materialErrors:[]});
    let positionRequests=0;
    vi.mocked(requestPublic).mockImplementation(async(_url,options:any)=>{
      const prompt=JSON.parse(options.body).messages[1].content;
      const rows=webPositionSegments(store.get('ann'),[profile]).segments.flatMap(s=>s.rows||[]).filter(row=>prompt.includes(row.rowId));
      if(!rows.length)return aiResponse({...base,commonEligibility:[],applicationItems:[]});
      positionRequests++;expect(prompt).toContain('星辰管培生：参加综合培养');expect(prompt).toContain('人数为合计');expect(prompt).toContain('各岗位招录要求详见附件');
      return aiResponse({...base,commonEligibility:[],applicationItems:[],jobs:rows.map(row=>({title:positionTitle,organization:'示例银行',sourceRowId:row.rowId,profileId:'profile',match:'待核对',reasons:'专业符合，岗位专属要求待确认。',evidence:row.text,majorRequirements:[{...req,levels:['本科','硕士','博士'],evidence:row.text}],eligibilityRequirements:[],eligibilityCoverage:'partial',applicationItems:[],applicationCoverage:'partial'}))});
    });
    await analyze(store,config,'ann');expect(positionRequests).toBe(1);expect(store.list('job')).toHaveLength(1);expect(store.list('job')[0]).toMatchObject({title:positionTitle,majorStatus:'unrestricted',match:'待核对',sourcePosition:{count:'290'}});
  });
  it('refreshes legacy CAU extraction once and keeps aggregated positions as one source row',async()=>{const id='cau:d0769cda014547cf9fa1093e435ad1af';store.put(id,'announcement',{title:'中国工商银行贵州省分行2027年度校园招聘',published:'2026-09-22',url:'https://scc.cau.edu.cn/frontpage/cau/html/recruitmentinfoForm.html?positionDetailId='+id.slice(4),body:'旧正文',sourceId:'cau',contentHash:'old',materialsComplete:true,fileIds:[],status:'pending'});vi.mocked(requestPublic).mockResolvedValue(response({state:1,object:{recruitmentinfo:{title:'中国工商银行贵州省分行2027年度校园招聘',startTime:'2026-09-22',content:'招聘简介',corporationName:'工行贵州',positionNum:1,recruitmentPositionList:[{id:'p',positionName:'星辰管培生、专业英才、科技菁英、客户经理、客服经理',studentType:'本科,硕士,博士',majorName:'不限专业',demandNumber:'290',positionDescription:'详见招聘简章'}]}}}));vi.mocked(saveFile).mockImplementation(async(_s,_c,_id,url,name,raw)=>({id:'source',name,url,mime:'text/html',text:htmlText(raw!.toString()),error:'',links:[]}));await ensureCurrentNotice(store,config,id);expect(store.get(id).sourcePositions).toHaveLength(1);expect(store.get(id).body).toContain('不限专业');expect(store.db.prepare('SELECT COUNT(*) n FROM jobs').get()?.n).toBe(0);await ensureCurrentNotice(store,config,id);expect(requestPublic).toHaveBeenCalledTimes(1);expect(saveFile).toHaveBeenCalledTimes(1);});
  it('does not silently reinterpret an unavailable source as complete',async()=>{const id='cau:d0769cda014547cf9fa1093e435ad1af';store.put(id,'announcement',{title:'岗位',published:'2026-09-22',url:'https://scc.cau.edu.cn/frontpage/cau/html/recruitmentinfoForm.html?positionDetailId='+id.slice(4),body:'旧资料'});vi.mocked(requestPublic).mockResolvedValue(response({state:0,msg:'招聘信息不存在或审核不通过'}));await expect(ensureCurrentNotice(store,config,id)).rejects.toThrow('公告原页暂时无法读取');expect(store.get(id).body).toBe('旧资料');});
  it('answers searches from saved evidence and lists shared materials once',async()=>{seed();completed();store.put('j1','job',job());store.put('j2','job',job({title:'审计'}));const reply=await recruitmentTurn(store,config,{id:'turn',text:'看看示例企业的岗位'},{intent:'recruitment_search',query:'示例企业',terms:[]});expect(reply.reportAnnouncementId).toBe('ann');expect(reply.reply.match(/简历：/g)).toHaveLength(1);expect(reply.reply).toContain('专业符合 2 个');expect(requestPublic).not.toHaveBeenCalled();});
});
