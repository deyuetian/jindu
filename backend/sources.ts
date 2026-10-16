import { z } from 'zod';
import { dateSchema } from '../shared/model.ts';
import { AppError,now } from './model.ts';
import { publicIP } from './net.ts';
import { isIP } from 'node:net';
import type { Store } from './db.ts';

export const DEFAULT_SOURCE={id:'cau',name:'中国农业大学学生就业服务网',url:'https://scc.cau.edu.cn/frontpage/cau/html/index.html',enabled:true};
export const sourceUrl=z.string().trim().max(2000).transform((s,ctx)=>{
  try{
    const u=new URL(s),host=u.hostname.replace(/^\[|\]$/g,'');
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.hash||host==='localhost'||/\.(?:local|localhost|internal)$/.test(host)||isIP(host)&&!publicIP(host)||!host.includes('.'))throw new Error();
    return u.href;
  }catch{ctx.addIssue({code:'custom',message:'请填写公开的 HTTP/HTTPS 公告列表网址'});return z.NEVER;}
});
export const sourcesSchema=z.object({
  version:z.number().int().min(0),
  startDate:dateSchema.default('2026-09-01'),endDate:dateSchema.or(z.literal('')).default(''),
  dailyTime:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default('09:00'),autoEnabled:z.boolean().default(true),
  sites:z.array(z.object({id:z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),name:z.string().trim().min(1).max(100),url:sourceUrl,enabled:z.boolean()})).max(20)
}).superRefine((v,ctx)=>{
  if(v.endDate&&v.endDate<v.startDate)ctx.addIssue({code:'custom',message:'截止日期不能早于起始日期',path:['endDate']});
  if(new Set(v.sites.map(s=>s.id)).size!==v.sites.length||new Set(v.sites.map(s=>s.url)).size!==v.sites.length)ctx.addIssue({code:'custom',message:'来源标识和网址不能重复',path:['sites']});
});
export type SourcesConfig=z.infer<typeof sourcesSchema>;
export type SchoolSource=SourcesConfig['sites'][number];
export function sourceSettings(store:Store):SourcesConfig {
  return store.getSetting<SourcesConfig>('sources',{version:0,startDate:'2026-09-01',endDate:'',dailyTime:'09:00',autoEnabled:true,sites:[{...DEFAULT_SOURCE}]});
}
export function saveSources(store:Store,input:unknown) {
  const value=sourcesSchema.parse(input);
  return store.transaction(()=>{
    const previous=sourceSettings(store);if(value.version!==previous.version)throw new AppError(409,'来源设置已在另一设备更新，请重新读取后保存');
    const saved={...value,version:value.version+1};store.setSetting('sources',saved);return saved;
  });
}
export function adapterFor(site:SchoolSource) {return new URL(site.url).hostname==='scc.cau.edu.cn'?'cau':'html';}
export function inDateRange(date:string,range:{startDate:string;endDate:string}) {return !date||date>=range.startDate&&(!range.endDate||date<=range.endDate);}
export function sourceIsEnabled(store:Store,id?:string) {return !id||sourceSettings(store).sites.some(s=>s.id===id&&s.enabled);}
export function sourceStatus(store:Store,id:string,changes:Record<string,unknown>) {const all=store.getSetting<Record<string,any>>('source-sites-status',{});all[id]={...all[id],...changes,updatedAt:now()};store.setSetting('source-sites-status',all);}
