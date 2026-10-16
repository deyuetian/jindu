import {announcementCalendars} from '../shared/calendar-policy.ts';
import {announcementTitle,announcementIntroduction} from '../shared/announcement-presentation.ts';
import { z } from 'zod';
import type { Store } from './db.ts';
import { employerTypes,industries,recruitmentTypes,employerOf,sourceOf } from '../shared/recruitment.ts';
import { sourceSettings } from './sources.ts';
import { dateSchema } from '../shared/model.ts';
import { matchJob } from './matching.ts';
import {jobPresentation} from '../shared/recruitment-report.ts';
import {regionName,regionSearch,applicationStatus} from '../shared/job-display.ts';
import {recruitmentReader,jobCardView} from './recruitment-reader.ts';
import {listingLocations} from './listing-locations.ts';
import {coverageSummary} from './position-quality.ts';
import {matchesPlace} from '../shared/location-filter.ts';
import {announcementMetadata,announcementAnalysisCounts} from '../shared/announcement-metadata.ts';
const optionalDate=dateSchema.or(z.literal('')).default('');
export const listingQuery=z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().refine(n=>[10,20,50,100].includes(n)).default(20),q:z.string().max(200).default(''),status:z.enum(['全部','专业符合','关注','拟投递','待核对','手动记录','待确认','已加入日历','暂不关注']).default('全部'),province:z.string().max(80).default(''),city:z.string().max(80).default(''),employerType:z.enum(employerTypes).or(z.literal('')).default(''),industry:z.enum(industries).or(z.literal('')).default(''),type:z.enum(recruitmentTypes).or(z.literal('')).default(''),sourceId:z.string().max(100).default(''),from:optionalDate,to:optionalDate}).refine(q=>!q.from||!q.to||q.from<=q.to,{message:'截止日期不能早于起始日期'});
export function listRecords(store:Store,kind:'job'|'announcement',params:URLSearchParams) {
  const query=listingQuery.parse(Object.fromEntries(params));
  const locations=listingLocations(store);
  const reader=recruitmentReader(store);
  const announcement=(id:string)=>reader!.get(id);
  const ensureMatch=(item:any)=>reader?reader.match(item):item;
  const calendars=announcementCalendars(kind==='announcement'?store.list('exam'):[]);
  const calendarStatus=(id:string)=>calendars.has(id)?(calendars.get(id)!.archived?'archived':'added'):'';
  const grouped=new Map<string,any[]>();
  if(kind==='announcement')for(const j of reader.list('job').filter(j=>!j.archived&&j.analysisCurrent!==false))grouped.set(j.announcementId,[...(grouped.get(j.announcementId)||[]),reader.facts(j)]);
  const coverage=(a:any)=>coverageSummary(grouped.get(a.id)||[],a.tableScreening?.candidates||0);
  const records=kind==='job'?reader.list(kind).map(j=>reader.facts(j)):(store.db.prepare("SELECT id,version,updated_at,json_remove(data,'$.body','$.sourcePositions','$.candidates','$.fileIds','$.uncertainties','$.materialErrors') data FROM records WHERE kind='announcement'").all() as any[]).map(r=>({...JSON.parse(r.data),id:r.id,version:r.version,updatedAt:r.updated_at}));
  const visibleRecords=kind==='announcement'?records.map(announcementMetadata):records;
  const rows=visibleRecords.filter(item=>{
    if(item.archived||kind==='job'&&item.analysisCurrent===false)return false;
    if(!matchesPlace(locations[kind].get(item.id)||[],query.province,query.city))return false;
    if(kind==='announcement'&&query.status!=='全部'&&!(query.status==='待确认'?item.status==='pending'||item.needsReview:query.status==='已加入日历'?calendarStatus(item.id)==='added':item.status==='ignored'))return false;
    const ann=kind==='job'&&item.announcementId?announcement(item.announcementId):null;
    const date=item.published||ann?.published||'';
    if(query.from&&(!date||date<query.from)||query.to&&(!date||date>query.to))return false;
    if(query.employerType&&employerOf(item)!==query.employerType||query.industry&&(item.industry||'待分类')!==query.industry||query.type&&item.type!==query.type)return false;
    if(query.sourceId&&sourceOf(ann||item)!==query.sourceId)return false;
    // Current major-based filters still use current evidence. Independent filters
    // and paging need not calculate every position's full eligibility report.
    if(kind==='job'&&query.status!=='全部'){
      if(query.status==='关注'||query.status==='拟投递'){if(applicationStatus(item)!=='关注')return false;}
      else if(query.status==='手动记录'){if(item.announcementId)return false;}
      else{
        const status=item.announcementId?reader.major(item).status:item.majorStatus;
        if(!(query.status==='专业符合'?['matched','unrestricted'].includes(status):!!item.announcementId&&(!status||status==='unknown')))return false;
      }
    }
    if(query.q&&regionSearch(query.q)&&regionSearch(item.sourcePosition?.location||item.province).includes(regionSearch(query.q)))return true;
    const majorFields=kind==='job'?[(item.sourcePosition||{}).major,...(item.majorRequirements||[]).flatMap((r:any)=>[...(r.names||[]),...(r.codes||[]),r.unrestricted?'不限专业':''])]:[];
    if(!query.q||[item.title,item.displayTitle,item.organization,item.province,item.summary,item.reasons,item.source,ann?.title,...majorFields].some(v=>String(v||'').toLowerCase().includes(query.q.toLowerCase())))return true;
    return String(ensureMatch(item).majorReason||'').toLowerCase().includes(query.q.toLowerCase());
  }).sort((a,b)=>kind==='announcement'?(b.published||'').localeCompare(a.published||'')||b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id):b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
  const total=rows.length,pages=Math.max(1,Math.ceil(total/query.pageSize)),page=Math.min(query.page,pages);
  const items=rows.slice((page-1)*query.pageSize,page*query.pageSize).map(item=>kind==='job'?(params.get('view')==='cards'?jobCardView(reader!.job(item)):{...reader!.job(item)}):{id:item.id,version:item.version,title:item.title,displayTitle:announcementTitle(item),type:item.type,employerType:employerOf(item),industry:item.industry||'待分类',published:item.published,province:regionName(item.province),source:item.source,sourceId:sourceOf(item),status:item.status,calendarStatus:calendarStatus(item.id),needsReview:item.needsReview,analysisStatus:item.analysisStatus==='done'&&coverage(item).incomplete?'partial':item.analysisStatus,analysisCoverage:coverage(item),analysisError:item.analysisError,analysisPendingParts:item.analysisPendingParts||0,relevant:item.relevant,summary:announcementIntroduction(item).slice(0,300),updatedAt:item.updatedAt});
  return {items,total,pages,page,pageSize:query.pageSize,...(kind==='announcement'?{analysisCounts:announcementAnalysisCounts(records)}:{}),locations:locations.options[kind],sources:[...sourceSettings(store).sites.map(s=>({id:s.id,name:s.name})),{id:'manual',name:'手动录入'},{id:'other',name:'其他来源'}]};
}
