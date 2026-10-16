import {ArrowUpRight,CalendarPlus,Check,Plus,MapPin} from 'lucide-react';
import {applicationStatus,majorSummary,majorLabel,regionName} from '../shared/job-display';
import {employerOf} from '../shared/recruitment';
export default function JobCard({job,busy,onOpen,onProgress,onAnnouncement,onCalendar,onIntent}:{job:any;busy:boolean;onOpen:()=>void;onProgress:()=>void;onAnnouncement:()=>void;onCalendar:()=>void;onIntent:(status:string)=>void}){
  const status=applicationStatus(job),selected=status==='关注',advanced=!['未选择','关注'].includes(status);
  return <article className="panel opportunity-card">
    <div className="opportunity-top"><span className={'verdict '+(['matched','unrestricted'].includes(job.majorStatus)?'met':job.majorStatus==='excluded'?'unmet':'review')}>{majorLabel(job)}</span><span className="opportunity-kind">{employerOf(job)}{job.industry&&job.industry!=='待分类'?' / '+job.industry:''}</span></div>
    <button className="opportunity-title" onClick={onOpen}><h3>{job.displayTitle||job.title}</h3><ArrowUpRight size={18}/></button>
    <p className="opportunity-company">{job.displayOrganization||job.organization||'单位待核对'}</p>
    <p className="opportunity-region"><MapPin size={13}/>{regionName(job.displayRegion||job.province)||'地区待核对'}{job.displayPositionCode&&<span>岗位代码 {job.displayPositionCode}</span>}</p>
    <button className="opportunity-source" onClick={onAnnouncement} disabled={!job.announcementId}><span>来源</span>{job.sourceAnnouncementTitle||'手动记录'}</button>
    <div className="opportunity-requirement"><span>专业要求</span><p>{job.majorSummary||majorSummary(job)}</p></div>
    <div className="opportunity-qualification"><span className={'status-dot '+(job.match==='符合'?'met':job.match==='不符合'?'unmet':'review')}/>{job.match==='符合'?'已核查的资格条件满足':job.match==='不符合'?'有未满足的资格条件':'其他资格待核对'}<button onClick={onOpen}>查看条件</button></div>
    <div className="opportunity-actions"><button className={'intent-button '+(selected?'selected':'')} disabled={busy} aria-pressed={selected} onClick={advanced?onProgress:()=>onIntent(selected?'未选择':'关注')}>{selected?<Check size={15}/>:advanced?null:<Plus size={15}/>} {advanced?status:selected?'已关注':'收藏关注'}</button>{job.announcementId&&<button className="calendar-button" onClick={onCalendar} disabled={busy}><CalendarPlus size={15}/>加入日历</button>}</div>
  </article>;
}
