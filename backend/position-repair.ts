import type {Store} from './db.ts';
import {analysisContext} from './ai.ts';
import {hash,type Config} from './config.ts';
import {AppError} from './model.ts';

export type RepairSelection={announcementId:string;signature:string;sourceHash:string;currentSignature?:string;rowIds:string[]};
/** Pure preparation for an explicitly selected historical repair. It never calls AI. */
export async function positionRepairPlan(store:Store,selection:RepairSelection){
  const {announcementId:id,signature,sourceHash,rowIds}=selection;
  const ann=store.get(id),work=store.getSetting<any>('analysis:'+id,null);
  if(!ann||!work||work.signature!==signature||!sourceHash||sourceHash!==ann.contentHash||(work.sourceHash&&work.sourceHash!==sourceHash)||work.index!==work.segments?.length)throw new AppError(409,'公告或分析记录已变化，补核清单需要重新核对');
  const context=await analysisContext(store,{} as Config,id,true);
  if((selection.currentSignature||signature)!==context.signature)throw new AppError(409,'当前资料或个人条件与补核清单不一致');
  // Older checkpoints lack sourceHash. Compare the actual retained inputs instead
  // of assuming a changed profile/model signature means the documents changed.
  const sourceText=(segments:any[])=>segments.filter(s=>!s.table&&!s.imageId).map(s=>s.text).join('');
  if(sourceText(context.initial)!==sourceText(work.segments))throw new AppError(409,'公告通用资料已变化，不能复用旧分析');
  const currentRows=new Map(context.initial.flatMap(s=>s.rows||[]).map(r=>[r.rowId,r.text]));
  for(const row of work.segments.flatMap((s:any)=>s.rows||[]))if(currentRows.get(row.rowId)!==row.text)throw new AppError(409,'原表内容或筛选范围已变化，不能复用旧分析');
  if(JSON.stringify(context.initial.filter(s=>s.imageId).map(s=>s.imageId))!==JSON.stringify(work.segments.filter((s:any)=>s.imageId).map((s:any)=>s.imageId)))throw new AppError(409,'图片资料已变化，不能复用旧分析');
  if(!rowIds.length||new Set(rowIds).size!==rowIds.length)throw new AppError(400,'补核岗位清单为空或重复');
  const wanted=new Set(rowIds),known=new Set<string>();
  const segments=work.segments.filter((s:any)=>s.table).flatMap((s:any)=>{
    const rows=s.rows.filter((r:any)=>wanted.has(r.rowId)&&!known.has(r.rowId));
    rows.forEach((r:any)=>known.add(r.rowId));
    return rows.length?[{text:rows.map((r:any)=>`岗位行ID：${r.rowId}\n${r.text}`).join('\n\n'),depth:0,imageId:'',table:true,rows}]:[];
  });
  if(known.size!==wanted.size)throw new AppError(409,'部分补核岗位没有对应的原表记录');
  const selectedJobs=store.list('job').filter(j=>j.announcementId===id&&wanted.has(j.sourceRowId||j.sourceRow?.rowId));
  if(selectedJobs.length!==wanted.size||selectedJobs.some(j=>j.analysisCurrent===false))throw new AppError(409,'补核岗位记录已变化');
  const busy=store.db.prepare("SELECT 1 FROM jobs WHERE type='analyze' AND json_extract(payload,'$.id')=? AND state IN ('pending','running','retry','waiting_config','waiting_quota')").get(id);
  if(busy)throw new AppError(409,'该公告已有分析任务，需完成后再补核');
  return {
    ...work,sourceHash,signature:context.signature,index:work.segments.length,segments:[...work.segments,...segments],
    results:work.results.map((r:any)=>({...r,jobs:(r.jobs||[]).filter((j:any)=>!wanted.has(j.sourceRowId))})),
    repairs:0,stopped:false,rowRepair:{rowIds,signature,checkpointHash:hash(JSON.stringify(work)),jobIds:selectedJobs.map(j=>j.id)},
  };
}
/** Called only by the approved fixed-list release runner, not on reads or startup. */
export async function schedulePositionRepairs(store:Store,selections:RepairSelection[]){
  if(!selections.length||new Set(selections.map(s=>s.announcementId)).size!==selections.length)throw new AppError(400,'补核公告清单为空或重复');
  const prepared:{selection:RepairSelection;work:any}[]=[];for(const selection of selections)prepared.push({selection,work:await positionRepairPlan(store,selection)});
  return store.transaction(()=>{
    for(const {selection,work} of prepared){
      if(hash(JSON.stringify(store.getSetting('analysis:'+selection.announcementId,null)))!==work.rowRepair.checkpointHash||store.get(selection.announcementId)?.contentHash!==selection.sourceHash)throw new AppError(409,'分析记录已变化，未提交补核');
      store.setSetting('analysis:'+selection.announcementId,work);
      store.enqueueAnalysis(selection.announcementId);
    }
    return prepared.map(({selection,work})=>({announcementId:selection.announcementId,rows:selection.rowIds.length,segments:work.segments.length-work.index}));
  });
}
