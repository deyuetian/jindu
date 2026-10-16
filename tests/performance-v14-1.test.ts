import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../backend/db.ts';
import {schemas} from '../backend/model.ts';
import {listRecords} from '../backend/listings.ts';
import {hasEvidence} from '../shared/eligibility.ts';
import {normalizedEvidence} from '../shared/evidence.ts';

let store:Store;
beforeEach(()=>{mkdirSync('.check/v14-1-audit/performance/tests',{recursive:true});store=new Store(mkdtempSync(resolve('.check/v14-1-audit/performance/tests/case-')));});
afterEach(()=>store.db.close());
const longText='公开招聘材料 \n 原文资料\t'.repeat(5000);
function seed(){
  const profile=store.save('profile',{title:'合成条件',education:[{level:'硕士',major:'土壤学',code:'090301'}]});
  const ann=store.put('performance:ann','announcement',{title:'湖北省示例岗位',type:'事业单位',body:longText+'硕士专业：土壤学；不限专业。',status:'pending',province:'湖北',published:'2026-09-22',url:'https://example.invalid/notice'});
  for(const [id,evidence,names,status] of [['specific','硕士专业：土壤学',['土壤学'],'拟投递'],['unlimited','不限专业',[],'收藏']] as const){
    store.put(id,'job',schemas.job.parse({title:'岗位 '+id,type:'事业单位',url:ann.url,announcementId:ann.id,majorStatus:'excluded',majorReason:'旧判断',status,
      majorRequirements:[{levels:id==='specific'?['硕士']:[],names:[...names],unrestricted:id==='unlimited',evidence}],
    }));
  }
  return {profile,ann};
}
describe('large-source listing correctness',()=>{
  it('never reuses evidence from a changed source or a different long quotation',()=>{
    const first=longText+'硕士专业：土 壤 学',second=longText+'硕士专业：软件工程';
    expect(hasEvidence(first,'硕士专业：土壤学')).toBe(true);
    expect(hasEvidence(second,'硕士专业：土壤学')).toBe(false);
    expect(hasEvidence(first,'硕士专业：土壤学')).toBe(true);
    for(const value of ['', '短 文\u00a0原文',first,second,'公\t 开 '.repeat(300000)]){
      expect(normalizedEvidence(value)).toBe(value.replace(/\s/g,''));
    }
  });
  it('keeps page verdicts, current major filters and explicit intent consistent',()=>{
    seed();
    const all=listRecords(store,'job',new URLSearchParams('status=全部'));
    expect(all.items.map(j=>j.majorStatus).sort()).toEqual(['matched','unrestricted']);
    expect(listRecords(store,'job',new URLSearchParams('status=专业符合')).total).toBe(2);
    const intent=listRecords(store,'job',new URLSearchParams('status=拟投递'));
    expect(intent.items.map(j=>j.id)).toEqual(['specific']);
    expect(intent.items[0].majorStatus).toBe('matched');
    expect(store.get('unlimited').status).toBe('收藏');
  });
  it('rechecks changed profile facts and changed source evidence between requests',()=>{
    const {profile,ann}=seed();
    expect(listRecords(store,'job',new URLSearchParams('status=专业符合')).total).toBe(2);
    store.put(profile.id,'profile',{...profile,education:[{level:'本科',major:'城市管理',code:'120405'}]},profile.version);
    expect(listRecords(store,'job',new URLSearchParams('status=专业符合')).items.map(j=>j.id)).toEqual(['unlimited']);
    expect(listRecords(store,'job',new URLSearchParams('status=拟投递')).items[0].majorStatus).toBe('excluded');
    store.put(ann.id,'announcement',{...ann,body:longText+'该公告内容已经撤回'},ann.version);
    expect(listRecords(store,'job',new URLSearchParams('status=专业符合')).total).toBe(0);
    expect(listRecords(store,'job',new URLSearchParams('status=待核对')).total).toBe(2);
  });
  it('searches the refreshed reason without storing derived verdicts or calling AI',()=>{
    seed();
    const before=store.db.prepare('SELECT * FROM records ORDER BY id').all();
    expect(listRecords(store,'job',new URLSearchParams('q=专业符合')).items.map(j=>j.id)).toEqual(['unlimited']);
    expect(listRecords(store,'job',new URLSearchParams('q=旧判断')).total).toBe(0);
    expect(store.db.prepare('SELECT * FROM records ORDER BY id').all()).toEqual(before);
    expect(store.db.prepare('SELECT COUNT(*) count FROM ai_requests').get()?.count).toBe(0);
  });
});
