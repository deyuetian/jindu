import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../backend/db.ts';
import {listRecords} from '../backend/listings.ts';
import {announcementReport} from '../backend/announcement-report.ts';
import {announcementMetadata,announcementAnalysisCounts,announcementAnalysisNotice} from '../shared/announcement-metadata.ts';
import {announcementPlaces} from '../shared/job-location.ts';

let store:Store,worker:Store;
const titleA='安徽省2027年度面向中国农业大学定向招录选调生公告';
const titleH='黑龙江省2027年度定向选调应届优秀大学毕业生公告';
beforeEach(()=>{mkdirSync('.check/recovery-v14-12-r1/tests',{recursive:true});store=new Store(mkdtempSync(resolve('.check/recovery-v14-12-r1/tests/case-')));worker=new Store(store.dir);});
afterEach(()=>{worker.db.close();store.db.close();});
function seed(id:string,title:string,state:string){return store.put(id,'announcement',{title,type:'其他',province:'',status:'pending',analysisStatus:state,analysisError:state==='error'?'AI 接口暂时限制请求（HTTP 429）':'',body:'公开公告正文',published:'2026-10-09',contentHash:'fixture',fileIds:[],candidates:[],uncertainties:[],source:'测试来源'});}
const list=(params:Record<string,string>={})=>listRecords(store,'announcement',new URLSearchParams(params));

describe('collected announcements remain discoverable before analysis finishes',()=>{
  it.each(['pending','running','retry','waiting_config','waiting_quota','error'])('keeps %s announcements under province and selection filters',state=>{
    seed('anhui',titleA,state);seed('heilongjiang',titleH,state);
    expect(list({type:'选调'}).items.map(a=>a.id).sort()).toEqual(['anhui','heilongjiang']);
    expect(list({type:'选调',province:'安徽省'}).items).toMatchObject([{id:'anhui',type:'选调',province:'安徽省',analysisStatus:state}]);
    expect(list({type:'选调',province:'黑龙江省',q:'选调'}).items).toMatchObject([{id:'heilongjiang',type:'选调',province:'黑龙江省'}]);
    expect(list({province:'安徽',q:'安徽'}).total).toBe(1);
    expect(list({province:'黑龙江省',city:'哈尔滨市'}).total).toBe(0);
    expect(list().locations).toEqual(expect.arrayContaining([{province:'安徽省',cities:[]},{province:'黑龙江省',cities:[]}]));
  });
  it('uses the same metadata in list, full and compact report responses without rewriting any analysis',()=>{
    const ann=seed('anhui',titleA,'error');store.setSetting('analysis:anhui',{index:1,segments:[{},{}],results:[{summary:'已保存分段'}]});
    const before=JSON.stringify([store.get('anhui'),store.getSetting('analysis:anhui',null)]);
    const report=announcementReport(store,ann);
    expect(report).toMatchObject({type:'选调',province:'安徽省',analysisStatus:'error',jobs:[],reportReady:false});
    expect(store.snapshot(false).announcements[0]).toMatchObject({type:'选调',province:'安徽省',analysisStatus:'error'});
    expect(list().items[0]).toMatchObject({type:'选调',province:'安徽省'});
    expect(JSON.stringify([store.get('anhui'),store.getSetting('analysis:anhui',null)])).toBe(before);
    expect(store.prepare('SELECT COUNT(*) n FROM jobs').get()).toMatchObject({n:0});
    expect(store.prepare('SELECT COUNT(*) n FROM ai_requests').get()).toMatchObject({n:0});
  });
  it('does not leave a stale province index after a background analysis adds actual locations',()=>{
    const ann=seed('anhui',titleA,'pending');expect(list({province:'安徽省'}).total).toBe(1);
    worker.put(ann.id,'announcement',{...ann,type:'选调',province:'安徽省合肥市',analysisStatus:'done'},ann.version);
    expect(list({province:'安徽省',city:'合肥市'}).total).toBe(1);expect(list({province:'安徽省'}).analysisCounts).toEqual({pending:0,error:0,partial:0});
  });
  it('keeps date, ignored/archived status and pagination rules intact',()=>{
    const a=seed('a',titleA,'error');seed('h',titleH,'retry');
    store.put(a.id,'announcement',{...a,status:'ignored'},a.version);
    expect(list({type:'选调',status:'暂不关注'}).total).toBe(1);
    expect(list({type:'选调',from:'2026-10-10'}).total).toBe(0);
    const current=store.get(a.id);worker.put(a.id,'announcement',{...current,archived:true},current.version);
    expect(list({type:'选调'}).total).toBe(1);
  });
  it('reports all collected analysis states even while viewing a narrow filter',()=>{
    seed('a',titleA,'error');seed('h',titleH,'retry');seed('p','结果待核对','partial');seed('done','已经完成','done');
    const a=seed('archived','归档','error');store.put(a.id,'announcement',{...a,archived:true},a.version);
    expect(list({q:'没有匹配的标题'})).toMatchObject({total:0,analysisCounts:{pending:1,error:1,partial:1}});
  });
});

describe('only explicit title facts are used',()=>{
  it.each([
    ['【选调生】安徽省2027年度定向招录选调生公告','安徽省'],
    ['关于转发《黑龙江省2027年度定向选调应届优秀大学毕业生公告》','黑龙江省'],
    ['广西2027年度定向选调生公告','广西壮族自治区'],
    ['北京市2027年度定向选调和“优培计划”招聘公告','北京市'],
    ['重庆市面向中国农业大学定向选调2027届毕业生简章','重庆市'],
    ['2027年度浙江省党政机关选调应届优秀大学毕业生公告','浙江省'],
  ])('recognizes the explicit recruiting region in %s',(title,province)=>{
    expect(announcementMetadata({title,type:'其他',province:''})).toMatchObject({type:'选调',province});
  });
  it.each(['安徽农业大学2027年度选调生工作通知','中国农业大学关于黑龙江选调生的通知','安徽省籍毕业生参加浙江省2027年选调公告'])('does not derive a workplace from school/origin text: %s',title=>{
    expect(announcementPlaces({title,province:''})).toEqual([]);
  });
  it('keeps prior explicit facts, rejects unrelated discussion and never infers qualification or job counts',()=>{
    expect(announcementMetadata({title:titleA,type:'选调',province:'安徽省合肥市'}).province).toBe('安徽省合肥市');
    const input={title:'安徽省2027年选调生备考培训公告',type:'其他',province:''};expect(announcementMetadata(input)).toBe(input);
    const result=announcementMetadata({title:titleH,type:'其他',province:''});expect(result).not.toHaveProperty('majorStatus');expect(result).not.toHaveProperty('jobs');
  });
  it('separates collection from failed/pending analysis and completed reports',()=>{
    expect(announcementAnalysisNotice({analysisStatus:'error',analysisError:'接口限流'})).toBe('公告已收集，分析未完成。接口限流');
    expect(announcementAnalysisNotice({analysisStatus:'pending'})).toContain('公告已收集');
    expect(announcementAnalysisNotice({analysisStatus:'done'})).toBe('');
    expect(announcementAnalysisCounts([{analysisStatus:'done'},{analysisStatus:'waiting_config'},{analysisStatus:'error',archived:true}])).toEqual({pending:1,error:0,partial:0});
  });
});
