import {describe,it,expect} from 'vitest';
import {eligibilityFactsSchema,eligibilityGroupsSchema,evaluateEligibility,genderRequirement} from '../shared/eligibility.ts';
import {chinaLocations} from '../shared/china-locations.ts';
import {placeOptions} from '../shared/location-filter.ts';
import {compareCities,cityPlateLetter} from '../shared/location-order.ts';
import {createViewState} from '../src/view-state.ts';
import {normalizeNavigationOrder,moveNavigationItem} from '../src/navigation-order.ts';
import {matchJob} from '../backend/matching.ts';

const clause='仅限男性报考';
const groups=(evidence=clause,kind='gender',accepted=['男'])=>eligibilityGroupsSchema.parse([{label:'性别要求',mode:'all',evidence,criteria:[{kind,label:'性别',evidence,accepted}]}]);
describe('personal gender and evidence',()=>{
  it('keeps old profiles unspecified and rejects arbitrary gender values',()=>{
    expect(eligibilityFactsSchema.parse({}).gender).toBe('');
    expect(eligibilityFactsSchema.safeParse({gender:'自动推断'}).success).toBe(false);
  });
  it('compares explicit evidence with the saved value; missing is not a mismatch',()=>{
    for(const [gender,status] of [['男','met'],['女','unmet'],['','missing']])expect(evaluateEligibility(groups(),eligibilityFactsSchema.parse({gender}),clause).status).toBe(status);
    expect(evaluateEligibility(groups(),null,clause).status).toBe('missing');
  });
  it('keeps unsupported preferences, exceptions and invented quotations reviewable',()=>{
    for(const text of ['男性优先','适合男性','限男性，女性硕士也可','不限专业'])expect(genderRequirement(text)).toBeNull();
    expect(evaluateEligibility(groups('男性优先'),{gender:'女'},'男性优先').status).toBe('review');
    expect(evaluateEligibility(groups(),{gender:'男'},'仅限女性报考').status).toBe('review');
    expect(evaluateEligibility(groups(clause,'gender',['女']),{gender:'女'},clause).status).toBe('review');
  });
  it('reuses a simple legacy other clause and accepts explicitly unrestricted gender',()=>{
    expect(evaluateEligibility(groups(clause,'other',[]),{gender:'女'},clause).status).toBe('unmet');
    expect(evaluateEligibility(groups('性别：不限','gender',['男','女']),null,'性别：不限').status).toBe('met');
  });
  it('changes the job decision when only the personal gender changes, without model analysis',()=>{
    const source='不限专业。'+clause;
    const job={majorRequirements:[{unrestricted:true,evidence:'不限专业'}],eligibilityCoverage:'complete',eligibilityRequirements:groups(),analysisIncomplete:false};
    const profile={id:'p',includeUnrestricted:true,education:[{level:'硕士',major:'土壤学'}]};
    expect(matchJob(job,[{...profile,eligibility:eligibilityFactsSchema.parse({gender:'男'})}],source).match).toBe('符合');
    expect(matchJob(job,[{...profile,eligibility:eligibilityFactsSchema.parse({gender:'女'})}],source).match).toBe('不符合');
    expect(matchJob(job,[{...profile,conditions:'我叫小明'}],source).match).toBe('待核对');
  });
});

