import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {createApp} from '../backend/app.ts';
import {schemas} from '../backend/model.ts';
const out=resolve('.check/memory-v14-10');mkdirSync(out,{recursive:true});
const dataDir=mkdtempSync(join(out,'ui-data-')),password=randomBytes(24).toString('base64url'),salt=randomBytes(16).toString('hex');
const digest=createHash('sha256').update('jindu-login-v1\0'+salt+'\0'+password).digest('hex');
const config={dataDir,origin:'http://127.0.0.1:8940',host:'127.0.0.1',port:8940,adminUsername:'memory-fixture',passwordHash:`random-v1$192$${salt}$${digest}`,masterKey:randomBytes(32).toString('hex'),distDir:resolve('dist'),python:process.env.JINDU_TEST_PYTHON||'python'};
const app=createApp(config),store=app.store;
store.setSetting('sources',{version:0,startDate:'2026-09-01',endDate:'',dailyTime:'09:00',autoEnabled:false,sites:[]});
store.save('profile',{title:'我的求职条件',includeUnrestricted:true,education:[{level:'硕士',major:'土壤学',code:'090301',year:'2027',school:'示例大学'}]});
const regions=[['湖北省','武汉市'],['湖北省','黄石市'],['湖北省','荆州市'],['湖北省','宜昌市'],['全国',''],['北京市','北京市'],['天津市','天津市'],['浙江省','绍兴市']];
for(let i=0;i<regions.length;i++){
  const [province,city]=regions[i];
  for(let n=0;n<(i===0?26:1);n++){
    const id=`ann:${i}:${n}`,body='不限专业。仅限男性报考';
    const ann=store.put(id,'announcement',{title:`缓存公告 ${province} ${n}`,province,type:'企业招聘',url:'https://example.invalid/'+id,body,status:'pending',analysisStatus:'done',published:'2026-09-23',source:'本地合成资料',sourceId:'fixture'});
    store.put(`job:${i}:${n}`,'job',{...schemas.job.parse({title:`缓存岗位 ${city} ${n}`,province,type:'企业招聘',url:ann.url,announcementId:ann.id,evidence:body,analysisIncomplete:false,majorRequirements:[{unrestricted:true,evidence:'不限专业'}],eligibilityCoverage:'complete',eligibilityRequirements:[{label:'性别',mode:'all',evidence:'仅限男性报考',criteria:[{kind:'gender',label:'性别',evidence:'仅限男性报考',accepted:['男']}]}]}),sourcePosition:{location:city||province},analysisCurrent:true});
  }
}
for(let i=0;i<27;i++)store.save('task',{title:`缓存任务 ${i}`,category:'日常',due:'2026-09-24',time:'',notes:'',priority:'普通',done:false});
writeFileSync(join(out,'ui-fixture.json'),JSON.stringify({origin:config.origin,username:config.adminUsername,password}),{mode:0o600});
app.server.listen(config.port,config.host,()=>console.log('Local workspace fixture ready; synthetic data, no worker or AI settings.'));
