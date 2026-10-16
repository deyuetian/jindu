import {useState} from 'react';
import {useSyncedDraft} from './useSyncedDraft';
import {CalendarPlus,ArrowUpRight,Check,Plus} from 'lucide-react';
import {applicationStatus,jobStatuses,majorRequirementText,regionName,majorLabel} from '../shared/job-display';
import EligibilityPanel from './EligibilityPanel';
import ApplicationPanel,{SourcePosition} from './ApplicationPanel';
export default function JobDetail({job,busy,initialTab='eligibility',onProgress,onCalendar,onAnnouncement,onEdit}:{job:any;busy:boolean;initialTab?:string;onProgress:(status:string,notes?:string,version?:number)=>void;onCalendar:()=>void;onAnnouncement:()=>void;onEdit:()=>void}){
  const [tab,setTab]=useState(initialTab),draft=useSyncedDraft(job.notes||'',job.version),notes=draft.value,setNotes=draft.edit;
  const status=applicationStatus(job),advanced=!['未选择','关注'].includes(status);
  return <div className="job-detail-view">
    <header className="job-detail-header"><div className="job-detail-kicker"><span>{majorLabel(job)}</span><span>{job.type}</span></div><h3>{job.displayTitle||job.title}</h3><p>{job.displayOrganization||job.organization} · {regionName(job.displayRegion||job.province)||'地区待核对'}</p>{job.announcementId&&<button className="opportunity-source" onClick={onAnnouncement}><span>来源</span>{job.sourceAnnouncementTitle}<ArrowUpRight size={14}/></button>}<div className="job-detail-major"><span>专业要求</span><strong>{majorRequirementText(job)}</strong></div></header>
    <div className="job-detail-actions"><button className={'intent-button '+(status==='关注'?'selected':'')} aria-pressed={status==='关注'} disabled={busy} onClick={advanced?()=>setTab('progress'):()=>onProgress(status==='关注'?'未选择':'关注')}>{status==='关注'?<Check size={16}/>:advanced?null:<Plus size={16}/>} {advanced?status:status==='关注'?'已关注':'收藏关注'}</button>{job.announcementId&&<button className="calendar-button" disabled={busy} onClick={onCalendar}><CalendarPlus size={16}/>加入日历</button>}</div>
    <div className="detail-tabs" role="tablist" aria-label="岗位详情">{[['eligibility','资格条件'],['process','要求与流程'],['progress','我的投递']].map(([id,label])=><button key={id} id={'job-tab-'+id} role="tab" aria-selected={id===tab} aria-controls={'job-panel-'+id} onClick={()=>setTab(id)}>{label}</button>)}</div>
    <section role="tabpanel" id={'job-panel-'+tab} aria-labelledby={'job-tab-'+tab} className="job-detail-content">
      {tab==='eligibility'&&<><SourcePosition job={job}/><EligibilityPanel job={job}/></>}
      {tab==='process'&&<><ApplicationPanel job={job}/>{!job.applicationItems?.length&&!job.sourcePosition&&<p className="detail-muted">暂无单列的流程与材料要求，可查看所属公告。</p>}{job.announcementId&&<button className="text-btn" onClick={onAnnouncement}>查看完整公告 <ArrowUpRight size={15}/></button>}</>}
      {tab==='progress'&&<form className="job-progress-form" onSubmit={e=>{e.preventDefault();onProgress(status,notes,draft.revision);}}><label>申请进度<select aria-label="申请进度" value={status} disabled={busy} onChange={e=>onProgress(e.target.value)}>{jobStatuses.map(v=><option key={v}>{v}</option>)}</select></label>{draft.changed&&<p className="detail-notice" role="status">备注已有更新，你未保存的内容已保留。<button type="button" className="text-btn" onClick={draft.reset}>改用最新备注</button></p>}<label>我的备注<textarea value={notes} onChange={e=>setNotes(e.target.value)} maxLength={8000} rows={4} placeholder="准备事项、投递记录…"/></label><div><button className="btn primary" disabled={busy}>保存备注</button><button className="text-btn" type="button" onClick={onEdit}>编辑岗位记录</button></div></form>}
    </section>
  </div>;
}