describe('region order',()=>{
  it('puts nationwide before the full administrative province sequence without losing options',()=>{
    const provinces=['全国',...chinaLocations.map(p=>p.province)];
    expect(placeOptions([...provinces].reverse().map(province=>[{province,city:''}])).map(p=>p.province)).toEqual(provinces);
  });
  it('uses plate order rather than pinyin or administrative city order',()=>{
    for(const [province,input,wanted] of [
      ['浙江省',['舟山市','嘉兴市','绍兴市','湖州市','杭州市'],['杭州市','绍兴市','湖州市','嘉兴市','舟山市']],
      ['湖北省',['随州市','恩施土家族苗族自治州','宜昌市','荆州市','武汉市'],['武汉市','荆州市','宜昌市','恩施土家族苗族自治州','随州市']],
      ['四川省',['眉山市','德阳市','资阳市','绵阳市','自贡市','成都市'],['成都市','绵阳市','自贡市','德阳市','资阳市','眉山市']],
    ] as const)expect([...input].sort((a,b)=>compareCities(province,a,b))).toEqual(wanted);
  });
  it('preserves every mapped city, including provincial direct cities and unknown values',()=>{
    for(const row of chinaLocations){const sorted=[...row.cities].reverse().sort((a,b)=>compareCities(row.province,a,b));expect(new Set(sorted)).toEqual(new Set(row.cities));}
    expect(cityPlateLetter('河南省','济源市')).toBe('U');
    expect(['儋州市','五指山市','文昌市','琼海市','海口市'].sort((a,b)=>compareCities('海南省',a,b))).toEqual(['海口市','琼海市','文昌市','五指山市','儋州市']);
    expect(cityPlateLetter('新疆维吾尔自治区','阿拉尔市')).toBe('N');
    expect(['未识别城市','银川市','固原市'].sort((a,b)=>compareCities('宁夏回族自治区',a,b))).toEqual(['银川市','固原市','未识别城市']);
  });
});

function storage(){const rows=new Map<string,string>();return {getItem:(k:string)=>rows.get(k)??null,setItem:(k:string,v:string)=>{rows.set(k,v);},removeItem:(k:string)=>{rows.delete(k);}};}
describe('page selections',()=>{
  it('isolates pages, survives refresh and retains pages not yet visited after refresh',()=>{
    const disk=storage(),a=createViewState(disk);a.set('jobs:filters',{q:'土壤',province:'湖北省'});a.set('jobs:page',3);a.set('announcements:page',2);
    const b=createViewState(disk);expect(b.get('jobs:page',1)).toBe(3);b.set('tasks:search','会议');
    const c=createViewState(disk);expect(c.get('jobs:filters',{q:'',province:''})).toEqual({q:'土壤',province:'湖北省'});expect(c.get('announcements:page',1)).toBe(2);
  });
  it('clears selections on sign-out and notifies mounted readers',()=>{
    const disk=storage(),views=createViewState(disk);let notified=0;const unsubscribe=views.subscribe(()=>notified++);
    views.set('page',4);views.clear();expect(views.get('page',1)).toBe(1);expect(createViewState(disk).get('page',1)).toBe(1);expect(notified).toBe(2);unsubscribe();
  });
  it('tolerates corrupt storage, wrong shapes and unavailable browser storage',()=>{
    const disk=storage();disk.setItem('jindu:page-selections:v1','{broken');expect(createViewState(disk).get('page',1)).toBe(1);
    disk.setItem('jindu:page-selections:v1',JSON.stringify({page:-1,filters:{q:42}}));const views=createViewState(disk);expect(views.get('page',1)).toBe(1);expect(views.get('filters',{q:''})).toEqual({q:''});
    const blocked={getItem(){throw Error();},setItem(){throw Error();},removeItem(){throw Error();}};const memory=createViewState(blocked);memory.set('page',2);expect(memory.get('page',1)).toBe(2);expect(()=>memory.clear()).not.toThrow();
  });
});

describe('navigation order',()=>{
  const pages=['overview','agent','jobs','profile'];
  it('removes duplicates and obsolete items and appends new pages',()=>{
    expect(normalizeNavigationOrder(['jobs','jobs','removed','overview'],pages)).toEqual(['jobs','overview','agent','profile']);
    expect(normalizeNavigationOrder(null,pages)).toEqual(pages);
  });
  it('moves in either direction without dropping pages',()=>{
    expect(moveNavigationItem(pages,'overview','jobs')).toEqual(['agent','jobs','overview','profile']);
    expect(moveNavigationItem(pages,'profile','overview')).toEqual(['profile','overview','agent','jobs']);
    expect(moveNavigationItem(pages,'missing','overview')).toEqual(pages);
  });
});
