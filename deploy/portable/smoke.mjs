// An isolated runtime check. Uses a fresh temporary directory and never loads JINDU_CONFIG.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createApp} from '../../backend/app.ts';
import {saveAI} from '../../backend/config.ts';
import {beginUsage,finishUsage,measuredUsage,usageSummary} from '../../backend/usage.ts';
import {fileTool} from '../../backend/files.ts';
import {prefilterRow} from '../../backend/job-tables.ts';
import {recruitmentSkill} from '../../backend/recruitment-skill.ts';
import {parseAnalysis} from '../../backend/analysis-output.ts';
import {isAttachmentLink} from '../../backend/attachment-links.ts';
import {schemas} from '../../backend/model.ts';
import {regionName} from '../../shared/job-display.ts';
import {makeBackup,restoreBackup} from '../../backend/backup.ts';
import {releaseContract} from '../../backend/version.ts';
import {startWorkerHeartbeat} from '../../backend/runtime-health.ts';
const dir=mkdtempSync(join(process.env.JINDU_TEST_TEMP||tmpdir(),'jindu-smoke-'));
const password=randomBytes(24).toString('base64url'),salt=randomBytes(16).toString('hex');
const digest=createHash('sha256').update('jindu-login-v1\0'+salt+'\0'+password).digest('hex');
const config={dataDir:dir,origin:'http://127.0.0.1',host:'127.0.0.1',port:0,adminUsername:'smoke',passwordHash:`random-v1$192$${salt}$${digest}`,masterKey:randomBytes(32).toString('hex'),distDir:resolve('dist'),python:process.env.JINDU_PYTHON||'/opt/python/bin/python'};
const {server,store}=createApp(config);
try{
  await new Promise((yes,no)=>{server.once('error',no);server.listen(config.port,config.host,yes);});
  config.origin='http://127.0.0.1:'+server.address().port;
  const response=await fetch(config.origin+'/api/login',{method:'POST',headers:{'content-type':'application/json',Origin:config.origin},body:JSON.stringify({username:config.adminUsername,password})});assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  const task=await fetch(config.origin+'/api/records/task',{method:'POST',headers:{'content-type':'application/json',Origin:config.origin,Cookie:cookie},body:JSON.stringify({data:{title:'Isolated deployment check',category:'日常',due:'2026-09-25',time:'',priority:'普通',done:false,notes:'',goalId:'',archived:false}})});assert.equal(task.status,201);
  const state=await fetch(config.origin+'/api/state?compact=1',{headers:{Cookie:cookie}}).then(r=>r.json());assert.equal(state.tasks.length,1);
  saveAI(store,{baseUrl:'https://example.com/v1',model:'fixture',dailyLimit:1,unlimited:true},config);
  for(let i=0;i<2;i++)finishUsage(store,beginUsage(store,'fixture','test',1,true),'success',measuredUsage({prompt_tokens:10,completion_tokens:2}));assert.equal(usageSummary(store).periods.today.calls,2);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  const files=join(dir,'parse');mkdirSync(files);
  execFileSync(config.python,['-c',`from pathlib import Path
from openpyxl import Workbook
from docx import Document
from pypdf import PdfWriter
import xlrd,lxml
p=Path(${JSON.stringify(files)})
w=Workbook();w.active.append(['SMOKE_XLSX']);w.save(p/'sample.xlsx')
w=Workbook();w.active.append(['岗位代码','岗位名称','专业要求']);w.active.append(['001','Soil research','土壤学']);w.active.append(['002','Software','计算机科学与技术']);w.save(p/'positions.xlsx')
d=Document();d.add_paragraph('SMOKE_DOCX');d.save(p/'sample.docx')
writer=PdfWriter();writer.add_blank_page(width=100,height=100)
with (p/'sample.pdf').open('wb') as f:writer.write(f)
`],{windowsHide:true,stdio:'pipe'});
  assert.match((await fileTool(config,['parse',join(files,'sample.xlsx'),'sample.xlsx'])).text,/SMOKE_XLSX/);
  assert.match((await fileTool(config,['parse',join(files,'sample.docx'),'sample.docx'])).text,/SMOKE_DOCX/);
  const pdf=await fileTool(config,['parse',join(files,'sample.pdf'),'sample.pdf']);assert.equal(typeof pdf.text,'string');
  const table=await fileTool(config,['parse',join(files,'positions.xlsx'),'positions.xlsx']);assert.equal(table.tables[0].rows.length,2);
  const profiles=[{education:[{level:'硕士',major:'土壤学',code:'090301'}]}];assert.equal(prefilterRow(table.tables[0].rows[0].fields,profiles),'candidate');assert.equal(prefilterRow(table.tables[0].rows[1].fields,profiles),'excluded');
  assert.match(recruitmentSkill,/岗位筛选与报考准备/);
  const endOfDay=parseAnalysis(JSON.stringify({relevant:true,type:'其他',summary:'sample',dates:[{label:'截止',date:'2026-10-31',time:'24:00'}]}));assert.equal(endOfDay.dates[0].date,'2026-11-01');assert.equal(endOfDay.dates[0].time,'00:00');
  assert.equal(isAttachmentLink({url:'https://example.com/apply',name:'报名入口'}),false);
  assert.equal(isAttachmentLink({url:'https://example.com/positions.xlsx',name:'岗位表'}),true);
  finishUsage(store,beginUsage(store,'fixture','recruitment',1,true),'success',measuredUsage({prompt_tokens:4,completion_tokens:2}));assert.equal(usageSummary(store).purposePeriods.today.find(p=>p.purpose==='recruitment').total,6);
  const report=await fileTool(config,['export-jobs'],60000,JSON.stringify({jobs:[{title:'Smoke post',positionCode:'001',match:'待核对',applicationItems:[]}]}));assert.equal(Buffer.from(report.base64,'base64').subarray(0,2).toString(),'PK');
  const ann=store.put('smoke-ann','announcement',{title:'湖北省2027年选调公告',type:'选调',body:'不限专业',status:'pending',province:'湖北',url:'https://example.com/notice',candidates:[{id:'deadline',label:'报名截止',date:'2026-10-10',time:'17:00',evidence:'报名截止 2026-10-10',inferredYear:false}]});
  for(const id of ['smoke-job','smoke-job-2'])store.put(id,'job',schemas.job.parse({title:'岗位11',type:'选调',province:'湖北',url:ann.url,announcementId:ann.id}));
  const headers={'content-type':'application/json',Origin:config.origin,Cookie:cookie};
  assert.equal((await fetch(config.origin+'/api/jobs/smoke-job/calendar')).status,401);
  const preview=await fetch(config.origin+'/api/jobs/smoke-job/calendar',{headers}).then(r=>r.json());assert.equal(preview.title,ann.title);
  const progress=await fetch(config.origin+'/api/jobs/smoke-job/progress',{method:'POST',headers,body:JSON.stringify({version:1,status:'关注'})});assert.equal(progress.status,200);assert.equal((await progress.json()).applicationStatus,'关注');
  const importBody=JSON.stringify({version:preview.version,stageIds:preview.stages.map(s=>s.id),follow:false});
  const added=await fetch(config.origin+'/api/jobs/smoke-job/calendar',{method:'POST',headers,body:importBody}).then(r=>r.json());
  const again=await fetch(config.origin+'/api/jobs/smoke-job-2/calendar',{method:'POST',headers,body:importBody}).then(r=>r.json());assert.equal(again.alreadyAdded,true);assert.equal(again.id,added.id);assert.equal(store.get(added.id).title,ann.title);
  assert.equal(regionName('湖北省武汉市'),'湖北省 · 武汉市');assert.match(recruitmentSkill,/关注/);
  assert.equal((await fetch(config.origin+'/api/health/details')).status,401);
  const heartbeat=startWorkerHeartbeat(store);
  try{
    const health=await fetch(config.origin+'/api/health/details',{headers}).then(r=>r.json());
    assert.equal(health.version,releaseContract.version);assert.equal(health.schemaVersion,releaseContract.schemaVersion);assert.equal(health.worker.healthy,true);
  }finally{heartbeat();}
  const marker=join(dir,'.update-maintenance');writeFileSync(marker,'synthetic-update');
  try{
    assert.equal((await fetch(config.origin+'/api/health')).status,200);
    assert.equal((await fetch(config.origin+'/api/state',{headers})).status,503);
    assert.equal((await fetch(config.origin+'/api/login',{method:'POST',headers,body:'{}'})).status,503);
  }finally{unlinkSync(marker);}
  // Business restore remains separate from the complete server update backup.
  const before=store.list('task'),backup=await makeBackup(store,config);
  const existing=before[0];store.put(existing.id,'task',{...existing,title:'Synthetic changed task'},existing.version);
  await restoreBackup(store,config,join(dir,'backups',backup.name));
  assert.equal(store.get(existing.id).title,existing.title);
  assert.equal((await fetch(config.origin+'/api/state',{headers})).status,401);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  console.log(JSON.stringify({passed:true,node:process.version,login:true,task:true,sqlite:true,unlimited:true,documents:true,positionTable:true,excelExport:true,bundledSkill:true,jobIntent:true,jobCalendar:true,parentDeduplication:true,regions:true,authenticatedHealth:true,maintenance:true,businessBackupRestore:true,externalAICalls:0}));
}finally{await new Promise(resolve=>server.close(resolve));store.db.close();}
