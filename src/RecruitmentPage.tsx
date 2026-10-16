import {useViewState} from './ViewState';
import {formatDateTime} from '../shared/datetime';
import DateInput from './DateInput';
import { useEffect,useState } from 'react';
import {useReadResource} from './ReadResource';
import { ArrowRight,RefreshCw,SlidersHorizontal } from 'lucide-react';
import { api } from './api';
import { Pagination } from './Pagination';
import { employerTypes,industries,recruitmentTypes,employerOf,pageSizes } from '../shared/recruitment';
import './recruitment.css';
import JobCard from './JobCard';
import {announcementAnalysisNotice,announcementAnalysisLabel} from '../shared/announcement-metadata';

type Item=Record<string,any>&{id:string;version:number;analysisStatus?:string;analysisError?:string};
type LocationOption={province:string;cities:string[]};
type PageData={items:Item[];page:number;pages:number;pageSize:number;total:number;sources:{id:string;name:string}[];locations:LocationOption[];analysisCounts?:{pending:number;error:number;partial:number}};
export default function RecruitmentPage({kind,revision,intendedCount=0,onAnnouncement,onJob,onCalendar,onIntent,actionBusy=false,onSync,onSettings,source,sources}:{kind:'jobs'|'announcements';revision:number;intendedCount?:number;onAnnouncement:(id:string)=>void;onJob:(item:Item,tab?:string)=>void;onCalendar:(item:Item)=>void;onIntent:(item:Item,status:string)=>void;actionBusy?:boolean;onSync:()=>void;onSettings:()=>void;source:any;sources:any}) {
  const [page,setPage]=useViewState(kind+':page',1),[storedPageSize,setPageSize]=useViewState(kind+':pageSize',20),[filters,setFilters]=useViewState(kind+':filters',{q:'',status:kind==='jobs'?'专业符合':'全部',province:'',city:'',employerType:'',industry:'',type:'',sourceId:'',from:'',to:''});
  const pageSize=(pageSizes as readonly number[]).includes(storedPageSize)?storedPageSize:20;
  const [knownLocations,setKnownLocations]=useState<LocationOption[]>([]);
  const [search,setSearch]=useState(filters.q);
  useEffect(()=>{if(filters.q===search)return;const timer=setTimeout(()=>setSearch(filters.q),200);return()=>clearTimeout(timer);},[filters.q,search]);
  const query=new URLSearchParams({...filters,q:search,page:String(page),pageSize:String(pageSize),view:'cards'}).toString();
  const rangeError=filters.from&&filters.to&&filters.from>filters.to?'发布截止日期不能早于起始日期':'';
  const resource=useReadResource<PageData>(rangeError?null:'/listings/'+kind+'?'+query,15000);
  const data=rangeError?undefined:resource.data,error=rangeError||resource.error,busy=resource.loading||filters.q!==search;
  useEffect(()=>{if(data?.locations)setKnownLocations(data.locations);},[data?.locations]);
  const locations=data?.locations||knownLocations,cities=locations.find(p=>p.province===filters.province)?.cities||[];
  function change(key:string,value:string){setFilters(current=>({...current,[key]:value,...(key==='province'?{city:''}:{})}));setPage(1);}
  const statusText=announcementAnalysisLabel;
  const select=(key:'employerType'|'industry'|'type',label:string,values:readonly string[])=><label>{label}<select aria-label={label} value={filters[key]} onChange={e=>change(key,e.target.value)}><option value="">全部</option>{values.map(v=><option key={v}>{v}</option>)}</select></label>;
  return <div className="recruitment-page">
    {kind==='announcements'&&<section className="panel collection-summary"><div><strong>{sources?.sites?.filter((s:any)=>s.enabled).length??1} 个来源已启用</strong><span>{source.running?'正在检查':source.lastSuccess?`最近采集完成 ${formatDateTime(source.lastSuccess)}`:'尚未完成检查'} · 新增 {source.added||0} / 更新 {source.updated||0}</span>{data?.analysisCounts&&<span className="collection-analysis-status">分析：{[`待处理 ${data.analysisCounts.pending} 条`,`失败 ${data.analysisCounts.error} 条`,`待核对 ${data.analysisCounts.partial} 条`].join(' · ')}</span>}{source.error&&<span className="late">{source.error}</span>}</div><div><button className="text-btn" onClick={onSettings}>管理来源</button><button className="btn secondary" disabled={source.running} onClick={onSync}><RefreshCw size={15}/>检查更新</button></div></section>}
    <section className="panel recruitment-filters"><div className="recruitment-toolbar"><div className="tabs">{(kind==='jobs'?['专业符合','关注','待核对','手动记录','全部']:['全部','待确认','已加入日历','暂不关注']).map(t=><button key={t} aria-label={t} className={filters.status===t?'selected':''} onClick={()=>change('status',t)}>{t}{kind==='jobs'&&t==='关注'&&<span className="intent-count" aria-hidden="true">{intendedCount}</span>}</button>)}</div><input aria-label={kind==='jobs'?'搜索岗位':'搜索公告'} placeholder={kind==='jobs'?'搜索岗位、单位、专业':'搜索公告、地区、单位'} value={filters.q} onChange={e=>change('q',e.target.value)}/></div>
      <div className="recruitment-classification"><label>省份<select aria-label="省份" value={filters.province} onChange={e=>change('province',e.target.value)}><option value="">全部省份</option>{locations.map(p=><option key={p.province}>{p.province}</option>)}</select></label><label>城市<select aria-label="城市" value={filters.city} disabled={!filters.province||!cities.length} onChange={e=>change('city',e.target.value)}><option value="">{filters.province?'全部城市':'先选省份'}</option>{cities.map(city=><option key={city}>{city}</option>)}</select></label>{select('employerType','单位性质',employerTypes)}{select('industry','行业',industries)}{select('type','招录类型',recruitmentTypes)}<details className="more-filters"><summary><SlidersHorizontal size={14}/>来源与时间</summary><div><label>公告来源<select aria-label="公告来源" value={filters.sourceId} onChange={e=>change('sourceId',e.target.value)}><option value="">全部</option>{(data?.sources||sources?.sites||[]).map((s:any)=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label><label>发布起始日期<DateInput aria-label="发布起始日期" type="date" value={filters.from} onChange={e=>change('from',e.target.value)}/></label><label>发布截止日期<DateInput aria-label="发布截止日期" type="date" min={filters.from} value={filters.to} onChange={e=>change('to',e.target.value)}/></label></div></details></div>
    </section>
    {error&&<div className="form-error" role="alert">{error} <button className="text-btn" onClick={resource.retry}>重试</button></div>}
    {!data&&!error&&<p className="list-placeholder" role="status">正在读取…</p>}
    {data&&<><div className={kind==='jobs'?'job-list recruitment-jobs':'panel recruitment-announcements'} aria-label={kind==='jobs'?'岗位列表':'公告列表'} aria-busy={busy}>{data.items.map(item=>kind==='jobs'?<JobCard key={item.id} job={item} busy={actionBusy} onOpen={()=>onJob(item)} onProgress={()=>onJob(item,'progress')} onAnnouncement={()=>onAnnouncement(item.announcementId)} onCalendar={()=>onCalendar(item)} onIntent={status=>onIntent(item,status)}/>:<button className="announcement-row" key={item.id} onClick={()=>onAnnouncement(item.id)}><div><div className="announcement-tags"><span className="pill">{item.type}</span><span>{item.published||'日期待核对'}</span><span className={'pill '+(item.analysisStatus==='done'?'green':'orange')}>{statusText(item)}</span>{item.calendarStatus&&<span className={'pill '+(item.calendarStatus==='added'?'green':'')}>{item.calendarStatus==='added'?'已加入日历':'日历已归档'}</span>}</div><h3>{item.displayTitle||item.title}</h3><div className="recruitment-tags"><span>{employerOf(item)}</span><span>{item.industry||'待分类'}</span><span>{item.source}</span></div><p>{announcementAnalysisNotice(item)||(item.needsReview?'原文有更新，请复核':item.summary||item.analysisError||'等待分析')}</p></div><ArrowRight size={16}/></button>)}</div>{!data.total&&<p className="list-placeholder">当前筛选没有记录</p>}<Pagination page={data.page} pages={data.pages} total={data.total} pageSize={pageSize} onPage={setPage} onSize={size=>{setPageSize(size);setPage(1);}} busy={busy}/></>}
  </div>;
}
