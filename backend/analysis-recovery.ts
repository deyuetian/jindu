/** Persisted, bounded recovery for individual analysis segments. No network or writes here. */
export const outputRepairLimit=4;
export function prepareAnalysisWork(work:any){
  work.baseIssues??=[...(work.issues||[])];
  if(work.recoveryVersion===1)return work;
  // The old counter was shared by the whole notice. It cannot tell us how many
  // attempts this segment used. Preserve it for history, not as a new stop rule.
  work.recoveryVersion=1;
  for(const [i,segment] of (work.segments||[]).entries()){
    segment.outputRepairs=0;
    if(i<work.index)segment.outcome='complete';
    const result=work.results?.[i];
    if(i<work.index&&result&&(result._imageId===segment.imageId&&segment.imageId||result._source?.startsWith(segment.text)))segment.resultIndex=i;
  }
  return work;
}
export function saveSegmentResult(work:any,segment:any,result:any){
  if(Number.isInteger(segment.resultIndex))work.results[segment.resultIndex]=result;
  else {segment.resultIndex=work.results.length;work.results.push(result);}
}
export function resumeAnalysisWork(work:any){
  if(!work?.signature||!Array.isArray(work.segments))return false;
  prepareAnalysisWork(work);
  const retry=work.segments.findIndex((s:any)=>['failed','review'].includes(s.outcome));
  if(retry<0&&work.index>=work.segments.length)return false;
  work.index=retry<0?work.index:Math.min(work.index,retry);
  work.repairs=0;work.stopped=false;work.consecutiveOutputFailures=0;
  for(let i=work.index;i<work.segments.length;i++){
    const segment=work.segments[i];
    if(['complete','skipped','omitted'].includes(segment.outcome))continue;
    segment.outcome=undefined;segment.outputRepairs=0;segment.rowRepairs=0;
    // Keep successful rows, their evidence, and the latest corrective hint.
  }
  work.issues=analysisWorkIssues(work);
  return true;
}
export function analysisRecovery(work:any){
  const segments=Array.isArray(work?.segments)?work.segments:[];
  const parts=segments.flatMap((s:any,i:number)=>['failed','review','skipped'].includes(s.outcome)?[{
    part:i+1,name:s.partName||s.rows?.[0]?.fileName||(s.imageId?'图片附件':'公告正文'),
    code:s.failure?.code||(s.outcome==='review'?'coverage':'source'),
    message:s.failure?.message||(s.issues||[]).join('；')||'本部分仍待核查',
    retryable:s.outcome!=='skipped',
  }]:[]);
  const active=segments.filter((s:any)=>s.outcome!=='omitted');
  const processed=segments.slice(0,work?.index||0).filter((s:any)=>s.outcome!=='omitted').length;
  const saved=work?.recoveryVersion===1?active.filter((s:any)=>s.outcome==='complete'||s.outcome==='review').length:processed;
  return {total:active.length,saved,processed,pending:parts.filter((p:any)=>p.retryable).length,parts};
}
export function analysisWorkIssues(work:any):string[]{
  return [...(work.baseIssues||work.issues||[]),...(work.segments||[]).flatMap((s:any,i:number)=>{const message=s.failure&&s.outcome==='failed'?s.failure.message:(s.issues||[]).join('；');return message?[`第 ${i+1} 部分（${s.partName||s.rows?.[0]?.fileName||'公告正文'}）：${message}`]:[];})];
}

export function checkpointAnalysisWork(store:{setSetting:(key:string,value:any)=>void},id:string,work:any){
  // Keep the legacy issues field usable by the previous version during rollback.
  work.issues=analysisWorkIssues(work);store.setSetting('analysis:'+id,work);
}
