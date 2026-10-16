// Synthetic local review only. No worker, configured AI, or public listener.
import {mkdirSync,mkdtempSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {createApp} from '../backend/app.ts';
const out=resolve('.check/recovery-v14-12-r2');mkdirSync(out,{recursive:true});
const dataDir=mkdtempSync(join(out,'ui-data-')),password=randomBytes(24).toString('base64url'),salt=randomBytes(16).toString('hex');
const digest=createHash('sha256').update('jindu-login-v1\0'+salt+'\0'+password).digest('hex');
const config={dataDir,origin:'http://127.0.0.1:8943',host:'127.0.0.1',port:8943,adminUsername:'notice-fixture',passwordHash:`random-v1$192$${salt}$${digest}`,masterKey:randomBytes(32).toString('hex'),distDir:resolve('dist'),python:process.env.JINDU_TEST_PYTHON||'python'};
const app=createApp(config),store=app.store,stopFile=join(dataDir,'stop');
store.setSetting('sources',{version:0,startDate:'2026-09-01',endDate:'',dailyTime:'09:00',autoEnabled:false,sites:[]});
store.setSetting('source-status',{running:false,lastSuccess:'2026-10-13T01:04:00Z',added:2,updated:0});
for(const [id,title,status] of [
  ['anhui','安徽省2027年度面向中国农业大学定向招录选调生公告','error'],
  ['heilongjiang','黑龙江省2027年度定向选调应届优秀大学毕业生公告','retry'],
  ['zhejiang','2027年度浙江省党政机关选调应届优秀大学毕业生公告','pending'],
])store.put(id,'announcement',{title,type:'其他',province:'',analysisStatus:status,analysisError:status==='error'?'AI 接口暂时限制请求（HTTP 429）':'',status:'pending',published:'2026-10-09',body:'供页面检查使用的合成公告正文。',fileIds:[],candidates:[],uncertainties:[],source:'合成来源'});
writeFileSync(join(out,'ui-fixture.json'),JSON.stringify({origin:config.origin,username:config.adminUsername,password,stopFile,dataDir}),{mode:0o600});
const close=()=>app.server.close(()=>{store.db.close();process.exit(0);});
const timer=setInterval(()=>{if(existsSync(stopFile)){clearInterval(timer);close();}},300);
setTimeout(()=>{clearInterval(timer);close();},600000).unref();
app.server.listen(config.port,config.host,()=>console.log('Synthetic notice visibility UI ready on loopback. No AI calls.'));
