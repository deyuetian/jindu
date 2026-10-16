// Isolated image check. Temporary data only; no server, worker or external request.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../backend/db.ts';
import {listRecords} from '../../backend/listings.ts';
import {announcementReport} from '../../backend/announcement-report.ts';
import {majorRequirementText,majorSummary} from '../../shared/job-display.ts';
import {overviewFacts} from '../../shared/announcement-presentation.ts';

const store=new Store(mkdtempSync(join(tmpdir(),'jindu-interaction-')));
try{
  const names=Array.from({length:24},(_,i)=>'示例专业'+(i+1)),locations=Array.from({length:24},(_,i)=>'示例城市'+(i+1)).join('、');
  const ann=store.put('check:notice','announcement',{title:'示例招聘',body:'招收'+names.join('、'),type:'企业招聘',published:'2026-09-23',introduction:{locations}});
  const job=store.put('check:job','job',{title:'研究岗',announcementId:ann.id,type:'企业招聘',majorRequirements:[{names,codes:['090301'],evidence:ann.body}]});
  assert(majorRequirementText(job).endsWith('示例专业24'));
  assert(majorSummary(job).length<majorRequirementText(job).length);
  assert.equal(listRecords(store,'job',new URLSearchParams({q:'示例专业24'})).total,1);
  assert.equal(listRecords(store,'job',new URLSearchParams({q:'090301'})).total,1);
  const report=announcementReport(store,ann);
  assert.equal(overviewFacts(report).find(f=>f.key==='locations').text,locations);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
  console.log(JSON.stringify({passed:true,completeMajor:true,completeOverview:true,majorSearch:true,aiRequests:0}));
}finally{store.db.close();}
