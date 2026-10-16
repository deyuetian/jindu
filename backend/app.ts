import {queueStatus} from './queue-status.ts';
import {runtimeHealth,updateMaintenance} from './runtime-health.ts';
import {announcementReport} from './announcement-report.ts';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, existsSync, statSync, createReadStream, mkdirSync, createWriteStream, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import {jobDetail,updateJobProgress,jobCalendar,addJobCalendar} from './job-actions.ts';
import { Store } from './db.ts';
import { matchJob } from './matching.ts';
import { loadConfig, hash, equal, aiSettings, saveAI, type Config } from './config.ts';
import { AppError, now, todayCN, schemas, type Kind } from './model.ts';
import { passwordMatches } from '../server/security.ts';
import { callAI } from './ai.ts';
import { listModels } from './models.ts';
import { usageSummary } from './usage.ts';
import { calendarFeed, noteSubscriptionFetch, subscriptionLink, subscriptionStatus, updateSubscription } from './calendar-feed.ts';
import { startCrawl } from './crawler.ts';
import { backupList, restoreBackup } from './backup.ts';
import { safeError } from './net.ts';
import { queueTurn, conversation, undoTurn, cancelTurn } from './agent.ts';
import {markNoticesSeen} from './agent-notices.ts';
import { sourceSettings,saveSources } from './sources.ts';
import { fileTool } from './files.ts';
import {announcementScreenView} from './recruitment-reader.ts';
import { listRecords } from './listings.ts';

const json=(res:http.ServerResponse,data:unknown,status=200)=>{
  const payload=Buffer.from(JSON.stringify(data)),compress=payload.length>8192&&/\bgzip\b/.test(res.req.headers['accept-encoding']||'');
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Accept-Encoding',...(compress?{'Content-Encoding':'gzip'}:{})});
  res.end(compress?gzipSync(payload,{level:1}):payload);
};
async function body(req:http.IncomingMessage) {if(!req.headers['content-type']?.startsWith('application/json'))throw new AppError(415,'请使用 JSON 请求');let size=0;const chunks:Buffer[]=[];for await(const d of req){size+=d.length;if(size>2000000)throw new AppError(413,'请求内容过大');chunks.push(d);}try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw new AppError(400,'请求格式不正确');}}
function throttle(store:Store,bucket:string,max:number,ms:number) {const time=Date.now();const r=store.db.prepare('INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET hits=CASE WHEN expires_at<? THEN 1 ELSE hits+1 END,expires_at=CASE WHEN expires_at<? THEN excluded.expires_at ELSE expires_at END RETURNING hits').get(bucket,time+ms,time,time) as any;if(r.hits>max)throw new AppError(429,'操作过于频繁，请稍后重试');}

