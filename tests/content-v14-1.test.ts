import {describe,it,expect,afterEach} from 'vitest';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../backend/db.ts';
import {announcementReport} from '../backend/announcement-report.ts';
import {listRecords} from '../backend/listings.ts';
import {matchJob} from '../backend/matching.ts';
import {analysisInstruction} from '../backend/ai.ts';
import {mergeIntroduction,announcementIntroduction,cleanIntroduction,mergedSummary,overviewFacts} from '../shared/announcement-presentation.ts';
import {isCampusService,orderedApplicationItems,publicApplicationItems} from '../shared/application-presentation.ts';
import {applicationItemSchema} from '../shared/application.ts';

const stores:Store[]=[];
function setup(){mkdirSync('.check/v14-1/tests',{recursive:true});const store=new Store(mkdtempSync(resolve('.check/v14-1/tests/case-')));stores.push(store);return store;}
afterEach(()=>{for(const store of stores.splice(0))store.db.close();});
const intro='湖南省2027年定向选调，面向2027届全日制大学毕业生，分A、B两类。';
const noise=['专业目录显示：硕士土壤学归入农学大类。','本人最高学历为硕士土壤学。','4个岗位均要求硕士研究生学历，专业分别为地质学类、机械类。','湖南省2027年定向选调岗位表第28—31行。','推荐表须经学校就业创业办公室审核盖章。'];
const step=(label:string,extra:any={})=>({kind:'procedure',label,detail:'',evidence:label+'的原文要求',required:true,phase:'报名',method:'',deadline:'',...extra});

describe('bounded announcement overview, independent from matching reasoning',()=>{
  it('filters the reported catalogue, personal reasoning, row summaries and campus operations',()=>{
    const result=cleanIntroduction([intro,...noise,intro,...noise].join('\n'));
    expect(result).toBe(intro);expect(result.length).toBeLessThanOrEqual(260);
  });
  it('never merges job-table, image or professional-catalogue summaries into an overview',()=>{
    expect(mergedSummary([{summary:intro},{_table:true,summary:'这是四个岗位的分析。'},{_imageId:'image',summary:'工作安排说明。'},{_partName:'专业指导目录.xlsx',summary:'农学招聘。'}])).toBe(intro);
  });
  it('uses body evidence first and rejects invented or catalogue-mapping fields',()=>{
    const quote='面向2027届毕业生；工作地点上海；专业目录显示土壤学归入农学。';
    const f=(text:string)=>({text,evidence:quote});
    const fields=mergeIntroduction([{_partName:'报考须知',_source:'面向2026届毕业生',introduction:{audience:{text:'2026届毕业生',evidence:'面向2026届毕业生'}}},{_partName:'公告正文',_source:quote,introduction:{audience:f('2027届毕业生'),locations:f('上海'),positions:f('法务'),majors:f('专业目录显示土壤学归入农学')}}]);
    expect(fields).toEqual({audience:'2027届毕业生',locations:'上海'});
  });
  it('sanitizes already stored introduction fields without rewriting the stored record',()=>{
    const ann={title:'湖南省2027年定向选调公告',type:'选调',introduction:{audience:'2027届毕业生',majors:noise[0],application:noise[4]}};
    expect(announcementIntroduction(ann)).toBe('湖南省2027年定向选调公告；面向2027届毕业生。');
    expect(overviewFacts(ann)).toEqual([{key:'audience',label:'面向对象',text:'2027届毕业生'}]);
    expect(ann.introduction.majors).toBe(noise[0]);
  });
  it('does not repeat the education level already included in the audience',()=>{
    expect(overviewFacts({introduction:{audience:'2027届本科及以上学历应届毕业生',education:'本科及以上学历',positions:'法务、审计'}}).map(f=>f.key)).toEqual(['audience','positions']);
  });
  it('bounds legacy summaries and retains a short factual introduction',()=>{
    expect(cleanIntroduction((intro+'\n').repeat(60))).toBe(intro);
    expect(announcementIntroduction({title:'测试企业招聘',summary:'测试招聘。'+noise.join('')})).toBe('测试招聘。');
  });
  it('reprojects a completed legacy analysis using only general facts, without changing data or queue',()=>{
    const store=setup(),ann=store.put('ann','announcement',{title:'湖南省2027年定向选调公告',type:'选调',body:intro,analysisStatus:'done',summary:[intro,...noise].join('\n'),fileIds:[]});
    store.setSetting('analysis:ann',{index:2,segments:[{partName:'公告正文'},{partName:'岗位表.xlsx'}],results:[{summary:intro,_source:intro,commonEligibility:[],applicationItems:[]},{_table:true,summary:noise.join('\n'),_source:'岗位数据'}]});
    const version=ann.version,report=announcementReport(store,ann);
    expect(report.summary).toBe(intro);expect(store.get('ann').version).toBe(version);expect(store.get('ann').summary).toContain('专业目录');
    expect(store.db.prepare('SELECT count(*) n FROM jobs').get()?.n).toBe(0);
  });
  it('keeps list descriptions concise for old announcements too',()=>{
    const store=setup();store.put('ann','announcement',{title:'湖南省2027年定向选调公告',type:'选调',summary:[intro,...noise].join('\n')});
    expect(listRecords(store,'announcement',new URLSearchParams()).items[0].summary).toBe(intro);
  });
});

