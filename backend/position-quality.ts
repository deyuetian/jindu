import {hasEvidence,validGroups} from '../shared/eligibility.ts';
import {positionFacts,sourceCells,type SourcePosition} from '../shared/source-position.ts';
import {normalizeTableEvidence} from './table-evidence.ts';

const compact=(s:string)=>String(s||'').replace(/\s/g,'');
const absent=(s:string)=>!s||/^(?:无|不限|不限制|不作要求|无要求|无特殊要求|不要求|无需工作经历|无工作经验要求|未说明|—|-|\/)$/.test(compact(s));
function covered(value:string,quotes:string[]){
  let rest=compact(value);
  if(quotes.some(q=>q.includes(rest)))return true;
  for(const q of quotes.map(q=>q.replace(/【[^】]*】/g,'')).filter(Boolean).sort((a,b)=>b.length-a.length))rest=rest.split(q).join('');
  return /^[，,；;。\s、]*$/.test(rest);
}
export function positionQuality(job:any,facts:SourcePosition|undefined,rowText=''){
  const issues:string[]=[];
  const normalized=normalizeTableEvidence(job,rowText);
  const requirements=normalized.majorRequirements||[];
  const fields=facts?.fields||[];
  const majors=fields.filter(f=>/专业|学科/.test(f.header)&&!/学校|院校|经验|年限|资格|职称/.test(f.header)&&!/^未说明$/.test(f.value));
  if(facts?.major&&!/^未说明$/.test(facts.major)&&!requirements.length)issues.push('专业要求尚未完成核查');
  if(requirements.length&&rowText&&requirements.some((r:any)=>!hasEvidence(rowText,r.evidence||'')))issues.push('专业依据尚未核实');
  if(requirements.length&&facts?.education&&/本科|硕士|博士|专科|研究生|学士/.test(facts.education)&&!requirements.some((r:any)=>r.levels?.length))issues.push('学历范围尚未完成核查');
  const quotes=requirements.map((r:any)=>compact(r.evidence));
  for(const field of majors){
    // Separate degree columns must each be accounted for. A missing degree cannot
    // be silently converted into an unrestricted or single-degree requirement.
    if(/本科|硕士|博士|专科|研究生/.test(field.header)&&!quotes.some((q:string)=>q.includes(compact(field.value))))issues.push('不同学历的专业要求尚未核查完整');
  }
  const groups=(job.eligibilityRequirements||[]).filter((g:any)=>!rowText||validGroups([g],rowText));
  const evidence=groups.map((g:any)=>compact(g.evidence)).concat((job.applicationItems||[]).filter((i:any)=>!rowText||hasEvidence(rowText,i.evidence||'')).map((i:any)=>compact(i.evidence)));
  for(const field of fields){
    if(!/政治|性别|年龄|出生|户籍|民族|经历|经验|资格|证书|其他条件|其他要求|备注|任职/.test(field.header)||absent(field.value)||/^[^。；;\n]+优先(?:考虑)?[。.]?$/.test(field.value))continue;
    if(!covered(field.value,evidence))issues.push(field.header.replace(/\s/g,'')+'尚未核查完整');
  }
  if(job._missing||/此岗位行未获得完整分析|岗位匹配分析未完成/.test(job.reasons||''))issues.unshift('岗位匹配分析未完成');
  const repairable=issues.length>0;
  if(job.eligibilityCoverage==='partial'||job.eligibilityCoverage==='unknown')issues.push('部分资格条款仍待确认');
  if(job.applicationCoverage==='partial'||job.applicationCoverage==='unknown')issues.push('申请要求的完整性仍待确认');
  return {repairable,status:repairable?'partial':issues.length?'review':job.analysisIncomplete===false||job.eligibilityCoverage==='complete'?'complete':'unknown',issues:[...new Set(issues)]};
}

export function coverageSummary(jobs:any[],expected=0){
  const total=Math.max(expected,jobs.length),missing=Math.max(0,total-jobs.length);
  const incomplete=jobs.filter(j=>j.analysisQuality?.status==='partial').length+missing;
  const review=jobs.filter(j=>!['complete','partial'].includes(j.analysisQuality?.status)).length;
  return {total,checked:total-incomplete-review,incomplete,review,missing};
}

/** Check every supplied row before checkpointing a table batch. */
export function reviewTableJobs(rows:any[],extracted:any[]){
  const jobs:any[]=[],retryRows:any[]=[];
  for(const row of rows){
    const found=extracted.filter(j=>j.sourceRowId===row.rowId);
    const facts=row.sourcePosition||positionFacts(sourceCells(row.text));
    const fallback={title:row.title||row.positionCode||'岗位待核对',organization:row.organization,match:'待核对',reasons:'岗位匹配分析未完成',evidence:row.text,majorRequirements:[],eligibilityRequirements:[],eligibilityCoverage:'unknown',applicationItems:[]};
    const raw=found.length===1?found[0]:fallback;
    const item=normalizeTableEvidence({...raw,sourceRowId:row.rowId},row.text);
    const quality=positionQuality({...item,_missing:found.length!==1},facts,row.text);
    if(found.length>1)quality.issues.unshift('同一岗位返回了重复结果');
    if(quality.repairable)retryRows.push(row);
    const {text,title,organization,sourcePosition,...ref}=row;
    jobs.push({...item,title:row.title||item.title,organization:row.organization||item.organization,positionCode:row.positionCode||'',sourcePosition:facts,sourceRowId:row.rowId,sourceRow:ref,_rowSource:row.text,_missing:found.length!==1,analysisQuality:quality});
  }
  return {jobs,retryRows,unexpected:extracted.filter(j=>!rows.some(r=>r.rowId===j.sourceRowId)).length};
}
