import {afterEach,describe,expect,it} from 'vitest';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../backend/db.ts';
import {listRecords} from '../backend/listings.ts';
import {overviewFacts,announcementIntroduction} from '../shared/announcement-presentation.ts';
import {announcementReport} from '../backend/announcement-report.ts';

const stores:Store[]=[];
function fixture(){
  mkdirSync('.check/tests/interaction-v14-3',{recursive:true});
  const store=new Store(mkdtempSync(resolve('.check/tests/interaction-v14-3/case-')));stores.push(store);
  store.put('notice','announcement',{title:'示例企业2027年度校园招聘',published:'2026-09-22',body:'招收土壤学、植物营养学，代码090301、090302。',type:'企业招聘',status:'pending'});
  store.put('job:structured','job',{title:'研究岗',announcementId:'notice',province:'湖北省',type:'企业招聘',status:'拟投递',majorRequirements:[{names:['土壤学','植物营养学'],codes:['090301','090302'],evidence:'招收土壤学、植物营养学，代码090301、090302。'}]});
  store.put('job:source','job',{title:'工程岗',announcementId:'notice',province:'湖北',type:'企业招聘',majorRequirements:[],sourcePosition:{major:'农业水土工程、农业工程'}});
  return store;
}
afterEach(()=>{for(const store of stores.splice(0))store.db.close();});
describe('searching the requirements visible on job details',()=>{
  it.each(['植物营养学','090302'])('finds a structured requirement by %s without a matching user profile',q=>{
    const result=listRecords(fixture(),'job',new URLSearchParams({q,status:'全部'}));
    expect(result.items.map(i=>i.id)).toEqual(['job:structured']);
  });
  it('searches the complete source major field when structured extraction is absent',()=>{
    expect(listRecords(fixture(),'job',new URLSearchParams({q:'农业水土工程'})).items.map(i=>i.id)).toEqual(['job:source']);
  });
  it('keeps date, intention and archived filters authoritative when a major matches',()=>{
    const store=fixture();
    expect(listRecords(store,'job',new URLSearchParams({q:'植物营养学',status:'拟投递'})).total).toBe(1);
    expect(listRecords(store,'job',new URLSearchParams({q:'植物营养学',from:'2026-10-01'})).total).toBe(0);
    const job=store.get('job:structured');store.put(job.id,'job',{...job,archived:true},job.version);
    expect(listRecords(store,'job',new URLSearchParams({q:'植物营养学'})).total).toBe(0);
  });
});
describe('complete facts inside announcement details',()=>{
  it('preserves long requirements, locations and application instructions while keeping list summaries brief',()=>{
    const introduction={majors:'招收'+Array.from({length:24},(_,i)=>'示例专业'+(i+1)).join('、'),locations:Array.from({length:24},(_,i)=>'示例城市'+(i+1)).join('、'),application:'通过报名系统提交资料。'+Array.from({length:18},(_,i)=>'步骤'+(i+1)+'办理完成').join('，')};
    const notice={title:'示例招聘',introduction};
    const store=fixture();const ann=store.get('notice');store.put(ann.id,'announcement',{...ann,...notice},ann.version);
    const report=announcementReport(store,store.get(ann.id)),facts=overviewFacts(report);
    for(const key of ['majors','locations','application'] as const)expect(facts.find(f=>f.key===key)?.text).toBe(introduction[key]);
    expect(announcementIntroduction(notice).length).toBeLessThanOrEqual(300);
  });
});