describe('official process order and material boundary',()=>{
  it('orders undated registration before ticket printing and testing, regardless of source chunk order',()=>{
    const items=['打印准考证','成绩查询','网上报名','资格初审','笔试','报名确认与缴费'].map(label=>step(label));
    expect(orderedApplicationItems(items).map(i=>i.label)).toEqual(['网上报名','资格初审','报名确认与缴费','打印准考证','笔试','成绩查询']);
  });
  it('honors explicit dates and inserts undated stages into the process',()=>{
    const items=[step('打印准考证'),step('网上报名',{deadline:'2026-09-29'}),step('成绩查询'),step('笔试',{deadline:'2026-10-10'})];
    expect(orderedApplicationItems(items).map(i=>i.label)).toEqual(['网上报名','打印准考证','笔试','成绩查询']);
    expect(orderedApplicationItems([step('确认推荐资格',{deadline:'2026-10-01'}),step('网上报名',{deadline:'2026-09-20'})]).map(i=>i.label)).toEqual(['网上报名','确认推荐资格']);
  });
  it('does not rank an early step by a later stage mentioned in its description',()=>{
    expect(orderedApplicationItems([step('打印准考证'),step('网上报名',{detail:'报名成功后按时打印准考证并参加笔试。'})]).map(i=>i.label)).toEqual(['网上报名','打印准考证']);
  });
  it('excludes the two reported campus stamp services and preserves official stamped forms',()=>{
    const material=step('学校审核盖章的选调生报名推荐表',{kind:'material',detail:'由学校审核盖章后上传官方报名系统。'});
    const items=[step('就业创业办公室公章',{detail:'学院审核盖章后前往自助机盖章'}),step('学校党委组织部公章',{method:'每周四下午一站式服务大厅'}),material];
    expect(publicApplicationItems(items)).toEqual([material]);expect(isCampusService(material)).toBe(false);
  });
  it('uses explicit campus provenance, not every reference to a school or stamp',()=>{
    expect(isCampusService(step('学生材料办理',{scope:'campus'}))).toBe(true);
    expect(isCampusService(step('学校推荐',{detail:'取得学校推荐资格后报名。',scope:'notice'}))).toBe(false);
  });
  it('deduplicates repeated evidence but preserves different deadlines, alternatives and distinct requirements',()=>{
    const a=step('网上报名',{deadline:'2026-09-29'}),b={...a,label:'在线申请',detail:'通过官方网站在线报名。'};
    expect(publicApplicationItems([a,b])).toEqual([b]);
    expect(publicApplicationItems([a,{...a,deadline:'2026-09-30'},{...a,required:false},{...a,evidence:'其他不同的提交要求'}])).toHaveLength(4);
    const sameQuote='网上报名后打印准考证。报名材料包括简历和学籍证明。';
    expect(publicApplicationItems([step('网上报名',{evidence:sameQuote}),step('打印准考证',{evidence:sameQuote}),step('简历',{kind:'material',evidence:sameQuote}),step('学籍证明',{kind:'material',evidence:sameQuote})])).toHaveLength(4);
  });
  it('applies the same campus filter to saved job details and announcement reports',()=>{
    const store=setup(),items=[step('网上报名'),step('学校党委组织部公章')],source=items.map(i=>i.evidence).join('。');
    const ann=store.put('ann','announcement',{title:'示例选调',type:'选调',body:source,fileIds:[],analysisStatus:'done'});
    store.setSetting('analysis:ann',{index:1,segments:[{}],results:[{_source:source,summary:'',applicationItems:items,commonEligibility:[]}]});
    expect(announcementReport(store,ann).applicationProcess.map((i:any)=>i.label)).toEqual(['网上报名']);
    expect(matchJob({applicationItems:items},[],source).applicationItems.map(i=>i.label)).toEqual(['网上报名']);
  });
  it('keeps a backward-compatible scope on old saved application data',()=>{
    expect(applicationItemSchema.parse(step('网上报名')).scope).toBe('unknown');
    expect(applicationItemSchema.parse(step('网上报名',{scope:'notice'})).scope).toBe('notice');
  });
});

describe('manual intention counts and the actual bundled Agent contract',()=>{
  it('counts only explicit current non-archived planned applications, independently of pagination and matching',()=>{
    const store=setup();['收藏','未选择','拟投递','拟投递','准备材料','已报名'].forEach((status,index)=>store.put('j'+index,'job',{status,majorStatus:'matched'}));
    store.put('old','job',{status:'拟投递',analysisCurrent:false});store.put('archived','job',{status:'拟投递',archived:true});
    expect(store.snapshot(true).jobCounts).toEqual({intended:2});
    const j=store.get('j2');store.put(j.id,'job',{...j,status:'未选择'},j.version);expect(store.snapshot(true).jobCounts).toEqual({intended:1});
  });
  it('loads page-by-page rules in the prompt actually sent to the provider',()=>{
    expect(analysisInstruction).toContain('固定内容契约（v14.1）');expect(analysisInstruction).toContain('岗位表、专业目录和校内办事材料的 summary 为空字符串');
    expect(analysisInstruction).toContain('scope:"notice|campus|unknown"');expect(analysisInstruction).toContain('学校党委盖章');
    expect(readFileSync('backend/recruitment-skill.md','utf8')).toContain('你不得编造或手写这些数量');
  });
});
