// Deployment-only repair with fixed record identities and versions. No AI or
// network calls. The operator must obtain approval for the exact input manifest.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {Store} from '../../backend/db.ts';
import {schemas,now,AppError} from '../../backend/model.ts';
import {manageRecruitmentRequest} from '../../backend/agent-management.ts';
import {undoTurn} from '../../backend/agent.ts';

const specSchema=z.object({receiptId:z.string().regex(/^repair:[a-z0-9-]+$/).max(120),text:z.string().min(1).max(6000),announcementId:z.string().min(1).max(120),
  expected:z.array(z.object({id:z.string().min(1).max(120),kind:z.enum(['job','exam']),version:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional()})).min(1).max(500)});
export function repairSavedRequest(store:Store,input:unknown){
  const spec=specSchema.parse(input),existing=store.get(spec.receiptId);
  if(existing){
    if(existing.kind!=='agent_turn'||!existing.done||!existing.actionVersion||existing.undone)throw new AppError(409,'修复记录状态已变化，请核对后重新批准');
    const before=JSON.parse(existing.before);
    if(before.type!=='recruitment-management'||before.records.length!==spec.expected.length||before.records.some((r:any)=>!spec.expected.some(e=>e.id===r.id&&e.kind===r.kind&&e.version+1===r.version)||store.get(r.id)?.version!==r.version))throw new AppError(409,'修复后已有其他修改，不能重复执行');
    return {status:'already-completed',receiptId:spec.receiptId};
  }
  const guard=()=>{
    for(const item of spec.expected){
      const row=store.prepare('SELECT kind,version,data FROM records WHERE id=?').get(item.id) as any;
      if(!row||row.kind!==item.kind||row.version!==item.version||JSON.parse(row.data).announcementId!==spec.announcementId||item.sha256&&createHash('sha256').update(row.data).digest('hex')!==item.sha256)throw new AppError(409,'待修复对象已变化，本次未作修改');
    }
    const actual=store.prepare("SELECT id FROM records WHERE json_extract(data,'$.announcementId')=? AND COALESCE(json_extract(data,'$.archived'),0)=0 AND ((kind='job' AND json_extract(data,'$.status') IN ('关注','拟投递')) OR (kind='exam' AND COALESCE(json_extract(data,'$.calendarKind'),'exam')!='personal'))").all(spec.announcementId) as {id:string}[];
    if(actual.length!==spec.expected.length||actual.some(r=>!spec.expected.some(e=>e.id===r.id)))throw new AppError(409,'关联记录范围已变化，本次未作修改');
  };
  let completed=false;
  const handled=manageRecruitmentRequest(store,spec.text,({reply,...extra})=>{
    if(!extra.before||!extra.actionVersion)throw new AppError(409,'请求未能完整执行，本次未作修改');
    const undo=JSON.parse(extra.before);
    if(undo.records.length!==spec.expected.length||undo.records.some((r:any)=>!spec.expected.some(e=>e.id===r.id&&e.kind===r.kind&&e.version+1===r.version)))throw new AppError(409,'修复范围与固定清单不一致，本次未作修改');
    store.put(spec.receiptId,'agent_turn',schemas.agent_turn.parse({createdAt:now(),done:true,reply:'已补做此前未完成的请求。\n'+reply,...extra}));completed=true;
  },guard);
  if(!handled||!completed)throw new AppError(409,'未识别固定请求，本次未作修改');
  return {status:'completed',receiptId:spec.receiptId,changedRecords:spec.expected.length};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  const mode=process.argv[2];if(!['--apply','--undo'].includes(mode))throw new Error('Specify the approved operation: --apply or --undo');
  const spec=specSchema.parse(JSON.parse(readFileSync(0,'utf8'))),store=new Store('/var/lib/jindu');
  try{
    if(mode==='--apply')console.log(JSON.stringify(repairSavedRequest(store,spec)));
    else {
      const record=store.get(spec.receiptId);
      if(!record)console.log(JSON.stringify({status:'not-applied'}));
      else if(record.undone)console.log(JSON.stringify({status:'already-undone'}));
      else {const patches=JSON.parse(record.before).records;if(!patches||patches.length!==spec.expected.length||patches.some((r:any)=>!spec.expected.some(e=>e.id===r.id&&e.kind===r.kind)))throw new Error('Repair receipt does not match the approved records');undoTurn(store,spec.receiptId);console.log(JSON.stringify({status:'undone'}));}
    }
  } finally {store.db.close();}
}
