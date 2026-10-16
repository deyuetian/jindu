// Isolated synthetic UI fixture, loopback only; shuts down after this review.
import {mkdirSync,mkdtempSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {createApp} from '../backend/app.ts';
import {schemas,todayCN} from '../backend/model.ts';
import {postponeAI,AIServiceError} from '../backend/ai-failure.ts';
const out=resolve('.check/recovery-v14-12');mkdirSync(out,{recursive:true});
const dataDir=mkdtempSync(join(out,'ui-data-')),password=randomBytes(24).toString('base64url'),salt=randomBytes(16).toString('hex');
const digest=createHash('sha256').update('jindu-login-v1\0'+salt+'\0'+password).digest('hex');
const config={dataDir,origin:'http://127.0.0.1:8942',host:'127.0.0.1',port:8942,adminUsername:'recovery-fixture',passwordHash:`random-v1$192$${salt}$${digest}`,masterKey:randomBytes(32).toString('hex'),distDir:resolve('dist'),python:process.env.JINDU_TEST_PYTHON||'python'};
const app=createApp(config),store=app.store,stopFile=join(dataDir,'stop');
store.setSetting('sources',{version:0,startDate:todayCN(),endDate:'',dailyTime:'09:00',autoEnabled:false,sites:[]});
for(const [i,place] of ['甘肃省','北京市','四川省','湖北省','湖南省'].entries()){
  const id='exam:'+i,title=place+'2027年选调公告';
  store.put(id,'exam',schemas.exam.parse({title,type:'选调',url:'https://example.invalid',archived:i===4,stages:[],tracking:{enabled:i!==4,query:title}}));
  store.put('notice:'+i,'agent_turn',schemas.agent_turn.parse({createdAt:i===4?'2026-10-12T01:00:00Z':`2026-09-24T0${i}:00:00Z`,notice:true,done:true,examId:id,reply:title+'：准考证打印开始时间已更新。',before:'preserved-original'}));
}
for(let i=0;i<90;i++)store.put('chat:'+i,'agent_turn',schemas.agent_turn.parse({createdAt:new Date(Date.parse('2026-10-01')+i*60000).toISOString(),text:'历史查询 '+i,reply:'已保存的历史答复，测试未读通知没有被最近八十条对话隐藏。',done:true}));
store.put('chat:last','agent_turn',schemas.agent_turn.parse({createdAt:'2026-10-12T02:00:00Z',text:'最近一条查询',reply:'页面打开时保留最近一条对话的位置。',done:true}));
store.put('ann:failed','announcement',{title:'测试限流公告',body:'测试正文',url:'https://example.invalid/notice',analysisStatus:'retry',analysisError:'AI 接口暂时限制请求（HTTP 429）',published:todayCN(),contentHash:'fixture',fileIds:[]});
store.enqueueAnalysis('ann:failed');store.prepare("UPDATE jobs SET state='retry',attempts=1,error='AI 接口暂时限制请求（HTTP 429）',available_at=? WHERE id='analyze:ann:failed'").run(Date.now()+300000);
postponeAI(store,new AIServiceError('rate_limit',true,429,300000));
store.setSetting('analysis:ann:failed',{sourceHash:'fixture',index:1,segments:[{text:'第一段'},{text:'第二段'}]});
writeFileSync(join(out,'ui-fixture.json'),JSON.stringify({origin:config.origin,username:config.adminUsername,password,stopFile,dataDir}),{mode:0o600});
const close=()=>app.server.close(()=>{store.db.close();process.exit(0);});
const timer=setInterval(()=>{if(existsSync(stopFile)){clearInterval(timer);close();}},300);
setTimeout(()=>{clearInterval(timer);close();},600000).unref();
app.server.listen(config.port,config.host,()=>console.log('Synthetic recovery UI ready. No AI connection; loopback only.'));
