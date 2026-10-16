import { verdictLabels, type Verdict } from '../shared/eligibility';
import {ChevronDown} from 'lucide-react';
import {majorRequirementText} from '../shared/job-display';

export function VerdictBadge({ status }: { status: Verdict }) {
  return <span className={'verdict ' + status}>{verdictLabels[status]}</span>;
}

export function EligibilityGroups({groups}:{groups:any[]}){
  return <div className="qualification-groups compact-qualifications">{groups.map((g:any,i:number)=><details className="qualification-group" key={i}><summary><span className="qualification-group-title"><strong>{g.label}</strong><small>{g.items.length===1?g.items[0].label:g.items.length+' 项 · '+(g.mode==='any'?'满足任一项即可':'各项均需满足')}</small></span><VerdictBadge status={g.status}/><ChevronDown size={15}/></summary><div className="qualification-group-body">{g.items.map((c:any,n:number)=><div className="qualification-row" key={n}><div className="qualification-row-heading"><strong>{c.label}</strong><VerdictBadge status={c.status}/></div><div className="qualification-comparison"><span>我的条件</span><p>{c.actual||'待补充'}</p></div>{c.reason&&c.reason!==c.actual&&<p className="qualification-reason">{c.reason}</p>}<details className="qualification-evidence"><summary>查看要求原文</summary><blockquote>{c.evidence||'暂无'}</blockquote></details></div>)}</div></details>)}</div>;
}

export default function EligibilityPanel({ job, title='资格要求' }: { job: any;title?:string }) {
  const groups = job.eligibilityChecks?.groups || [];
  const major = job.majorStatus === 'excluded' ? 'unmet' : ['matched', 'unrestricted'].includes(job.majorStatus) ? 'met' : 'review';
  return <section className="eligibility-panel" aria-label="资格核查">
    <div className="eligibility-heading"><h3>{title}</h3><span>{job.eligibilityProfile || (job.profileState==='missing'?'尚未填写个人条件':job.profileState==='selection_required'?'请选择用于核查的个人条件':'我的个人条件')}</span></div>
    {job.sourcePosition?.education&&<p className="source-education"><span>学历要求</span>{job.sourcePosition.education}</p>}
    <div className="qualification-major"><div className="eligibility-line"><strong>专业要求</strong><span className={'verdict '+major}>{major==='met'?'专业符合':major==='unmet'?'专业不符':'待核对'}</span></div><p>{majorRequirementText(job)}</p><details className="qualification-evidence"><summary>匹配依据</summary>{job.majorReason&&<p>{job.majorReason}</p>}{!!job.majorPaths?.length&&<div className="application-education">{job.majorPaths.map((p:any,i:number)=><span key={i}>{p.level} · {p.major}<small>{p.status==='matched'||p.status==='unrestricted'?'专业符合':p.status==='excluded'?'专业不符':'待核对'}</small></span>)}</div>}{job.majorRequirements?.map((r:any,i:number)=><blockquote key={i}>{r.evidence}</blockquote>)}</details></div>
    <EligibilityGroups groups={groups}/>
    {!groups.length&&<div className="eligibility-empty">{job.analysisQuality?.status==='partial'||job.eligibilityCoverage!=='complete'?'其他资格要求尚未核查完整，可展开原表信息查看。':'暂无其他单列资格要求'}</div>}
    {!!job.analysisQuality?.issues?.length&&<div className="analysis-quality-note" role="status"><strong>尚待核查</strong><ul>{job.analysisQuality.issues.map((s:string)=><li key={s}>{s}</li>)}</ul></div>}
    {(!job.analysisQuality?.issues?.length&&(job.eligibilityCoverage!=='complete'||job.analysisIncomplete!==false))&&<p className="eligibility-footnote">部分条款待核对</p>}
  </section>;
}
