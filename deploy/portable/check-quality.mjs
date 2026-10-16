// Synthetic, offline checks for the new read model and row completeness gate.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../backend/db.ts';
import {recruitmentReader} from '../../backend/recruitment-reader.ts';
import {listRecords} from '../../backend/listings.ts';
import {jobDetail} from '../../backend/job-actions.ts';
import {reviewTableJobs} from '../../backend/position-quality.ts';
import {majorRequirementText} from '../../shared/job-display.ts';
const store=new Store(mkdtempSync(join(tmpdir(),'jindu-quality-')));
try{
 const fields=[{header:'选调\n市（州）',value:'巴中市'},{header:'学历',value:'本科及以上'},{header:'专业要求',value:'机械类'}];
 const row={row:87,fields,text:'[岗位表 第 87 行] '+fields.map(f=>'【'+f.header+'】'+f.value).join(' | ')};
 store.put('profile','profile',{title:'我的条件',education:[{level:'硕士',major:'土壤学',code:'090301'}]});
 store.put('ann','announcement',{title:'四川省2027年选调公告',province:'四川',body:'岗位要求',fileIds:['file'],analysisStatus:'done'});
 store.db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?)').run('file','ann','岗位.xlsx','','xlsx',10,'hash',row.text,'');
 store.setSetting('workbook-v2:file',{text:row.text,error:'',tables:[{sheet:'岗位表',rows:[row],headers:[],notes:[],complete:true}]});
 store.put('job','job',{title:'岗位',province:'四川',announcementId:'ann',sourceRow:{fileId:'file',fileName:'岗位.xlsx',sheet:'岗位表',row:87,rowId:'row'},sourceRowId:'row',majorRequirements:[],status:'关注',notes:'保留备注'});
 const before=store.db.prepare('SELECT total_changes() n').get().n;
 const list=listRecords(store,'job',new URLSearchParams('province=四川&city=巴中市')),detail=jobDetail(store,'job');
 assert.equal(list.total,1);assert.equal(list.items[0].displayRegion,'四川省 · 巴中市');assert.equal(detail.displayRegion,list.items[0].displayRegion);
 assert.equal(detail.sourcePosition.education,'本科及以上');assert.equal(majorRequirementText(detail),'机械类');assert.equal(detail.profileState,'ready');assert.equal(detail.majorStatus,'unknown');
 assert.equal(detail.sourcePosition.fields.length,3);assert.equal(detail.status,'关注');assert.equal(detail.notes,'保留备注');
 assert.equal(recruitmentReader(store).job(store.get('job')).analysisQuality.status,'partial');
 const reviewed=reviewTableJobs([{rowId:'row',text:row.text}],[]);assert.equal(reviewed.retryRows.length,1);assert.equal(reviewed.jobs[0].sourcePosition.major,'机械类');
 assert.equal(store.db.prepare('SELECT total_changes() n').get().n,before);
 store.put('exam:ann','exam',{title:'公告日历',stages:[]});
 assert.equal(listRecords(store,'announcement',new URLSearchParams()).items[0].calendarStatus,'added');
 assert.equal(listRecords(store,'announcement',new URLSearchParams('status=已加入日历')).total,1);
 const exam=store.get('exam:ann');store.put(exam.id,'exam',{...exam,archived:true},exam.version);
 assert.equal(listRecords(store,'announcement',new URLSearchParams()).items[0].calendarStatus,'archived');
 console.log(JSON.stringify({passed:true,locationConsistent:true,originalCells:true,profileStatus:true,missingRowsDetected:true,readWrites:0,externalAICalls:0}));
}finally{store.db.close();}
