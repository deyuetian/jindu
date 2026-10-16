import type {AnalysisSegment} from './job-tables.ts';

// Only retire segments positively identified as reference-only attachments. Mixed archives stay intact.
export function hasLegacyCatalogSegments(previous:any,files:{id:string;name:string}[]) {
  return previous?.segments?.some((s:AnalysisSegment)=>files.some(f=>
    s.rows?.some(r=>r.fileId===f.id)||s.text?.startsWith(`附件 ${f.name} `)||s.text?.startsWith(`未识别结构的附件 ${f.name}\n`)))||false;
}
export function rebuildCatalogPlan(previous:any,initial:AnalysisSegment[],signature:string,sourceHash:string) {
  const results:any[]=[];
  // A changed profile/source/model must never inherit earlier conclusions. The caller checks the signature.
  if(previous.signature!==signature||previous.sourceHash!==sourceHash||previous.rowRepair)return null;
  // Preserve only the exact, contiguous, completed general-text prefix, before any reference/position work.
  for(let i=0;i<Math.min(previous.index,initial.length);i++) {
    const old=previous.segments[i],next=initial[i],result=previous.results[i];
    if(!old||!result||old.table||next.table||old.imageId||next.imageId||old.text!==next.text||result.jobs?.length)break;
    results.push({...result,_source:next.text});
  }
  return {signature,sourceHash,index:results.length,results,segments:initial,repairs:0,stopped:false,issues:[],catalogPlanVersion:1};
}
