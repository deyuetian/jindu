// Runtime-only check: synthetic data, no worker, network, credentials or real records.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../../backend/db.ts';
import {parseAnalysis,AIOutputError,modelText} from '../../backend/analysis-output.ts';
import {analysisRecovery,checkpointAnalysisWork,outputRepairLimit} from '../../backend/analysis-recovery.ts';
import {announcementReport} from '../../backend/announcement-report.ts';
import {announcementScreenView} from '../../backend/recruitment-reader.ts';
const base={relevant:true,type:'选调',summary:'合成公告',jobs:[]};
const result=parseAnalysis('说明：```json\n'+JSON.stringify(base)+'\n```');assert.equal(result.type,'选调');
assert.throws(()=>parseAnalysis('{} {}'),AIOutputError);
const criterion=date=>({...base,commonEligibility:[{label:'资格',mode:'all',evidence:'原文资格条件',criteria:[{kind:'political',label:'党员',evidence:'原文资格条件',asOf:date}]}]});
assert.equal(parseAnalysis(JSON.stringify(criterion('2026年10月5日'))).commonEligibility[0].criteria[0].asOf,'2026-10-05');
assert.throws(()=>parseAnalysis(JSON.stringify(criterion('2026-02-30'))),AIOutputError);
assert.equal(modelText({choices:[{message:{content:[{type:'text',text:'a'},{type:'text',text:'b'}]}}]}),'ab');
assert.equal(outputRepairLimit,4);
const store=new Store(mkdtempSync(join(tmpdir(),'jindu-resilience-')));
try{
 const ann=store.put('ann','announcement',{title:'合成选调公告',type:'选调',body:'合成原文',contentHash:'fixture',analysisStatus:'partial',analysisPendingParts:1,status:'pending',candidates:[]});
 const work={signature:'fixture',sourceHash:'fixture',recoveryVersion:1,index:3,repairs:4,stopped:false,baseIssues:[],issues:[],results:[result,result],segments:[{outcome:'complete',resultIndex:0},{outcome:'failed',outputRepairs:4,partName:'合成附件',failure:{code:'format',message:'日期格式待修正'}},{outcome:'complete',resultIndex:1}]};
 checkpointAnalysisWork(store,ann.id,work);assert.equal(work.issues.length,1);
 const screen=announcementScreenView(announcementReport(store,ann));assert.equal(screen.analysisRecovery.saved,2);assert.equal(screen.analysisRecovery.pending,1);
 store.enqueueAnalysis('ann',true);const resumed=store.getSetting('analysis:ann',{});
 assert.equal(resumed.index,1);assert.equal(resumed.results.length,2);assert.equal(resumed.segments[1].outputRepairs,0);assert.equal(resumed.segments[2].outcome,'complete');assert.equal(resumed.issues.length,0);
 assert.equal(analysisRecovery(resumed).saved,2);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ai_requests').get().n,0);
 console.log(JSON.stringify({passed:true,checks:12,externalAICalls:0,syntheticOnly:true}));
}finally{store.db.close();}
