// Isolated image check: temporary data, no worker, network, credentials or production writes.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../backend/db.ts';
import {schemas} from '../../backend/model.ts';
import {jobCalendar,addJobCalendar,updateJobProgress} from '../../backend/job-actions.ts';
import {announcementReport} from '../../backend/announcement-report.ts';
import {listRecords} from '../../backend/listings.ts';
import {normalizeCalendarStages,stageMilestone} from '../../shared/calendar-policy.ts';
const store=new Store(mkdtempSync(join(tmpdir(),'jindu-calendar-focus-')));
try{
  const s=(id,label,date,time='09:00')=>({id,label,date,time,evidence:'日期来自公开样例',inferredYear:false});
  const candidates=[s('transfer','调剂报名开始','2026-11-02'),s('alias','网上报名开始','2026-09-20'),s('canonical','报名开始','2026-09-20'),s('end','报名截止','2026-09-23','18:00'),s('alternate','改报截止','2026-09-23','18:00')];
  const ann=store.put('fixture','announcement',{title:'示例2027年选调公告',type:'选调',url:'',candidates});
  for(const [id,status] of [['old','拟投递'],['new','未选择'],['automatic','收藏']])store.put(id,'job',schemas.job.parse({title:id,type:'选调',url:'',announcementId:ann.id,status}));
  assert.equal(store.snapshot().jobCounts.intended,1);
  assert.equal(listRecords(store,'job',new URLSearchParams('status=关注')).items[0].applicationStatus,'关注');
  updateJobProgress(store,'new',{version:1,status:'关注'});assert.equal(store.snapshot().jobCounts.intended,2);
  const preview=jobCalendar(store,'old');assert.equal(preview.stages.length,4);assert.equal(preview.stages[0].label,'报名开始');assert.equal(stageMilestone(preview.stages.at(-1)),undefined);
  assert.equal(announcementReport(store,ann).candidates.length,4);
  const input={version:ann.version,stageIds:preview.stages.map(s=>s.id),follow:false};
  const added=addJobCalendar(store,'old',input);assert.equal(store.get(added.id).stages.length,4);assert.equal(addJobCalendar(store,'new',input).id,added.id);assert.equal(store.list('exam').length,1);
  assert.equal(normalizeCalendarStages([s('a','报名开始','2026-09-20','09:00'),s('b','网上报名开始','2026-09-20','10:00')]).length,2);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
  console.log(JSON.stringify({passed:true,aliases:true,chronology:true,separatePhases:true,conflictingTimesPreserved:true,legacyAttention:true,calendarImport:true,parentDeduplication:true,externalAICalls:0}));
}finally{store.db.close();}
