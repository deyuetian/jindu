import { requestPublic } from './net.ts';
import { hash } from './config.ts';
import { AppError } from './model.ts';
import { dateSchema } from '../shared/model.ts';
import { inDateRange,sourceIsEnabled,sourceStatus } from './sources.ts';
import type { Store } from './db.ts';

const entities=(s:string)=>s.replace(/&(?:amp|quot|apos|lt|gt|nbsp|#\d+|#x[\da-f]+);/gi,m=>{
  const named:Record<string,string>={'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&nbsp;':' '};
  if(named[m.toLowerCase()])return named[m.toLowerCase()];
  try{return String.fromCodePoint(m.toLowerCase().startsWith('&#x')?parseInt(m.slice(3),16):parseInt(m.slice(2),10));}catch{return '';}
});
export const htmlText=(html:string)=>entities(html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
export function htmlDate(text:string) {
  for(const m of text.matchAll(/(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})(?:日)?/g)){
    const date=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    if(dateSchema.safeParse(date).success)return date;
  }
  return '';
}
const attr=(tag:string,key:string)=>entities(tag.match(new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,'i'))?.slice(1).find(x=>x!==undefined)||'');
export function schoolListing(html:string,address:string) {
  const clean=html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
  const items:{url:string;title:string;published:string;fingerprint:string}[]=[],pages:string[]=[];
  for(const m of clean.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)){
    const title=(attr(m[1],'title')||htmlText(m[2])).trim(),href=attr(m[1],'href');
    if(!href||!title||href.startsWith('#')||/^(?:javascript|mailto|tel):/i.test(href))continue;
    let url:URL;try{url=new URL(href,address);}catch{continue;}
    url.hash='';if(!['http:','https:'].includes(url.protocol)||url.username||url.password)continue;
    const sameOrigin=url.origin===new URL(address).origin;
    if(sameOrigin&&(/^(?:下一页|下页|next|\d{1,4}|招聘信息|招聘公告|校园招聘|就业信息|通知公告|公务员|选调生)$/i.test(title))&&!/\.(pdf|docx?|xlsx?|zip)(?:$)/i.test(url.pathname)){pages.push(url.href);continue;}
    if(title.length<8||!/(招聘|招录|选调|公务员|岗位|招考|人才|校招|引才|实习|宣讲|双选)/.test(title))continue;
    const pos=m.index||0,before=clean.slice(Math.max(0,pos-800),pos),after=clean.slice(pos+m[0].length,pos+m[0].length+450);
    const open=Math.max(before.lastIndexOf('<li'),before.lastIndexOf('<tr'),before.lastIndexOf('<dd'));
    const closed=Math.max(before.lastIndexOf('</li>'),before.lastIndexOf('</tr>'),before.lastIndexOf('</dd>'));
    const nearby=(open>closed?before.slice(open):'')+m[0]+after.split(/<\/(?:li|tr|dd)>|<a\b/i)[0];
    const published=htmlDate(htmlText(nearby));
    const fingerprint=hash(JSON.stringify([title,published,url.href]));
    if(!items.some(x=>x.url===url.href))items.push({url:url.href,title:title.slice(0,300),published,fingerprint});
  }
  return {items,pages:[...new Set(pages)].filter(p=>p!==address)};
}
async function readHTML(address:string) {
  const r=await requestPublic(address,{maxBytes:4000000,headers:{Accept:'text/html,application/xhtml+xml'}});
  if(r.status!==200)throw new AppError(502,`来源返回 HTTP ${r.status}`);
  const type=String(r.headers['content-type']||'');if(type&&!/html|text\//i.test(type))throw new AppError(422,'该地址不是公开公告页面，请填写学校的公告列表页');
  const charset=type.match(/charset\s*=\s*([^;\s]+)/i)?.[1]||r.body.subarray(0,1500).toString('ascii').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]||'utf-8';
  let html:string;try{html=new TextDecoder(charset).decode(r.body);}catch{html=r.body.toString('utf8');}
  return {html,url:r.url};
}
export async function crawlSchoolPage(store:Store,p:any) {
  if(!sourceIsEnabled(store,p.sourceId))return;
  const read=await readHTML(p.url),parsed=schoolListing(read.html,read.url),visited=[...(p.visited||[]),p.url],range=p.range;
  if(!parsed.items.length&&!parsed.pages.length&&visited.length===1)throw new AppError(422,'未读到公开公告列表，可能需要登录或专用适配；请更换为公告列表页');
  let added=0,skipped=0;
  for(const item of parsed.items){
    if(!inDateRange(item.published,range))continue;
    const id='web:'+hash(item.url),old=store.get(id);
    if(old?.materialsComplete&&old.sourceMeta?.listingHash===item.fingerprint){skipped++;continue;}
    store.enqueue(`detail:${p.run}:${hash(item.url)}`,'detail',{...p,adapter:'html',item,id});added++;
  }
  const status=store.getSetting<any>('source-status',{});store.setSetting('source-status',{...status,scanned:(status.scanned||0)+parsed.items.length,skipped:(status.skipped||0)+skipped});
  sourceStatus(store,p.sourceId,{running:true,pages:visited.length,queued:added,error:''});
  // Generic school sites may sort by pinned notices or ascending dates. Never
  // infer that an older page means all remaining pages are outside the range.
  const queue=[...new Set([...(p.pending||[]),...parsed.pages])].filter(x=>!visited.includes(x));
  if(queue.length){
    if(visited.length>=60)throw new AppError(422,'本轮已读取 60 个列表页，其余页面尚未读取；可缩小时间范围或拆分栏目网址');
    store.enqueue(`crawl:${p.run}:${p.sourceId}:${visited.length}`,'crawl',{...p,url:queue[0],pending:queue.slice(1,200),visited});
  }
}
export async function loadSchoolNotice(p:any) {
  const read=await readHTML(p.item.url),html=read.html;
  const pageDate=html.match(/<meta\b[^>]*(?:name|property)=["'](?:article:published_time|pubdate|publishdate|date)["'][^>]*content=["']([^"']+)["']/i)?.[1]||htmlText(html).match(/(?:发布时间|发布日期|发布时间|日期)\s*[:：]?\s*(20\d{2}[-年/.]\d{1,2}[-月/.]\d{1,2}日?)/)?.[1]||'';
  return {title:p.item.title,html,published:p.item.published||htmlDate(pageDate),origin:p.item.url,id:p.id,external:'',sourceName:p.sourceName,sourceId:p.sourceId,sourceMeta:{listingHash:p.item.fingerprint},range:p.range,generic:true};
}
