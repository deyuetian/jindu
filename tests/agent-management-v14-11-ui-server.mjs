import {mkdirSync,mkdtempSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {createApp} from '../backend/app.ts';
import {schemas,todayCN} from '../backend/model.ts';
import {runTurn} from '../backend/agent.ts';
const out=resolve('.check/agent-v14-11');mkdirSync(out,{recursive:true});
const dataDir=mkdtempSync(join(out,'ui-data-')),password=randomBytes(24).toString('base64url'),salt=randomBytes(16).toString('hex');
const digest=createHash('sha256').update('jindu-login-v1\0'+salt+'\0'+password).digest('hex');
const config={dataDir,origin:'http://127.0.0.1:8941',host:'127.0.0.1',port:8941,adminUsername:'agent-fixture',passwordHash:`random-v1$192$${salt}$${digest}`,masterKey:randomBytes(32).toString('hex'),distDir:resolve('dist'),python:process.env.JINDU_TEST_PYTHON||'python'};
const app=createApp(config),store=app.store,stopFile=join(dataDir,'stop');
store.setSetting('sources',{version:0,startDate:todayCN(),endDate:'',dailyTime:'09:00',autoEnabled:false,sites:[]});
store.save('profile',{title:'测试求职条件',includeUnrestricted:true,education:[{level:'硕士',major:'土壤学',code:'090301'}]});
for(const [key,title,n] of [['hunan','湖南省2027年定向选调公告',2],['beijing','北京市2027年定向选调公告',1]]){
  const ann=store.put('ann:'+key,'announcement',{title,body:'不限专业',province:key==='hunan'?'湖南省':'北京市',type:'选调',url:'https://example.invalid/'+key,status:'accepted',published:todayCN(),analysisStatus:'done',source:'本地合成资料',sourceId:'fixture'});
  const stages=['报名开始','报名截止','准考证打印开始','准考证打印截止','笔试','成绩查询','调剂报名开始','调剂报名截止'].map((label,i)=>({id:'s'+i,label,date:todayCN(),time:'09:00'}));
  store.put('exam:'+ann.id,'exam',schemas.exam.parse({title,type:'选调',url:ann.url,announcementId:ann.id,stages,tracking:{enabled:true,query:title}}));
  for(let i=0;i<n;i++)store.put(key+':'+i,'job',{...schemas.job.parse({title:'测试岗位'+i,province:ann.province,type:'选调',url:ann.url,announcementId:ann.id,status:'关注',evidence:'不限专业',majorRequirements:[{unrestricted:true,evidence:'不限专业'}]}),analysisCurrent:true});
}
writeFileSync(join(out,'ui-fixture.json'),JSON.stringify({origin:config.origin,username:config.adminUsername,password,stopFile}),{mode:0o600});
let busy=false;
const timer=setInterval(async()=>{
  if(existsSync(stopFile)){clearInterval(timer);app.server.close(()=>{store.db.close();process.exit(0);});return;}
  if(busy)return;
  const job=store.prepare("SELECT id FROM jobs WHERE type='agent' AND state='pending' ORDER BY updated_at LIMIT 1").get();if(!job)return;
  busy=true;
  try{store.prepare("UPDATE jobs SET state='running' WHERE id=?").run(job.id);await runTurn(store,config,job.id);store.prepare("UPDATE jobs SET state='done' WHERE id=?").run(job.id);}
  catch(e){store.prepare("UPDATE jobs SET state='error',error=? WHERE id=?").run(e.message,job.id);}
  finally{busy=false;}
},100);
setTimeout(()=>{clearInterval(timer);app.server.close(()=>process.exit(0));},300000).unref();
app.server.listen(config.port,config.host,()=>console.log('Isolated agent fixture ready. No production configuration or AI provider.'));
