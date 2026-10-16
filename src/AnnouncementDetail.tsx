import {announcementTitle,announcementIntroduction,overviewFacts,reviewNotes} from '../shared/announcement-presentation';
import {announcementAnalysisNotice} from '../shared/announcement-metadata';
import {isLaterExamStage} from '../shared/calendar-policy';
import {isProcessItem} from '../shared/recruitment-report';
import {useEffect,useState,type ReactNode} from 'react';
import {ExternalLink,FileText,RefreshCw,ArrowRight,CalendarDays,ShieldCheck,BriefcaseBusiness,ListChecks,ChevronDown} from 'lucide-react';
import {api} from './api';
import {useReadResource} from './ReadResource';
import {useSyncedDraft} from './useSyncedDraft';
import EligibilityPanel,{EligibilityGroups} from './EligibilityPanel';
import {ApplicationItems,ApplicationWorkflow,SourcePosition} from './ApplicationPanel';
import {PagedItems} from './Pagination';
import './announcement-detail.css';
export function readableBody(text:string){return (text||'').replace(/\r\n?/g,'\n').split('\n').map(line=>line.trim()).join('\n').replace(/\n{3,}/g,'\n\n').trim();}
type Props={item:any;busy:boolean;initialTab?:string;statusText:(item:any)=>string;onAnalyze:()=>void;onStatus:(status:string)=>void;onAccept:(exam:any,version:number)=>void;onOpenExam:(exam:any)=>void;onSettings:()=>void;renderStages:(stages:any[],setStages:(v:any[])=>void)=>ReactNode};
export default function AnnouncementDetail({item,busy,initialTab='overview',statusText,onAnalyze,onStatus,onAccept,onOpenExam,onSettings,renderStages}:Props){
  const [tab,setTab]=useState(initialTab);
  const dates=useSyncedDraft<any[]>((item.candidates||[]).filter((s:any)=>!isLaterExamStage(s)).map((s:any)=>({...s,origin:'ai'})),item.version);
  const stages=dates.value,setStages=dates.edit,calendar=item.calendar;
  const calendarText=item.calendarStatus==='archived'?'日历已归档':item.calendarStatus==='added'?'已加入日历':'查看或添加安排';
  const fileRead=useReadResource<any[]>(tab==='source'?'/announcements/'+encodeURIComponent(item.id)+'/files':null);
  const files=fileRead.data||[],fileError=fileRead.error;
  const notes=reviewNotes(item.uncertainties),jobs=item.jobs||[],groups=item.commonEligibilityChecks?.groups||[],process=item.applicationProcess||[];
  const [follow,setFollow]=useState(true);
  const active=['pending','running','retry'].includes(item.analysisStatus),recovery=item.analysisRecovery;
  const analysisAction=active?'后台正在处理':recovery?.pending?'继续未完成部分':item.sourceNeedsRefresh?'更新公告并分析':'重新分析';
  const waiting=item.analysisStatus==='waiting_quota',hasDates=stages.some((s:any)=>!!s.date&&!isLaterExamStage(s)),title=announcementTitle(item);
  const introduction=announcementIntroduction(item),summary=introduction.startsWith(title+'；')?introduction.slice(title.length+1):introduction,facts=overviewFacts(item);
  const qualified=jobs.filter((j:any)=>['matched','unrestricted'].includes(j.majorStatus)).length;
  const specificProcess=jobs.filter((j:any)=>j.specificApplicationItems?.some(isProcessItem));
  const submit=()=>onAccept({title,calendarKind:'exam',type:item.type,province:item.province||'',url:item.url||'',notes:'',stages:stages.filter((s:any)=>!isLaterExamStage(s)),archived:false,announcementId:item.id,tracking:{enabled:follow,passed:false,query:title}},dates.revision);
  return <div className="announcement-detail">
    <header className="announcement-hero"><div className="detail-meta"><span className="pill">{item.type}</span><span>{item.published||'日期待核对'}</span><span className={'detail-status '+(waiting?'warning':'')}>{statusText(item)}</span></div><h3 className="detail-title">{title}</h3><div className="detail-source"><span>{item.source||'手动录入'}{item.province?' · '+item.province:''}</span>{item.url&&<a href={item.url} target="_blank" rel="noreferrer">查看原文 <ExternalLink size={14}/></a>}</div></header>
    {(waiting||item.analysisError||item.sourceNeedsRefresh)&&<div className="detail-notice" role="status"><span>{waiting?'已达到网站设置的今日调用上限，明日自动继续；已完成结果保留。':item.analysisError||'网页岗位明细尚未补齐。'}</span><button type="button" className="text-btn" disabled={busy||active&&!waiting} onClick={waiting?onSettings:onAnalyze}>{waiting?'调整额度':analysisAction}<ArrowRight size={14}/></button></div>}
    {!!recovery?.parts?.length&&<details className="detail-uncertainties"><summary>未完成部分 <span>{recovery.parts.length}</span></summary><ul>{recovery.parts.map((part:any)=><li key={part.part}>第 {part.part} 部分 · {part.name}：{part.message}{!part.retryable&&'；需先处理原始资料限制'}</li>)}</ul><p>成功结果和原始资料均保留。继续分析只处理未完成部分，不重复调用已完成部分。</p></details>}
    <div className="detail-tabs" role="tablist" aria-label="公告详情">{[['overview','概览'],['eligibility','岗位与资格'],['process','申请流程'],['dates','时间节点'],['source','原文与附件']].map(([id,label])=><button type="button" id={'detail-tab-'+id} role="tab" aria-controls={'detail-panel-'+id} aria-selected={tab===id} key={id} onClick={()=>setTab(id)}>{label}</button>)}</div>
    <section className="detail-tab-content" role="tabpanel" id={'detail-panel-'+tab} aria-labelledby={'detail-tab-'+tab}>
      {tab==='overview'&&<>
        {facts.length?<dl className="announcement-facts" aria-label="公告概览">{facts.map(f=><div key={f.key}><dt>{f.label}</dt><dd>{f.text}</dd></div>)}</dl>:<p className="detail-summary">{summary||announcementAnalysisNotice(item)||'公告已收集，内容正在整理。'}</p>}
        <div className="detail-overview-grid">
          <button type="button" onClick={()=>setTab('eligibility')}><BriefcaseBusiness size={21}/><strong>{jobs.length?qualified+' 个专业符合的岗位':groups.length?'查看报考资格':'岗位待补充'}</strong><span>{jobs.length?'共 '+jobs.length+' 个候选岗位':'查看你的条件'} <ArrowRight size={14}/></span></button>
          <button type="button" onClick={()=>setTab('process')}><ListChecks size={21}/><strong>申请流程</strong><span>{process.length?'投递方式与所需材料':'查看报名安排'} <ArrowRight size={14}/></span></button>
          <button type="button" onClick={()=>setTab('dates')}><CalendarDays size={21}/><strong>{stages.length?stages.length+' 个时间节点':'日期待确认'}</strong><span>{calendarText} <ArrowRight size={14}/></span></button>
        </div>
        {!!item.analysisCoverage?.incomplete&&<div className="analysis-quality-note" role="status">{item.analysisCoverage.total} 个候选岗位中，{item.analysisCoverage.incomplete} 个仍有要求待核查。已读取的要求可在“岗位与资格”中查看。{item.analysisCoverage.missing>0&&`其中 ${item.analysisCoverage.missing} 个岗位结果尚未生成。`}</div>}
        {!!notes.length&&<details className="detail-uncertainties"><summary>还需确认 <span>{notes.length}</span></summary><ul>{notes.map((s:string,i:number)=><li key={i}>{s}</li>)}</ul></details>}
        <button type="button" className="text-btn detail-reanalyze" disabled={busy||active} onClick={onAnalyze}><RefreshCw size={15}/>{analysisAction}</button>
      </>}
      {tab==='eligibility'&&<>
        <section className="detail-common"><div className="detail-section-heading"><div><span className="detail-eyebrow">共同要求</span><h4>{item.type==='选调'?'报考资格':'通用资格要求'}</h4></div><span>{item.commonEligibilityProfile||'我的条件'}</span></div>
          {groups.length?<EligibilityGroups groups={groups}/>:<p className="detail-muted">{item.reportReady?'暂无单列的通用资格，请查看各岗位要求。':'通用资格正在整理。'}</p>}
          {!!item.commonApplicationItems?.length&&<ApplicationItems items={item.commonApplicationItems}/>}
        </section>
        <div className="detail-section-heading"><div><span className="detail-eyebrow">逐岗查看</span><h4>岗位要求 <span className="detail-count">{jobs.length}</span></h4></div>{!!jobs.length&&<a className="text-btn" href={'/api/announcements/'+encodeURIComponent(item.id)+'/jobs.xlsx'}>下载筛选表</a>}</div>
        {jobs.length?<PagedItems items={jobs} resetKey={item.id}>{(job:any)=><details className="detail-job-accordion" key={job.id}>
          <summary><div><h4>{job.displayTitle||job.title}</h4><p>{job.displayOrganization||job.organization}{(job.displayRegion||job.province)?' · '+(job.displayRegion||job.province):''}</p></div><span className={'verdict '+(job.majorStatus==='excluded'?'unmet':['matched','unrestricted'].includes(job.majorStatus)?'met':'review')}>{job.majorStatus==='unrestricted'?'专业符合 · 不限专业':job.majorStatus==='matched'?'专业符合':job.majorStatus==='excluded'?'专业不符':'专业待核对'}</span><ChevronDown size={17}/></summary>
          <div className="detail-job-body"><SourcePosition job={job}/><EligibilityPanel job={{...job,eligibilityChecks:job.specificEligibilityChecks||job.eligibilityChecks}} title="岗位资格"/>{!!job.specificApplicationItems?.filter((i:any)=>!isProcessItem(i)).length&&<><h4>其他要求与优先条件</h4><ApplicationItems items={job.specificApplicationItems.filter((i:any)=>!isProcessItem(i))}/></>}</div>
        </details>}</PagedItems>:<div className="detail-empty"><ShieldCheck size={24}/><strong>{item.sourceNeedsRefresh?'岗位明细待更新':!item.reportReady?'岗位结果尚未生成':'暂无可单列的岗位'}</strong><span>{groups.length?'可先核对上方通用报考资格':!item.reportReady?'公告已收集，可先查看原文与附件；岗位结果将在分析完成后显示。':'岗位明细补齐后将在这里显示'}</span></div>}
      </>}
      {tab==='process'&&<>
        <div className="detail-section-heading"><div><span className="detail-eyebrow">申请准备</span><h4>投递方式与材料</h4></div></div>
        <ApplicationWorkflow items={process}/>
        {specificProcess.map((j:any)=><details className="detail-job-accordion" key={j.id}><summary><strong>{j.displayTitle||j.title} · 补充要求</strong><ChevronDown size={17}/></summary><div className="detail-job-body"><ApplicationWorkflow items={j.specificApplicationItems.filter(isProcessItem)}/></div></details>)}
      </>}
      {tab==='dates'&&<form id="announcement-dates" onSubmit={e=>{e.preventDefault();submit();}}>{calendar?<div className="detail-empty"><CalendarDays size={26}/><strong>{calendarText}</strong><span>{calendar.archived?'已从日历隐藏，原有日期保留；可查看并恢复。':'在“重要日历”中查看和修改日期'}</span><button type="button" className="btn secondary" onClick={()=>onOpenExam(calendar)}>{calendar.archived?'查看归档安排':'查看日历安排'}</button></div>:<>{dates.changed&&<p className="detail-notice" role="status">公告日期已更新，你未保存的编辑已保留。<button type="button" className="text-btn" onClick={dates.reset}>改用最新日期</button></p>}{renderStages(stages,setStages)}<label className="calendar-follow"><input type="checkbox" checked={follow} onChange={e=>setFollow(e.target.checked)} disabled={busy}/>跟进公告日期更新</label><p className="calendar-import-caption">面试及后续节点在你确认通过后添加。</p>{!stages.length&&<p className="detail-empty">暂无已确认日期，可手动添加安排。</p>}</>}</form>}
      {tab==='source'&&<><div className="detail-files"><h4>原文与附件 <span>{files.length}</span></h4>{fileError&&<p className="form-error" role="alert">{fileError}</p>}{files.map(f=><div className="detail-file" key={f.id}><FileText size={19}/><a href={'/api/files/'+f.id}>{f.name}<small>{Math.max(1,Math.ceil(f.size/1024))} KB</small></a>{f.error&&<span className="late">{f.error}</span>}</div>)}{!files.length&&!fileError&&<p className="detail-muted">{fileRead.loading?'正在读取附件…':'暂无附件'}</p>}</div><article className="detail-body"><h4>原始标题：{item.title}</h4><h4>公告正文</h4><div>{readableBody(item.body)}</div></article></>}
    </section>
    <div className="detail-footer"><button type="button" className="text-btn muted" disabled={busy} onClick={()=>onStatus(item.status==='ignored'?'pending':'ignored')}>{item.status==='ignored'?'移回待确认':'暂不关注'}</button>{calendar?<button type="button" className="btn primary" disabled={busy} onClick={()=>onOpenExam(calendar)}>{calendar.archived?'查看归档安排':'查看日历安排'}</button>:tab==='dates'?<button type="submit" form="announcement-dates" className="btn primary" disabled={busy||!hasDates}>加入日历</button>:<button type="button" className="btn secondary" onClick={()=>setTab('dates')}>查看时间节点 <ArrowRight size={15}/></button>}</div>
  </div>;
}
