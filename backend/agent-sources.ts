import { requestPublic } from './net.ts';
import { saveFile } from './files.ts';
import { hash, type Config } from './config.ts';
import { AppError, now } from './model.ts';
import type { Store } from './db.ts';
import { isAttachmentLink } from './attachment-links.ts';
import { cauCalendarURL, readCauCalendarNotice } from './cau-calendar-source.ts';

export type SourceDoc={id:string;url:string;title:string;text:string;published:string};
const decode=(s:string)=>s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
export function officialURL(value:string) {
  try {const u=new URL(value),h=u.hostname.toLowerCase();return !u.username&&!u.password&&['https:','http:'].includes(u.protocol)&&(/\.(gov|edu)\.cn$/.test(h)||['cpta.com.cn','www.cpta.com.cn','neea.cn','www.neea.cn','neea.edu.cn'].includes(h));}catch{return false;}
}
export function localSources(store:Store,terms:string[],exam?:any):SourceDoc[] {
  const words=terms.filter(x=>x.length>=2);
  const linked=exam?.announcementId?store.get(exam.announcementId):null;
  const candidates=exam?(linked?.kind==='announcement'?[linked]:[]):store.list('announcement');
  return candidates.filter(a=>cauCalendarURL(a.url||'')).map(a=>({a,score:exam?100:words.reduce((n,t)=>n+(a.title.includes(t)?5:(a.summary||'').includes(t)?1:0),0)}))
    .filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,5)
    .map(({a})=>({id:a.id,url:cauCalendarURL(a.url),title:a.title,text:a.body||'',published:a.published||''}));
}
export async function fetchOfficial(store:Store,config:Config,url:string,attachmentLimit=2):Promise<SourceDoc[]> {
  if(!officialURL(url))throw new AppError(400,'请提供可识别的官方公告网址（政府、学校或人事考试网）');
  const r=await requestPublic(url,{timeout:20000,maxBytes:8000000});
  if(r.status!==200)throw new AppError(502,`官方网页暂时无法读取（HTTP ${r.status}）`);
  if(!officialURL(r.url))throw new AppError(502,'官方网址跳转到了其他来源，暂不作为日期依据');
  const annId='official:'+hash(url).slice(0,32),old=store.get(annId),mime=String(r.headers['content-type']||'text/html');
  const html=r.body.toString(),title=decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()||'官方考试公告').slice(0,300);
  const file=await saveFile(store,config,annId,url,'官方公告',r.body,mime.split(';')[0]);
  // Save the parent before its attachments so every saved original is portable in backups.
  const data={title,body:file.text,url,published:'',type:'其他',province:'',source:'指定考试官方检索',status:old?.status||'pending',candidates:[],contentHash:hash(file.text),analysisStatus:'done',summary:'供已选考试助手核对日期',materialsComplete:!file.error,materialErrors:file.error?[file.error]:[],fileIds:[file.id],relevant:true};
  if(!old||old.contentHash!==data.contentHash) {
    if(old)store.db.prepare('INSERT INTO history(record_id,content_hash,data,created_at) VALUES(?,?,?,?)').run(annId,old.contentHash,JSON.stringify(old),now());
    store.put(annId,'announcement',data,old?.version);
  }
  if(file.error||!file.text)throw new AppError(422,'官方原文已保存，但正文未能读出；请粘贴公告文字后重试');
  const docs:SourceDoc[]=[{id:annId,url,title,text:file.text,published:''}],ids=[file.id],errors:string[]=[];
  const links=(file.links||[]).filter((l:any)=>{try{return isAttachmentLink({url:new URL(l.url,url).href,name:l.label||''});}catch{return false;}});
  if(links.length>attachmentLimit)errors.push(`附件共 ${links.length} 个，本次读取 ${attachmentLimit} 个，剩余内容待核对`);
  for(const l of links.slice(0,attachmentLimit)) {
    try {
      const address=new URL(l.url,url).href;
      if(attachmentLimit===2&&!officialURL(address)){errors.push('部分引用附件不在可识别官方域名，待核对');continue;}
      const ext=new URL(address).pathname.match(/\.(pdf|docx?|xlsx?|xlsm|zip)$/i)?.[0]||'';
      const f=await saveFile(store,config,annId,address,(l.label||'公告附件')+ext);ids.push(f.id);
      if(f.error)errors.push(f.name+'：'+f.error);
      if(f.text)docs.push({id:f.id,url:address,title:title+' / '+f.name,text:f.text,published:''});
    }catch{errors.push((l.label||'公告附件')+'：下载或读取失败');}
  }
  const current=store.get(annId);store.put(annId,'announcement',{...current,fileIds:[...new Set(ids)],materialsComplete:!errors.length,materialErrors:errors},current.version);
  return docs;
}
export function selectSources(official:SourceDoc[],local:SourceDoc[],limit=100000) {
  const unique=(docs:SourceDoc[])=>docs.filter((d,i,a)=>a.findIndex(x=>x.id===d.id)===i);
  const fresh=unique(official),cached=unique(local).filter(d=>!fresh.some(f=>f.id===d.id));
  const size=(docs:SourceDoc[])=>docs.reduce((n,d)=>n+d.text.length,0);
  let freshBudget=Math.min(size(fresh),cached.length?Math.floor(limit*.7):limit);
  const localBudget=Math.min(size(cached),limit-freshBudget);freshBudget=Math.min(size(fresh),limit-localBudget);
  const distribute=(docs:SourceDoc[],budget:number)=>docs.map((d,i)=>{
    const allowance=Math.floor(budget/(docs.length-i));const text=d.text.slice(0,allowance);budget-=text.length;return {...d,text};
  });
  const selected=[...distribute(fresh,freshBudget),...distribute(cached,localBudget)];
  const truncated=selected.some(d=>[...fresh,...cached].find(s=>s.id===d.id)!.text.length>d.text.length);
  const fingerprint=hash(JSON.stringify([...fresh,...cached].map(d=>[d.id,d.title,hash(d.text)]).sort((a,b)=>a[0].localeCompare(b[0]))));
  return {docs:selected.filter(d=>d.text.length),fingerprint,truncated};
}
export async function gatherSources(store:Store,_config:Config,_query:string,terms:string[],explicit:string[],exam?:any) {
  const local=localSources(store,terms,exam),fresh:SourceDoc[]=[],warnings:string[]=[];
  if(explicit.some(url=>!cauCalendarURL(url)))throw new AppError(400,'日历跟进只支持农大公告正文，请提供农大的公告详情链接');
  const bound=local[0]?.url||cauCalendarURL(exam?.url||'')||(exam?.tracking?.sources||[]).map(cauCalendarURL).find(Boolean)||'';
  const candidates=exam?[...explicit,...(bound?[bound]:[])]:explicit.length?explicit:local.map(d=>d.url);
  const urls=[...new Set(candidates.map(cauCalendarURL).filter(Boolean))];
  if(urls.length>5)throw new AppError(400,'一次最多核对 5 篇农大公告，请缩小范围');
  for(const url of urls)try{fresh.push(await readCauCalendarNotice(url));}catch(e){warnings.push(e instanceof AppError?e.message:'农大公告正文暂时无法读取，已保留原日历');}
  if(fresh.reduce((n,d)=>n+d.text.length,0)>100000)throw new AppError(422,'农大公告正文过长，本次未完成核对，已保留原日历');
  // Only freshly fetched, complete bodies can count as a successful check.
  const docs=[...new Map(fresh.map(d=>[d.id,d])).values()];
  const fingerprint='cau-body-v1:'+hash(JSON.stringify(docs.map(d=>[d.id,d.url,d.title,d.published,hash(d.text)]).sort((a,b)=>a[0].localeCompare(b[0]))));
  return {docs,fingerprint,warnings};
}
