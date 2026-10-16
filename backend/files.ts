import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, extname } from 'node:path';
import { mkdirSync, writeFileSync, statfsSync } from 'node:fs';
import { requestPublic } from './net.ts';
import { hash, aiSettings, type Config } from './config.ts';
import { AppError } from './model.ts';
import type { Store } from './db.ts';

export function fileTool(config:Config,args:string[],timeout=60000,input?:string):Promise<any> {
  return new Promise((resolve,reject)=>{
    const child=spawn(config.python,[fileURLToPath(new URL('./file-tools.py',import.meta.url)),...args],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    child.stdin.on('error',()=>{});child.stdin.end(input||'');
    let stdout='';child.stdout.setEncoding('utf8');child.stdout.on('data',d=>{stdout+=d;if(stdout.length>6000000)child.kill();});
    const timer=setTimeout(()=>child.kill(),timeout);child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.stderr.resume();child.on('close',code=>{clearTimeout(timer);try{const value=JSON.parse(stdout);if(code!==0)reject(new AppError(422,value.error||'文件解析失败'));else resolve(value);}catch{reject(new AppError(422,'文件无法自动读取，请查看原件'));}});
  });
}
export async function saveFile(store:Store,config:Config,annId:string,url:string,name:string,raw?:Buffer,mime=''):Promise<any> {
  const response=raw?null:await requestPublic(url);
  if(response&&response.status!==200)throw new AppError(502,`附件返回 HTTP ${response.status}`);
  const body=raw||response!.body;const contentType=mime||String(response?.headers['content-type']||'application/octet-stream').split(';')[0];
  const digest=hash(body),id=hash(annId+'\0'+url+'\0'+digest);
  const old=store.db.prepare('SELECT * FROM files WHERE id=?').get(id) as any;
  if(old){
    if(!old.error&&!/html/i.test(old.mime))return old;
    const parsed=await fileTool(config,['parse',join(config.dataDir,'files',id),old.name]).catch(()=>null);
    if(!parsed)return {...old,links:[]};
    store.db.prepare('UPDATE files SET text=?,error=? WHERE id=?').run(parsed.text||'',parsed.error||'',id);
    if(parsed.tables)store.setSetting('workbook-v2:'+id,parsed);
    return {...old,text:parsed.text||'',error:parsed.error||'',links:parsed.links||[]};
  }
  const used=(store.db.prepare('SELECT COALESCE(SUM(size),0) size FROM files').get() as any).size;
  if(used+body.length>aiSettings(store).attachmentLimitMB*1048576)throw new AppError(507,'原文附件已达容量上限，新增文件待处理；可提高上限后重试');
  const disk=statfsSync(config.dataDir);if(Number(disk.bavail)*Number(disk.bsize)<body.length+250000000)throw new AppError(507,'磁盘剩余空间不足，已停止保存新附件');
  const dir=join(config.dataDir,'files');mkdirSync(dir,{recursive:true});
  const path=join(dir,id);writeFileSync(path,body,{mode:0o600});
  let filename=name.slice(0,200)||'附件';
  const ext:Record<string,string>={'application/msword':'.doc','application/pdf':'.pdf','text/html':'.html','image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','application/vnd.ms-excel':'.xls','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'.xlsx','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'.docx'};
  if(ext[contentType]&&extname(filename).toLowerCase()!==ext[contentType])filename+=ext[contentType];
  else if(!extname(filename))filename+='.txt';
  let parsed:any;try{parsed=await fileTool(config,['parse',path,filename]);}catch(e){parsed={text:'',links:[],error:e instanceof AppError?e.message:'解析失败，原件已保存'};}
  store.db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,error=excluded.error').run(id,annId,filename,url,contentType,body.length,digest,parsed.text||'',parsed.error||'');
  if(parsed.tables)store.setSetting('workbook-v2:'+id,parsed);
  return {id,name:filename,url,mime:contentType,size:body.length,sha256:digest,text:parsed.text||'',error:parsed.error||'',links:parsed.links||[]};
}
