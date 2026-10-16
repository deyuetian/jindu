import {cauRecruitmentContent} from './cau-recruitment.ts';
import { randomUUID } from 'node:crypto';
import { requestPublic } from './net.ts';
import { saveFile } from './files.ts';
import { hash, type Config } from './config.ts';
import { AppError, now } from './model.ts';
import type { Store } from './db.ts';
import { adapterFor,inDateRange,sourceIsEnabled,sourceSettings,sourceStatus } from './sources.ts';
import { crawlSchoolPage,loadSchoolNotice } from './school-crawler.ts';
import { documentLinks,isAttachmentLink } from './attachment-links.ts';

const BASE='https://scc.cau.edu.cn';
export const START='2026-09-01';
const categories=['3fcc824cecbc42aea3dce3700e5a4839','6ebab28e72ba46da99a0f2c372b129d7','db5ae5483e3b4bd387178130b9ebbf94'];
const keywords=['','公务员','选调','事业单位','国企','央企','科研','高校'];
class SourceUnavailableError extends AppError {}
const dateOf=(x:any)=>String(x.createDate||x.releaseDate||x.startTime||'').slice(0,10);
// View counts and other volatile fields must not turn unchanged notices into new work.
export const listingHash=(item:any)=>hash(JSON.stringify(['title','updateDate','releaseDate','createDate','startTime','description','link','linkUrl','url','fileUrl','hasAttachment'].map(k=>[k,item[k]??null])));
export function needsDetail(old:any,item:any,recruit:boolean) {
  return !old||!old.materialsComplete||old.sourceMeta?.recruit!==recruit||old.sourceMeta?.listingHash!==listingHash(item);
}
// Refresh obsolete source extraction only when that announcement is requested.
// Do not turn an upgrade into a historical full crawl or a full AI replay.
export async function ensureCurrentNotice(store:Store,config:Config,id:string){
  const ann=store.get(id);
  if(!ann||!id.startsWith('cau:')||!ann.url?.includes('/recruitmentinfoForm.html')||(ann.sourceMeta?.parserVersion||0)>=2)return;
  const match=ann.url.match(/[?&]positionDetailId=([a-f0-9]{32})(?:&|$)/);
  if(!match||id!=='cau:'+match[1])return;
  await detail(store,config,{item:{id:match[1],title:ann.title,startTime:ann.published},recruit:true,sourceId:ann.sourceId,sourceName:ann.source,range:{startDate:ann.published||START,endDate:ann.published||''},skipAnalysis:true});
  if((store.get(id)?.sourceMeta?.parserVersion||0)<2)throw new AppError(502,'公告原页暂时无法读取，已保留原结果，请稍后重试');
}
async function source(path:string,body?:Record<string,string>) {
  const r=await requestPublic(BASE+path,{method:body?'POST':'GET',headers:{Accept:'application/json',...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})},body:body?new URLSearchParams(body).toString():undefined,maxBytes:8000000});
  if(r.status!==200)throw new AppError(502,`农大来源返回 HTTP ${r.status}`);
  let d:any;try{d=JSON.parse(r.body.toString());}catch{throw new AppError(502,'农大来源返回格式发生变化');}
  if(d.state!==1){
    if(d.state===0&&/招聘信息不存在或审核不通过|文章不存在|公告不存在/.test(String(d.msg||'')))throw new SourceUnavailableError(404,'来源已撤回或尚未通过审核');
    throw new AppError(502,'农大来源暂未返回有效内容');
  }
  return d.object;
}
export function startCrawl(store:Store) {
  const existing=store.db.prepare("SELECT id FROM jobs WHERE type IN ('crawl','detail') AND state IN ('pending','running','retry') LIMIT 1").get();
  if(existing)return {queued:true,message:'本轮正在进行，可关闭网页，后台会继续'};
  const settings=sourceSettings(store),sites=settings.sites.filter(s=>s.enabled);
  if(!sites.length)throw new AppError(400,'请先启用至少一个公告来源');
  const run=randomUUID();store.setSetting('source-status',{lastAttempt:now(),running:true,scanned:0,collected:0,added:0,updated:0,skipped:0,unavailable:[],error:'',run});
  for(const site of sites){
    const payload={run,sourceId:site.id,sourceName:site.name,adapter:adapterFor(site),url:site.url,range:{startDate:settings.startDate,endDate:settings.endDate},phase:'discovery',index:0,page:1,categories};
    sourceStatus(store,site.id,{running:true,lastAttempt:now(),error:'',unavailable:[],pages:0,queued:0});
    store.enqueue(`crawl:${run}:${site.id}`,'crawl',payload);
  }
  return {queued:true,message:'已交给服务器后台处理'};
}
export async function crawlPage(store:Store,p:any) {
  if(!sourceIsEnabled(store,p.sourceId))return;
  if(p.adapter==='html')return crawlSchoolPage(store,p);
  const range=p.range||sourceSettings(store);
  if(p.phase==='discovery') {
    const navigation=await source('/f/ajaxHome/ajax_cmsList');
    const ids=new Set(categories);
    const walk=(x:any,depth=0)=>{if(!x||typeof x!=='object'||depth>12)return;for(const [key,v] of Object.entries(x)){if(key==='url'&&typeof v==='string'&&v.includes('newsList')){const m=v.match(/[?&](?:id|categoryId)=([a-f0-9]{32})(?:&|$)/);if(m)ids.add(m[1]);}else if(typeof v==='object')walk(v,depth+1);}};
    walk(navigation);const next={...p,categories:[...ids].slice(0,40),phase:'lists'};store.enqueue(`crawl:${p.run}:${p.sourceId||'cau'}:lists:0:1`,'crawl',next);return;
  }
  const recruit=p.phase==='recruitment';
  const result=recruit?await source('/f/recruitmentinfo/ajax_frontRecruitinfo',{pageNo:String(p.page),pageSize:'50',title:keywords[p.index]}):await source('/f/newsCenter/ajax_list',{categoryId:p.categories[p.index],pageNo:String(p.page),pageSize:'50'});
  const container=recruit?result:result.newsPage;
  if(!container||!Array.isArray(container.list)||typeof container.count!=='number')throw new AppError(502,'公告列表结构变化，本轮已保留进度');
  const list=container.list;
  for(const item of list) {
    if(typeof item.id!=='string'||typeof item.title!=='string')continue;
    const date=dateOf(item);if(!inDateRange(date,range))continue;
    const old=store.get('cau:'+item.id);
    if(!needsDetail(old,item,recruit)) {
      const status=store.getSetting<any>('source-status',{});
      store.setSetting('source-status',{...status,skipped:(status.skipped||0)+1});
      continue;
    }
    store.enqueue(`detail:${p.run}:${item.id}`,'detail',{run:p.run,item,recruit,sourceId:p.sourceId,sourceName:p.sourceName,range});
  }
  const status=store.getSetting<any>('source-status',{});store.setSetting('source-status',{...status,scanned:(status.scanned||0)+list.length,lastAttempt:now()});
  // Lists are exposed newest-first by the source. Never skip undated entries.
  const oldPage=list.length>0&&list.every((x:any)=>dateOf(x)&&dateOf(x)<range.startDate);
  let next={...p,page:p.page+1};
  if(!list.length||oldPage||p.page*50>=container.count)next={...p,index:p.index+1,page:1};
  if(next.index>=(recruit?keywords.length:p.categories.length)) {
    if(recruit)return;
    next={...p,phase:'recruitment',index:0,page:1};
  }
  if(next.page>200)throw new AppError(422,'来源分页超过本轮上限，尚未完成，需人工核对');
  store.enqueue(`crawl:${p.run}:${p.sourceId||'cau'}:${next.phase}:${next.index}:${next.page}`,'crawl',next);
}
function recordUnavailable(store:Store,p:any,origin:string) {
  const item={id:'cau:'+p.item.id,title:p.item.title,url:origin,reason:'来源已撤回或尚未通过审核'};
  const update=(status:any)=>({...status,unavailable:[...(status.unavailable||[]).filter((x:any)=>x.id!==item.id),item].slice(-100)});
  store.setSetting('source-status',update(store.getSetting<any>('source-status',{})));
  if(p.sourceId){const status=store.getSetting<Record<string,any>>('source-sites-status',{})[p.sourceId]||{};sourceStatus(store,p.sourceId,update(status));}
}
export async function detail(store:Store,config:Config,p:any) {
  if(!sourceIsEnabled(store,p.sourceId))return;
  if(p.adapter==='html')return persistNotice(store,config,await loadSchoolNotice(p));
  const item=p.item;let title:string,html:string,published:string,external='';let positions:any[]=[],positionErrors:string[]=[];
  const origin=p.recruit?`${BASE}/frontpage/cau/html/recruitmentinfoForm.html?positionDetailId=${encodeURIComponent(item.id)}`:`${BASE}/frontpage/cau/html/newsDetail.html?id=${encodeURIComponent(item.id)}`;
  const unavailableKey='source-unavailable:cau:'+item.id,unavailable=store.getSetting<any>(unavailableKey,null);
  // The listing can retain a withdrawn notice. Retry it on a later day or when
  // its listing changes, but don't make every keyword/run repeat the same 404.
  if(unavailable?.listingHash===listingHash(item)&&unavailable.retryAfter>Date.now()){recordUnavailable(store,p,origin);return;}
  try {
    if(p.recruit){const r=(await source('/f/recruitmentinfo/ajax_show',{recruitmentId:item.id})).recruitmentinfo;if(!r?.title)throw new AppError(502,'公告正文结构变化');title=r.title;const content=cauRecruitmentContent(r);html=content.html;positions=content.positions;positionErrors=content.errors;published=dateOf(r)||dateOf(item);external=r.linkUrl||'';}
    else {const r=(await source('/f/newsCenter/ajax_view?id='+encodeURIComponent(item.id))).article;if(!r?.title)throw new AppError(502,'公告正文结构变化');title=r.title;html=r.articleData?.content||'';published=dateOf(r)||dateOf(item);}
  }catch(e){
    if(!(e instanceof SourceUnavailableError))throw e;
    store.setSetting(unavailableKey,{listingHash:listingHash(item),checkedAt:now(),retryAfter:Date.now()+86400000});
    recordUnavailable(store,p,origin);return;
  }
  if(unavailable)store.db.prepare('DELETE FROM settings WHERE key=?').run(unavailableKey);
  return persistNotice(store,config,{title,html,published,external,origin,id:'cau:'+item.id,sourceName:p.sourceName||'中国农业大学学生就业服务网',sourceId:p.sourceId||'cau',sourcePositions:positions,positionErrors,sourceMeta:{listingHash:listingHash(item),recruit:!!p.recruit,parserVersion:2},range:p.range||sourceSettings(store),skipAnalysis:p.skipAnalysis});
}
export async function persistNotice(store:Store,config:Config,notice:any) {
  const {title,html,published,external,origin,id,sourceMeta,sourceName,sourceId,range}=notice;
  if(!inDateRange(published,range))return;
  const contentHash=hash(title+'\n'+html+'\n'+external),old=store.get(id);
  if(old?.contentHash===contentHash&&old.materialsComplete){store.put(id,'announcement',{...old,sourceMeta},old.version);return;}
  const original=await saveFile(store,config,id,origin,'公告原文.html',Buffer.from(html),'text/html');
  const body=original.text||'正文为空，请核对外部原文或附件。';
  const links=documentLinks(html,origin);
  const errors:string[]=[...(original.error?[`公告正文：${original.error}`]:[]),...(notice.positionErrors||[])];const fileIds=[original.id],sourceFileIds=[original.id];
  const selected=links.filter(isAttachmentLink);
  // An explicitly supplied original is source text, not an invented attachment.
  if(external&&!selected.some(l=>l.url===external))selected.unshift({url:external,name:'官方原文',image:false});
  for(const l of selected.slice(0,20)) {
    try {
      const suffix=new URL(l.url).pathname.match(/\.[a-zA-Z0-9]{1,5}$/)?.[0]||'.html';
      const file=await saveFile(store,config,id,l.url,l.name+suffix);fileIds.push(file.id);
      if(l.url===external&&file.mime.includes('html'))sourceFileIds.push(file.id);
      if(file.error)errors.push(`${file.name}：${file.error}`);
      // Follow files linked from the directly cited original, not that site's navigation.
      if(file.mime.includes('html')) {
        const refs=(file.links||[]).filter((x:any)=>{try{return isAttachmentLink({url:new URL(x.url,l.url).href,name:x.label||''});}catch{return false;}});
        if(refs.length>10)errors.push('引用原文中的附件超过 10 个，剩余文件待核对');
        for(const ref of refs.slice(0,10)) {
          try{const address=new URL(ref.url,l.url).href;const extension=new URL(address).pathname.match(/\.[a-zA-Z0-9]{1,5}$/)?.[0]||'.txt';const child=await saveFile(store,config,id,address,(ref.label||'原文附件')+extension);fileIds.push(child.id);if(child.error)errors.push(child.name+'：'+child.error);}catch(e){errors.push('引用原文中的附件未完成读取');}
        }
      }
    }catch(e){errors.push(`${l.name}：${e instanceof AppError?e.message:'暂时无法读取'}`);}
  }
  if(selected.length>20)errors.push('引用文件超过单条 20 个的读取上限，需核对剩余原件');
  const data={title,body,sourcePositions:notice.sourcePositions||[],url:origin,published,province:old?.province||'',type:old?.type||'其他',employerType:old?.employerType||'待分类',industry:old?.industry||'待分类',candidates:old?.candidates||[],status:old?.status||'pending',source:sourceName,sourceId,sourceMeta,contentHash,needsReview:!!old,analysisStatus:'pending',summary:old?.summary||'',uncertainties:[...errors,...(!published?['发布日期缺失，需核对']:[])],materialErrors:errors,fileIds:[...new Set(fileIds)],sourceFileIds,attachmentCount:new Set(fileIds.filter(f=>!sourceFileIds.includes(f))).size,materialsComplete:errors.length===0,relevant:old?.relevant??null};
  store.transaction(()=>{
    if(old)store.db.prepare('INSERT INTO history(record_id,content_hash,data,created_at) VALUES(?,?,?,?)').run(id,old.contentHash,JSON.stringify(old),now());
    store.put(id,'announcement',data,old?.version);
    if(!notice.skipAnalysis)store.enqueueAnalysis(id);
    const s=store.getSetting<any>('source-status',{});store.setSetting('source-status',{...s,collected:(s.collected||0)+1,added:(s.added||0)+(old?0:1),updated:(s.updated||0)+(old?1:0)});
  });
}
