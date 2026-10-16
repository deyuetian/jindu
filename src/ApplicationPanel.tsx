import { applicationKindLabels } from '../shared/application';
import {regionName} from '../shared/job-display';
import {isProcessItem,uniqueBy,applicationKey} from '../shared/recruitment-report';
import {orderedApplicationItems} from '../shared/application-presentation';

export function ApplicationItems({items,ordered=false}:{items:any[];ordered?:boolean}){
  return <div className={'application-items'+(ordered?' process-timeline':'')}>{orderedApplicationItems(uniqueBy(items,applicationKey)).map((item:any,index:number)=><article key={index} className="application-item">{ordered&&<span className="process-number" aria-hidden="true">{String(index+1).padStart(2,'0')}</span>}<div className="eligibility-line"><strong>{item.label}</strong>{(!ordered||item.required===false)&&<span className={'pill '+(item.required?'':'green')}>{item.required===false?(isProcessItem(item)?item.kind==='material'?'可选材料':'可选方式':'优先条件'):applicationKindLabels[item.kind as keyof typeof applicationKindLabels]}</span>}</div>{item.detail&&<p>{item.detail}</p>}<div className="application-meta">{item.phase&&item.phase!=='未说明'&&<span>{item.phase}</span>}{item.deadline&&<span>截止 {item.deadline}</span>}{item.method&&<span>{item.method}</span>}</div><details><summary>查看要求原文</summary><blockquote>{item.evidence}</blockquote>{item.sourceFileId&&<a href={'/api/files/'+item.sourceFileId}>查看原件</a>}</details></article>)}</div>;
}

export function ApplicationWorkflow({items}:{items:any[]}){
  const visible=orderedApplicationItems(items),steps=visible.filter(i=>i.kind!=='material'),materials=visible.filter(i=>i.kind==='material');
  if(!visible.length)return <p className="detail-muted">申请安排尚待补充，请查看原文。</p>;
  return <div className={'detail-process-grid'+(!steps.length||!materials.length?' single-column':'')}>
    {!!steps.length&&<section aria-label="申请流程"><h4>申请流程 <span>{steps.length} 步</span></h4><ApplicationItems items={steps} ordered/></section>}
    {!!materials.length&&<section aria-label="所需材料"><h4>所需材料 <span>{materials.length} 项</span></h4><ApplicationItems items={materials}/></section>}
  </div>;
}
export function SourcePosition({job}:{job:any}){
  const facts=job.sourcePosition,ref=job.sourceRow,web=ref?.sheet==='网页岗位',code=job.displayPositionCode??job.positionCode;
  return <>{ref&&<p className="application-location">{web?'网页岗位 · 第 '+ref.row+' 项':`${ref.fileName} · ${ref.sheet} · 第 ${ref.row} 行`}{code&&` · 岗位代码 ${code}`}{!code&&job.sourceSerial&&` · 原表序号 ${job.sourceSerial}`} {ref.fileId&&<a href={'/api/files/'+encodeURIComponent(ref.fileId)}>{web?'查看保存原文':'下载原表'}</a>}</p>}{facts&&<details className="job-source-facts"><summary>{web?'原页岗位信息':'原表信息'}</summary><dl>{facts.fields?.length?facts.fields.map((f:any,i:number)=><div key={i}><dt>{f.header}</dt><dd>{f.value||'未填写'}</dd></div>):[['education','学历'],['major','专业'],['count','人数'],['location','地点']].map(([key,label])=>facts[key]&&<div key={key}><dt>{label}</dt><dd>{key==='location'?(job.displayRegion||regionName(facts[key])):facts[key]}</dd></div>)}</dl>{facts.description&&<details><summary>岗位职责与任职要求</summary><p>{facts.description}</p></details>}</details>}{job.degreeCheck&&<p className="application-degree">{job.degreeCheck}</p>}</>;
}

export default function ApplicationPanel({job}:{job:any}) {
  const items=job.applicationItems||[],requirements=items.filter((i:any)=>!isProcessItem(i)),process=items.filter(isProcessItem);
  return <section className="application-panel" aria-label="要求与申请流程"><SourcePosition job={job}/>{!!requirements.length&&<><h3>其他要求与优先条件</h3><ApplicationItems items={requirements}/></>}{!!process.length&&<ApplicationWorkflow items={process}/>}</section>;
}
