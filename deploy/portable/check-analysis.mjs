// Synthetic state only; optional public DOC originals are mounted read-only.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../../backend/db.ts';
import {analysisContext} from '../../backend/ai.ts';
import {analysisRecovery} from '../../backend/analysis-recovery.ts';
import {isCampusGuidanceImage,omitCampusImageWork} from '../../backend/analysis-materials.ts';
import {AIServiceError,aiCooldown,postponeAI,markAIWait,clearAICooldown,httpFailure} from '../../backend/ai-failure.ts';
import {fileTool} from '../../backend/files.ts';
const store=new Store(mkdtempSync(join(tmpdir(),'jindu-analysis-')));
try{
 const campus={id:'campus',mime:'image/png',name:'正文图片.png',sha256:'41d362352bbe3f63f8f770686363d2ea695e43b838fd87bc8509b52ec503cb9a'};
 assert.ok(isCampusGuidanceImage(campus));
 assert.ok(isCampusGuidanceImage({...campus,sha256:'new',name:'校内报考提示.png'}));
 assert.ok(!isCampusGuidanceImage({...campus,sha256:'new',name:'正式报考条件.png'}));
 const work={index:2,recoveryVersion:1,stopped:true,results:[{_source:'正文'},{_imageId:'campus'}],segments:[{text:'正文',outcome:'complete',resultIndex:0},{imageId:'campus',outcome:'failed',resultIndex:1,failure:{message:'旧图片问题'}}]};
 omitCampusImageWork(work,[campus]);assert.equal(work.stopped,false);assert.equal(work.results[1]._retired,true);
 assert.equal(analysisRecovery(work).total,1);assert.equal(analysisRecovery(work).saved,1);assert.equal(analysisRecovery(work).pending,0);
 store.put('ann','announcement',{title:'合成选调公告',body:'专业不限。',fileIds:['campus'],contentHash:'fixture'});
 store.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?)').run('campus','ann',campus.name,'https://example.invalid/guide','image/png',1,campus.sha256,'','');
 const context=await analysisContext(store,{dataDir:store.dir,python:process.env.JINDU_PYTHON},'ann');
 assert.equal(context.pendingImages.length,0);assert.equal(context.files.length,0);
 for(let i=0;i<9;i++)assert.ok(postponeAI(store,new AIServiceError('unavailable',true))-Date.now()<=300000);
 for(let i=0;i<9;i++)assert.ok(postponeAI(store,new AIServiceError('rate_limit',true))-Date.now()<=900000);
 assert.ok(postponeAI(store,httpFailure(429,{},'10800'))-Date.now()>10799000);
 const old=aiCooldown(store);postponeAI(store,new AIServiceError('unavailable',true));clearAICooldown(store,old);assert.ok(aiCooldown(store));
 const until=aiCooldown(store).until;
 store.enqueue('analyze:fixture','analyze',{});markAIWait(store,'analyze:fixture',until);
 store.prepare("UPDATE jobs SET state='retry',available_at=?,attempts=2 WHERE id=?").run(until,'analyze:fixture');
 store.enqueue('backup:fixture','backup',{});
 store.prepare("UPDATE jobs SET state='retry',available_at=? WHERE id=?").run(until,'backup:fixture');
 clearAICooldown(store);assert.equal(aiCooldown(store),null);
 assert.equal(store.prepare('SELECT available_at FROM jobs WHERE id=?').get('analyze:fixture').available_at,0);
 assert.equal(store.prepare('SELECT attempts FROM jobs WHERE id=?').get('analyze:fixture').attempts,2);
 assert.equal(store.prepare('SELECT available_at FROM jobs WHERE id=?').get('backup:fixture').available_at,until);
 assert.equal(store.prepare('SELECT COUNT(*) n FROM ai_requests').get().n,0);
 console.log(JSON.stringify({passed:true,campusSkipped:true,officialMaterialRetained:true,cooldownBounded:true,attemptsRetained:true,externalAICalls:0}));
}finally{store.db.close();}

const docArg=process.argv.find(v=>v.startsWith('--documents='));
if(docArg){
 const inputs=docArg.slice('--documents='.length),results=[];
 const cases=[
  ['784e277239d44648bc72f93bc0f9df39300e26ca9d12a6575749063192e9aa63','3.填报指南.doc','fa2ac80d6f7787e74b74c539d9e808d15d800c8aa66c50e56227ed52593772ac',2000],
  ['4c81dcfd2d8153acce95a4a7827242f4802eca3de9062de419edbc9629c0b052','1.上海市2027年度选调应届优秀大学毕业生高校名单.doc','7bfdb0ac0966375977f32b51a30ecfb701a290bc2f063caeac2d2a41c93f1074',1000],
  ['e485bca9427c04e6d470d1ea351b6d62aeea400b49acd356fd7befc95036009b','2.上海市2027年度选调应届优秀大学毕业生政策问答.doc','c9040e9379922e5e758734795087427ef49e6a6f64a8d548ba6dc2ad485555c1',3000]
 ];
 for(const [id,name,hash,minChars] of cases){
  const path=join(inputs,id),digest=()=>createHash('sha256').update(readFileSync(path)).digest('hex');
  assert.equal(digest(),hash);const value=await fileTool({python:process.env.JINDU_PYTHON},['parse',path,name]);
  assert.equal(value.error,'');assert.ok(value.text.length>=minChars);assert.equal(digest(),hash);
  results.push({id,chars:value.text.length,originalUnchanged:true});
 }
 console.log(JSON.stringify({passed:true,publicOriginals:3,documents:results,externalAICalls:0}));
}
