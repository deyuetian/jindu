// Run inside an isolated container against a read-only, credential-free test database.
// Only counts and timings leave the process; no web server, worker or AI is started.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../../backend/db.ts';
import {listRecords} from '../../backend/listings.ts';
import {announcementReport} from '../../backend/announcement-report.ts';
import {matchJob} from '../../backend/matching.ts';
import {jobCalendar} from '../../backend/job-actions.ts';
import {recruitmentReader} from '../../backend/recruitment-reader.ts';
import {listingLocations} from '../../backend/listing-locations.ts';
import {locationText} from '../../shared/job-location.ts';
import {parsePlaces} from '../../shared/location-filter.ts';

const [database='/check/recruitment.sqlite',threshold='5000']=process.argv.slice(2);
const maximumMs=Number(threshold);
assert(Number.isFinite(maximumMs)&&maximumMs>0);
const store=Object.create(Store.prototype);
store.db=new DatabaseSync(database,{readOnly:true});
store.dir='/not-mounted';
store.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');
const checks=[];
const timed=(name,fn)=>{
  const start=performance.now(),value=fn(),milliseconds=Math.round(performance.now()-start);
  checks.push({name,milliseconds});
  assert(milliseconds<=maximumMs,`${name} exceeded ${maximumMs} ms`);
  return value;
};
try{
  assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
  const tables=store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name).sort();
  assert.deepEqual(tables,['files','records','settings']);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM settings WHERE key!='sources' AND key NOT GLOB 'analysis:*' AND key NOT GLOB 'workbook-v2:*'").get().n,0);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM records WHERE kind NOT IN ('announcement','job','profile','exam')").get().n,0);
  const jobs=store.list('job').filter(j=>!j.archived&&j.analysisCurrent!==false);
  const all=timed('jobs-all-20',()=>listRecords(store,'job',new URLSearchParams('status=全部&pageSize=20')));
  assert.equal(all.total,jobs.length);
  const majors=timed('jobs-major-20',()=>listRecords(store,'job',new URLSearchParams('status=专业符合&pageSize=20')));
  const repeatedStart=performance.now();
  const repeated=timed('jobs-major-cards-repeat',()=>listRecords(store,'job',new URLSearchParams('status=专业符合&pageSize=20&view=cards')));
  assert(performance.now()-repeatedStart<=750,'Repeated major filtering exceeded 750 ms');
  assert.deepEqual(repeated.items.map(j=>[j.id,j.majorStatus]),majors.items.map(j=>[j.id,j.majorStatus]));
  for(const job of repeated.items){assert.equal(typeof job.majorSummary,'string');assert.equal(job.eligibilityRequirements,undefined);}
  const unknown=timed('jobs-unknown-20',()=>listRecords(store,'job',new URLSearchParams('status=待核对&pageSize=20')));
  const followed=timed('jobs-followed-20',()=>listRecords(store,'job',new URLSearchParams('status=关注&pageSize=20')));
  assert.equal(followed.total,jobs.filter(j=>['关注','拟投递'].includes(j.status)).length);
  timed('jobs-search-20',()=>listRecords(store,'job',new URLSearchParams('q=专业符合&pageSize=20')));
  const large=timed('jobs-all-100',()=>listRecords(store,'job',new URLSearchParams('status=全部&pageSize=100')));
  assert.equal(large.items.length,Math.min(100,jobs.length));
  const last=timed('jobs-last-page',()=>listRecords(store,'job',new URLSearchParams('page=999999&pageSize=20')));
  assert.equal(last.page,last.pages);
  timed('announcements-20',()=>listRecords(store,'announcement',new URLSearchParams('pageSize=20')));
  const linked=store.list('exam').filter(e=>e.calendarKind!=='personal');
  let importedCount=0;
  for(let page=1;;page++){
    const result=timed('announcement-calendar-labels-'+page,()=>listRecords(store,'announcement',new URLSearchParams({page:String(page),pageSize:'100'})));
    for(const ann of result.items){
      const matches=linked.filter(e=>e.announcementId===ann.id||!e.announcementId&&e.id==='exam:'+ann.id);
      const expected=matches.some(e=>!e.archived)?'added':matches.length?'archived':'';
      assert.equal(ann.calendarStatus,expected);if(expected)importedCount++;
    }
    if(page>=result.pages)break;
  }
  assert.equal(listRecords(store,'announcement',new URLSearchParams('status=已加入日历')).total,importedCount);
  const location=all.locations.find(p=>p.province==='湖北省'&&p.cities.length)||all.locations.find(p=>p.cities.length);
  if(location){
    const query=new URLSearchParams({province:location.province,view:'cards',pageSize:'20'});
    const province=timed('jobs-province',()=>listRecords(store,'job',query));
    query.set('city',location.cities[0]);
    const city=timed('jobs-city',()=>listRecords(store,'job',query));
    assert(city.total>0&&city.total<=province.total);
    assert.deepEqual(city.locations,all.locations);
    timed('announcements-city',()=>listRecords(store,'announcement',query));
  }
  const profiles=store.list('profile'),sources=new Map(),reader=recruitmentReader(store),locations=listingLocations(store);
  let expectedMatched=0,expectedUnknown=0;
  // Independent eager matching must agree with the optimized list filters.
  for(const job of jobs){
    let current=reader.facts(job);
    if(job.announcementId){
      if(!sources.has(job.announcementId))sources.set(job.announcementId,store.sourceText(job.announcementId));
      current={...current,...matchJob(current,profiles,sources.get(job.announcementId))};
    }
    if(['matched','unrestricted'].includes(current.majorStatus))expectedMatched++;
    if(job.announcementId&&(!current.majorStatus||current.majorStatus==='unknown'))expectedUnknown++;
    const shown=reader.job(job);
    assert.equal(locationText(locations.job.get(job.id)||[]),locationText(parsePlaces(shown.displayRegion)));
    if(shown.sourceRow&&shown.sourceRow.sheet!=='网页岗位')assert(shown.sourcePosition?.fields?.length,'Missing retained table facts');
    if(shown.analysisQuality?.issues?.some(s=>/专业|学历|匹配分析/.test(s)))assert.equal(shown.majorStatus,'unknown');
    if(profiles.filter(p=>!p.archived).length===1)assert.notEqual(shown.profileState,'missing');
  }
  assert.equal(majors.total,expectedMatched);
  assert.equal(unknown.total,expectedUnknown);
  const counts=new Map();
  for(const job of jobs)if(job.announcementId)counts.set(job.announcementId,(counts.get(job.announcementId)||0)+1);
  const largest=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,3);
  for(const [index,[id,count]] of largest.entries()){
    const report=timed(`announcement-detail-${index+1}`,()=>announcementReport(store,store.get(id)));
    assert.equal(report.jobs.length,count);
  }
  const calendarCounts=[];
  for(const id of ['cau:383b8f4c442e48fa82daa7aed6056a43','cau:58883baebcff45a381647ca95adfc37d']){
    const job=jobs.find(j=>j.announcementId===id);if(!job)continue;
    const preview=timed('calendar-preview-'+calendarCounts.length,()=>jobCalendar(store,job.id));
    assert.equal(preview.stages.filter(s=>s.label==='报名开始').length,1);
    assert.equal(preview.stages.filter(s=>s.label==='报名截止').length,1);
    const dates=preview.stages.map(s=>s.date+' '+s.time);assert.deepEqual(dates,[...dates].sort());
    calendarCounts.push(preview.stages.length);
  }
  assert.equal(store.db.prepare('PRAGMA query_only').get().query_only,1);
  console.log(JSON.stringify({passed:true,checks,maximumMs,jobs:jobs.length,matched:majors.total,unknown:unknown.total,details:largest.length,calendarCounts,rss:process.memoryUsage().rss,externalAICalls:0,readOnly:true}));
}catch(error){
  console.log(JSON.stringify({passed:false,checks,errorType:error.name,externalAICalls:0,readOnly:true}));
  process.exitCode=1;
}finally{store.db.close();}
