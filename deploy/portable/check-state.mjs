// Offline runtime smoke test with disposable data. No worker, API or production files.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../backend/db.ts';
import {schemas} from '../../backend/model.ts';
import {calendarExamView} from '../../shared/calendar-policy.ts';
import {announcementReport} from '../../backend/announcement-report.ts';
import {announcementScreenView,recruitmentReader} from '../../backend/recruitment-reader.ts';
import {listRecords} from '../../backend/listings.ts';
const store=new Store(mkdtempSync(join(tmpdir(),'jindu-state-'))),RealDate=Date;
try{
 const base={date:'2026-10-14',time:'10:00',origin:'ai',manualEdited:false};
 const raw=store.put('exam:ann','exam',schemas.exam.parse({title:'合成选调',type:'选调',url:'',announcementId:'ann',archived:true,stages:[{...base,id:'old',label:'打印笔试准考证开始'},{...base,id:'new',label:'准考证打印开始'}]}));
 assert.equal(calendarExamView(raw).stages.length,1);assert.equal(store.get(raw.id).stages.length,2);
 const ann=store.put('ann','announcement',{title:'合成选调',type:'选调',status:'accepted',province:'湖北省',body:'岗位不限专业；须持有安全员证',candidates:[]});
 const report=announcementScreenView(announcementReport(store,ann));assert.equal(report.calendarStatus,'archived');assert.equal(report.calendar.id,raw.id);
 assert.equal(listRecords(store,'announcement',new URLSearchParams({status:'已加入日历'})).total,0);
 store.save('profile',{title:'合成条件',education:[{level:'本科',major:'土壤学'}],eligibility:{certificatesStatus:'complete',certificates:[{name:'安全员证',date:'2025-01-01',expires:'2026-10-14'}]}});
 store.put('job','job',schemas.job.parse({title:'测试岗',type:'选调',url:'',announcementId:'ann',eligibilityCoverage:'complete',majorRequirements:[{unrestricted:true,evidence:'岗位不限专业'}],eligibilityRequirements:[{label:'证书',mode:'all',evidence:'须持有安全员证',criteria:[{kind:'certificate',label:'安全员证',accepted:['安全员证'],evidence:'须持有安全员证'}]}]}));
 let clock='2026-10-14T15:59:59Z';globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[clock]));}static now(){return RealDate.parse(clock);}};
 const read=()=>{const r=recruitmentReader(store);return r.job(r.get('job'));};
 const first=read();assert.equal(first.eligibilityChecks.status,'met');assert.equal(read(),first);
 clock='2026-10-14T16:00:00Z';assert.equal(read().eligibilityChecks.status,'unmet');
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ai_requests').get().n,0);
 console.log(JSON.stringify({passed:true,calendarDeduplicated:true,archivedHidden:true,midnightRefreshed:true,externalAICalls:0}));
}finally{globalThis.Date=RealDate;store.db.close();}
