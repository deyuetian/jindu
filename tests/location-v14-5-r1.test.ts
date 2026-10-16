import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../backend/db.ts';
import {listRecords} from '../backend/listings.ts';
import {parsePlaces} from '../shared/location-filter.ts';
import {listingLocations} from '../backend/listing-locations.ts';

let store:Store,worker:Store;
beforeEach(()=>{mkdirSync('.check/location-v14-5-r1/tests',{recursive:true});store=new Store(mkdtempSync(resolve('.check/location-v14-5-r1/tests/case-')));worker=new Store(store.dir);store.save('profile',{title:'合成条件',includeUnrestricted:true,education:[{level:'硕士',major:'土壤学'}]});});
afterEach(()=>{worker.db.close();store.db.close();});
const list=(kind:'job'|'announcement',filters:Record<string,string>={})=>listRecords(store,kind,new URLSearchParams(filters));
function ann(id:string,province='',locations=''){
  return store.put(id,'announcement',{title:'示例企业2027年招聘',type:'企业招聘',province,introduction:{locations},published:'2026-09-23',status:'pending',source:'北京市学校就业网',body:'不限专业'});
}
function job(id:string,announcementId='',province='',location='',extra:any={}){
  return store.put(id,'job',{title:'技术岗位 '+id,type:'企业招聘',organization:'北京市总部',province,announcementId,sourcePosition:{location},majorRequirements:[{unrestricted:true,evidence:'不限专业'}],status:'未选择',...extra});
}
describe('province and city filtering',()=>{
  it('normalizes abbreviations, multiple places, municipalities and autonomous prefectures',()=>{
    expect(parsePlaces('湖北、武汉市、湖北省武汉、上海、成都')).toEqual([
      {province:'湖北省',city:'武汉市'},{province:'上海市',city:'上海市'},{province:'四川省',city:'成都市'},
    ]);
    expect(parsePlaces('新疆乌鲁木齐、恩施州、延边、文山州')).toEqual([
      {province:'新疆维吾尔自治区',city:'乌鲁木齐市'},{province:'湖北省',city:'恩施土家族苗族自治州'},
      {province:'吉林省',city:'延边朝鲜族自治州'},{province:'云南省',city:'文山壮族苗族自治州'},
    ]);
    expect(parsePlaces('吉林')).toEqual([{province:'吉林省',city:''}]);
    expect(parsePlaces('吉林市、海南州')).toEqual([{province:'吉林省',city:'吉林市'},{province:'青海省',city:'海南藏族自治州'}]);
    expect(parsePlaces('南京路、吉林大学、海南区、地点待确认')).toEqual([]);
  });
  it('uses a job location instead of broad parent locations or an employer address',()=>{
    ann('multi','全国','上海、武汉');job('w','multi','全国','湖北省武汉市');job('s','multi','上海');job('u','','');
    expect(list('job',{province:'湖北'}).items.map(j=>j.id)).toEqual(['w']);
    expect(list('job',{province:'湖北省',city:'武汉'}).items.map(j=>j.id)).toEqual(['w']);
    expect(list('job',{province:'上海市'}).items.map(j=>j.id)).toEqual(['s']);
    expect(list('job',{province:'北京市'}).total).toBe(0);
    expect(list('job',{province:'湖南省',city:'武汉市'}).total).toBe(0);
  });
  it('includes related active job cities in announcement filters without guessing unknown cities',()=>{
    ann('hubei','湖北省');ann('only-province','湖北');ann('empty');
    job('w','hubei','湖北','武汉');job('old','empty','','北京市',{analysisCurrent:false});
    expect(list('announcement',{province:'湖北省'}).total).toBe(2);
    expect(list('announcement',{province:'湖北省',city:'武汉市'}).items.map(a=>a.id)).toEqual(['hubei']);
    expect(list('announcement',{province:'北京市'}).total).toBe(0);
    expect(list('announcement').locations).toEqual([{province:'湖北省',cities:['武汉市']}]);
  });
  it('supports multiple-city announcements and uses common locations only for otherwise unlocated jobs',()=>{
    ann('multi','','上海、天津、成都、武汉');job('inherited','multi');job('specific','multi','','上海');
    expect(list('announcement',{province:'四川省',city:'成都市'}).total).toBe(1);
    expect(list('job',{province:'四川省',city:'成都市'}).items.map(j=>j.id)).toEqual(['inherited']);
    expect(list('job',{province:'上海',city:'上海'}).total).toBe(2);
  });
  it('recognizes the city in an explicitly named city-level position',()=>{
    ann('hunan','湖南');job('huaihua','hunan','湖南','',{title:'怀化市直岗位6'});
    expect(list('job',{province:'湖南省',city:'怀化市'}).total).toBe(1);
    expect(list('announcement',{province:'湖南省',city:'怀化市'}).total).toBe(1);
  });
  it('combines locations with status, search, source, dates and pagination before counting',()=>{
    ann('a','湖北');ann('b','湖南');
    for(let i=0;i<24;i++)job('w'+i,'a','湖北','武汉',{status:i===0?'关注':'未选择'});
    job('cs','b','湖南','长沙');
    const result=list('job',{province:'湖北省',city:'武汉市',page:'2',pageSize:'10',status:'专业符合',from:'2026-09-01',to:'2026-09-30'});
    expect(result).toMatchObject({page:2,pages:3,total:24});expect(result.items).toHaveLength(10);
    expect(list('job',{province:'湖北省',city:'武汉市',status:'关注'}).total).toBe(1);
    expect(list('job',{province:'湖北省',city:'武汉市',q:'cs'}).total).toBe(0);
    expect(list('job',{province:'湖北省',city:'武汉市',sourceId:'other'}).total).toBe(24);
    expect(list('job',{province:'湖北省',from:'2026-09-24'}).total).toBe(0);
    expect(list('job',{province:'湖北省',q:'不存在'}).locations.some(p=>p.province==='湖南省')).toBe(true);
  });
  it('refreshes cached choices for worker edits, local deletes and transaction rollback',()=>{
    ann('a','湖北');const j=job('w','a','湖北','武汉');
    const first=listingLocations(store);expect(listingLocations(store)).toBe(first);
    worker.put('w','job',{...j,province:'湖南',sourcePosition:{location:'长沙'}},j.version);
    expect(list('job',{province:'湖南省',city:'长沙市'}).total).toBe(1);
    store.db.exec('BEGIN');store.db.exec("UPDATE records SET data=json_set(data,'$.sourcePosition.location','上海') WHERE id='w'");
    expect(list('job',{province:'上海市'}).total).toBe(1);store.db.exec('ROLLBACK');
    expect(list('job',{province:'上海市'}).total).toBe(0);
    store.db.exec("DELETE FROM records WHERE id='w'");expect(list('job').locations).toEqual([]);
  });
});