export function createApp(config:Config) {
  const store=new Store(config.dataDir),cookieName=config.origin.startsWith('https:')?'__Host-jindu':'jindu-local';
  store.setSetting('maintenance',false);
  const setCookie=(res:http.ServerResponse,token:string,age=604800)=>res.setHeader('Set-Cookie',`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.origin.startsWith('https:')?'; Secure':''}`);
  let restoring=false,uploadBusy=false,uploadId='';
  const handler:http.RequestListener=async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const method=req.method||'GET';
    try {
      const url=new URL(req.url||'/',config.origin),path=url.pathname;
      if(req.headers.host!==new URL(config.origin).host)throw new AppError(403,'请通过指定网站地址访问');
      if(updateMaintenance(config.dataDir)&&path.startsWith('/api/')&&path!=='/api/health')throw new AppError(503,'正在更新程序，数据已保留，请稍后刷新。');
      if(!['GET','HEAD'].includes(method)&&(req.headers.origin!==config.origin||req.headers['sec-fetch-site']==='cross-site'))throw new AppError(403,'请求来源不正确，请刷新页面重试');
      if(!path.startsWith('/api/')) {
        if(!['GET','HEAD'].includes(method))throw new AppError(405,'不支持此操作');
        const decoded=decodeURIComponent(path);const root=resolve(config.distDir);let file=resolve(root,'.'+decoded);
        if(!file.startsWith(root+sep)&&file!==root)throw new AppError(404,'页面不存在');
        if(!existsSync(file)||!statSync(file).isFile())file=join(root,'index.html');
        const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.png':'image/png'};
        res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':extname(file)==='.html'?'no-cache':'public,max-age=3600'});if(method==='HEAD')res.end();else createReadStream(file).pipe(res);return;
      }
      if(path.startsWith('/api/calendar/feed/')) {
        res.setHeader('Cache-Control','private, no-cache, max-age=0, must-revalidate');
        res.setHeader('CDN-Cache-Control','no-store');res.setHeader('Cloudflare-CDN-Cache-Control','no-store');
        res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
        if(!['GET','HEAD'].includes(method))throw new AppError(405,'日历订阅只能读取');
        const credential=path.match(/^\/api\/calendar\/feed\/([a-f0-9]{64})\.ics$/)?.[1]||'';
        // Authenticate the private link before honoring conditional requests.
        const feed=calendarFeed(store,config,credential);
        res.setHeader('Content-Type','text/calendar; charset=utf-8');res.setHeader('ETag',feed.etag);
        if(method==='GET')noteSubscriptionFetch(store);
        if(req.headers['if-none-match']?.split(',').some(t=>t.trim().replace(/^W\//,'')===feed.etag||t.trim()==='*')){res.writeHead(304);res.end();return;}
        res.setHeader('Content-Length',Buffer.byteLength(feed.body));res.writeHead(200);res.end(method==='HEAD'?undefined:feed.body);return;
      }
      const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';
      const authenticated=/^[a-f0-9]{64}$/.test(token)&&!!store.db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token),Date.now());
      if(method==='GET'&&path==='/api/session')return json(res,{authenticated,configured:!!config.passwordHash,preview:false});
      if(method==='GET'&&path==='/api/health'){store.prepare('SELECT 1').get();return json(res,{ok:true});}
      if(method==='POST'&&path==='/api/login') {
        throttle(store,'login:all',30,300000);const input=z.object({username:z.string().max(80),password:z.string().max(256)}).parse(await body(req));
        if(!equal(input.username,config.adminUsername)||!await passwordMatches(input.password,config.passwordHash))throw new AppError(401,'账号或密码不正确');
        const value=randomBytes(32).toString('hex');store.db.prepare('INSERT INTO sessions VALUES(?,?)').run(hash(value),Date.now()+604800000);setCookie(res,value);return json(res,{ok:true});
      }
      if(!authenticated)throw new AppError(401,'请先登录');
      if(method==='GET'&&path==='/api/health/details')return json(res,runtimeHealth(store));
      if(restoring&&method!=='GET')throw new AppError(409,'正在恢复数据，请稍后再试');
      if(method==='GET'&&path==='/api/calendar/subscription')return json(res,subscriptionStatus(store));
      if(method==='GET'&&path==='/api/calendar/subscription/link')return json(res,subscriptionLink(store,config));
      if(method==='PUT'&&path==='/api/calendar/subscription')return json(res,updateSubscription(store,config,await body(req)));
      if(method==='POST'&&path==='/api/logout'){store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));setCookie(res,'',0);return json(res,{ok:true});}
      if(method==='GET'&&path==='/api/state')return json(res,{...store.snapshot(url.searchParams.get('compact')==='1'),ai:aiSettings(store),sources:sourceSettings(store),sourceSitesStatus:store.getSetting('source-sites-status',{}),backups:backupList(config),backupStatus:store.getSetting('backup-status',{}),worker:store.getSetting('worker-status',{}),health:runtimeHealth(store),analysisProgress:store.getSetting('analysis-progress',{})});
      const jobExport=path.match(/^\/api\/announcements\/([^/]+)\/jobs\.xlsx$/);
      if(method==='GET'&&jobExport){
        throttle(store,'jobs-export',12,60000);
        const id=decodeURIComponent(jobExport[1]),ann=store.get(id);if(ann?.kind!=='announcement')throw new AppError(404,'公告不存在');
        const jobs=announcementReport(store,ann).jobs.map((j:any)=>({...j,title:j.displayTitle,organization:j.displayOrganization,province:j.displayRegion,status:j.applicationStatus,positionCode:j.displayPositionCode}));
        const data=await fileTool(config,['export-jobs'],60000,JSON.stringify({jobs}));
        res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent('岗位筛选结果.xlsx'),'Cache-Control':'no-store'});res.end(Buffer.from(data.base64,'base64'));return;
      }
      if(method==='GET'&&path==='/api/listings/jobs')return json(res,listRecords(store,'job',url.searchParams));
      if(method==='GET'&&path==='/api/listings/announcements')return json(res,listRecords(store,'announcement',url.searchParams));
      if(method==='GET'&&path==='/api/agent')return json(res,conversation(store));
      if(method==='POST'&&path==='/api/agent'){throttle(store,'agent',12,60000);return json(res,queueTurn(store,await body(req)),202);}
      if(method==='POST'&&path==='/api/agent/seen') {
        return json(res,markNoticesSeen(store,await body(req)));
      }
      const agentAction=path.match(/^\/api\/agent\/([^/]+)\/(undo|cancel|retry)$/);
      if(method==='POST'&&agentAction) {
        const id=decodeURIComponent(agentAction[1]),action=agentAction[2];
        if(action==='undo')return json(res,undoTurn(store,id));
        if(action==='cancel')return json(res,cancelTurn(store,id));
        const t=store.get(id);if(!t||t.kind!=='agent_turn'||t.done)throw new AppError(409,'这条消息已处理完成');
        if(store.db.prepare("SELECT 1 FROM jobs WHERE type='agent' AND id!=? AND state IN ('pending','running','retry','waiting_config','waiting_quota') LIMIT 1").get(id))throw new AppError(409,'请先等当前消息完成，再重试旧消息');
        store.enqueue(id,'agent',{id},true);return json(res,{ok:true});
      }
      if(method==='GET'&&path==='/api/settings')return json(res,aiSettings(store));
      if(method==='GET'&&path==='/api/sources')return json(res,{...sourceSettings(store),statuses:store.getSetting('source-sites-status',{})});
      if(method==='PUT'&&path==='/api/sources')return json(res,saveSources(store,await body(req)));
      if(method==='GET'&&path==='/api/usage')return json(res,usageSummary(store));
      if(method==='POST'&&path==='/api/settings/models') {throttle(store,'ai-models',20,60000);return json(res,await listModels(store,config,await body(req)));}
      if(method==='PUT'&&path==='/api/settings')return json(res,saveAI(store,await body(req),config));
      if(method==='POST'&&path==='/api/settings/test') {throttle(store,'ai-test',5,60000);await callAI(store,config,[{role:'user',content:'请只回复 OK，用于测试 API 连接。'}],100,25000,'test');return json(res,{ok:true,message:'服务器已成功连接并收到模型响应'});}
      if(method==='POST'&&path==='/api/sync'){throttle(store,'sync',10,60000);return json(res,startCrawl(store));}
      if(method==='POST'&&path==='/api/queue/retry') {
        store.transaction(()=>{
          const ids=store.db.prepare("SELECT DISTINCT json_extract(payload,'$.id') id FROM jobs WHERE type='analyze' AND state IN ('error','waiting_config','waiting_quota')").all() as any[];
          for(const {id} of ids)store.enqueueAnalysis(id,true);
          store.db.prepare("UPDATE jobs SET state='pending',attempts=0,error='',available_at=0 WHERE type!='analyze' AND state IN ('error','waiting_config','waiting_quota')").run();
        });return json(res,{ok:true});
      }
      if(method==='GET'&&path==='/api/queue')return json(res,queueStatus(store));
      if(method==='POST'&&path==='/api/import-announcement') {
        const v=z.object({title:z.string().trim().min(1).max(300),body:z.string().min(1).max(500000),url:z.string().max(2000).default(''),published:z.string().default(todayCN())}).parse(await body(req));
        if(v.url&&!/^https?:\/\//.test(v.url))throw new AppError(400,'链接需以 http:// 或 https:// 开头');
        const id='manual:'+randomUUID();store.put(id,'announcement',{...v,type:'其他',province:'',source:'手动录入',status:'pending',contentHash:hash(v.body),candidates:[],needsReview:false,analysisStatus:'pending',uncertainties:[],materialsComplete:true,relevant:null});store.enqueueAnalysis(id);return json(res,{id},201);
      }
      const record=path.match(/^\/api\/records\/(task|goal|study|profile|exam|job)(?:\/([^/]+))?$/);
      if(record&&['POST','PUT'].includes(method)) {
        const v=z.object({data:z.unknown(),version:z.number().int().positive().optional()}).parse(await body(req));
        if(method==='PUT'&&!record[2]||method==='POST'&&record[2])throw new AppError(405,'操作不支持');
        return json(res,store.save(record[1] as Kind,v.data,record[2]?decodeURIComponent(record[2]):undefined,v.version),method==='POST'?201:200);
      }
      const jobAction=path.match(/^\/api\/jobs\/([^/]+)(?:\/(progress|calendar))?$/);
      if(jobAction){
        const id=decodeURIComponent(jobAction[1]),action=jobAction[2];
        if(method==='GET'&&!action)return json(res,jobDetail(store,id));
        if(method==='GET'&&action==='calendar')return json(res,jobCalendar(store,id));
        if(method==='POST'&&action==='progress')return json(res,updateJobProgress(store,id,await body(req)));
        if(method==='POST'&&action==='calendar')return json(res,addJobCalendar(store,id,await body(req)));
      }
      const annDetail=path.match(/^\/api\/announcements\/([^/]+)$/);
      if(method==='GET'&&annDetail){const ann=store.get(decodeURIComponent(annDetail[1]));if(!ann||ann.kind!=='announcement')throw new AppError(404,'公告不存在');const report=announcementReport(store,ann);return json(res,url.searchParams.get('view')==='screen'?announcementScreenView(report):report);}
      const annAction=path.match(/^\/api\/announcements\/([^/]+)\/(accept|status|analyze|files|history)$/);
      if(annAction) {
        const id=decodeURIComponent(annAction[1]),action=annAction[2],ann=store.get(id);if(!ann||ann.kind!=='announcement')throw new AppError(404,'公告不存在');
        if(method==='GET'&&action==='files')return json(res,store.db.prepare('SELECT id,name,size,error,url FROM files WHERE announcement_id=?').all(id));
        if(method==='GET'&&action==='history')return json(res,store.db.prepare('SELECT id,created_at,data FROM history WHERE record_id=? ORDER BY id DESC LIMIT 10').all(id));
        if(method==='POST'&&action==='accept'){const v=await body(req);return json(res,store.accept(id,v.version,v.exam),201);}
        if(method==='POST'&&action==='status') {const v=z.object({version:z.number().int().positive(),status:z.enum(['pending','accepted','ignored']),needsReview:z.boolean().default(false)}).parse(await body(req));return json(res,store.put(id,'announcement',{...ann,status:v.status,needsReview:v.needsReview},v.version));}
        if(method==='POST'&&action==='analyze'){const active=store.prepare("SELECT 1 FROM jobs WHERE type='analyze' AND json_extract(payload,'$.id')=? AND state IN ('running','pending','retry')").get(id);if(active)return json(res,{queued:true,existing:true});store.enqueueAnalysis(id,true);return json(res,{queued:true});}
      }
      const file=path.match(/^\/api\/files\/([a-f0-9]{64})$/);
      if(method==='GET'&&file){const f=store.db.prepare('SELECT * FROM files WHERE id=?').get(file[1]) as any;if(!f)throw new AppError(404,'文件不存在');res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,'Cache-Control':'no-store'});createReadStream(join(config.dataDir,'files',f.id)).pipe(res);return;}
      if(method==='POST'&&path==='/api/backup') {store.enqueue('backup:manual:'+todayCN(),'backup',{},true);return json(res,{queued:true});}
      const download=path.match(/^\/api\/backups\/(jindu-\d{8}-\d{6}-[a-f0-9]{8}\.zip)$/);
      if(method==='GET'&&download){if(!backupList(config).some(b=>b.name===download[1]))throw new AppError(404,'备份不存在');res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="${download[1]}"`,'Cache-Control':'no-store'});createReadStream(join(config.dataDir,'backups',download[1])).pipe(res);return;}
      if(method==='POST'&&path==='/api/restore/upload') {
        if(uploadBusy)throw new AppError(409,'已有备份正在上传');
        const dir=join(config.dataDir,'restore');mkdirSync(dir,{recursive:true});
        uploadId=randomUUID();writeFileSync(join(dir,'upload.zip'),Buffer.alloc(0),{mode:0o600});return json(res,{uploadId});
      }
      if(method==='PUT'&&path==='/api/restore/upload') {
        if(!uploadId||url.searchParams.get('id')!==uploadId)throw new AppError(409,'请重新选择备份文件上传');
        if(uploadBusy)throw new AppError(409,'已有备份正在上传');
        const upload=join(config.dataDir,'restore','upload.zip'),offset=statSync(upload).size;
        if(Number(url.searchParams.get('offset'))!==offset)throw new AppError(409,'上传进度不一致，请重试');
        uploadBusy=true;
        try {
          let size=0;const limiter=new Transform({transform(chunk,_enc,cb){size+=chunk.length;cb(size>8000000||offset+size>2000000000?new AppError(413,'备份包超过 2GB 或分块过大'):null,chunk);}});
          await pipeline(req,limiter,createWriteStream(upload,{flags:'a',mode:0o600}));return json(res,{offset:offset+size});
        }catch(e){uploadId='';throw e;}finally{uploadBusy=false;}
      }
      if(method==='POST'&&path==='/api/restore') {
        if(req.headers['x-confirm-restore']!=='replace-business-data')throw new AppError(400,'请先确认恢复会替换现有业务记录');
        const input=await body(req);
        if(!uploadId||input.uploadId!==uploadId||uploadBusy)throw new AppError(409,'请先完整上传备份');
        restoring=true;store.setSetting('maintenance',true);
        try {
          const upload=join(config.dataDir,'restore','upload.zip');uploadId='';
          const result=await restoreBackup(store,config,upload);unlinkSync(upload);setCookie(res,'',0);return json(res,result);
        }finally{restoring=false;store.setSetting('maintenance',false);}
      }
      throw new AppError(404,'没有找到这个操作');
    } catch(e) {
      if(res.headersSent){res.destroy();return;}
      if(e instanceof z.ZodError)return json(res,{error:e.issues[0]?.message||'输入格式不正确'},400);
      if(e instanceof AppError)return json(res,{error:e.message},e.status);
      console.error(JSON.stringify({event:'request_error',type:e instanceof Error?e.name:'Unknown'}));json(res,{error:safeError(e)},500);
    }
  };
  const server=config.tlsCert&&config.tlsKey?https.createServer({cert:readFileSync(config.tlsCert),key:readFileSync(config.tlsKey),minVersion:'TLSv1.2'},handler):http.createServer(handler);
  server.requestTimeout=300000;server.headersTimeout=20000;
  return {server,store};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const config=loadConfig();const {server,store}=createApp(config);server.listen(config.port,config.host,()=>console.log('Jindu web service ready'));
  let stopping=false;
  const stop=()=>{if(stopping)return;stopping=true;server.close(()=>{store.db.close();process.exit(0);});server.closeIdleConnections();};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
