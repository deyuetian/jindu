import { randomUUID } from 'node:crypto';
import type { Store } from './db.ts';
import { AppError, now, todayCN } from './model.ts';

export type AIPurpose='announcement'|'recruitment'|'agent'|'calendar'|'exam'|'test'|'other';
type Measured={input:number|null;output:number|null;total:number|null;complete:boolean};
const count=(value:unknown):number|null=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
export function measuredUsage(usage:any):Measured {
  const input=count(usage?.prompt_tokens)??count(usage?.input_tokens);
  const output=count(usage?.completion_tokens)??count(usage?.output_tokens);
  const reported=count(usage?.total_tokens),sum=(input??0)+(output??0);
  // Reasoning and cache detail counts are subsets, never added a second time.
  const complete=(input!==null&&output!==null)||(reported!==null&&reported>=sum);
  return {input,output,total:reported!==null?Math.max(sum,reported):input!==null||output!==null?sum:null,complete};
}
export function beginUsage(store:Store,model:string,purpose:AIPurpose,limit:number,unlimited=false) {
  const day=todayCN(),id=randomUUID();
  store.transaction(()=>{
    const usage=store.db.prepare('SELECT calls FROM usage WHERE day=?').get(day) as any;
    if(!unlimited&&(usage?.calls||0)>=limit)throw new AppError(429,'今日 AI 调用已达上限，明天继续；也可调整上限后手动继续');
    store.db.prepare('INSERT INTO usage(day,calls) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET calls=calls+1').run(day);
    store.db.prepare('INSERT INTO ai_requests(id,day,model,purpose,started_at) VALUES(?,?,?,?,?)').run(id,day,model,purpose,now());
  });
  return {id,day};
}
export function finishUsage(store:Store,request:{id:string;day:string},outcome:'success'|'error',usage:Measured) {
  store.transaction(()=>{
    const r=store.db.prepare("UPDATE ai_requests SET outcome=?,finished_at=?,input_tokens=?,output_tokens=?,total_tokens=?,usage_complete=? WHERE id=? AND outcome='running'").run(outcome,now(),usage.input,usage.output,usage.total,usage.complete?1:0,request.id);
    if(r.changes)store.db.prepare('UPDATE usage SET input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE day=?').run(usage.input??0,usage.output??0,request.day);
  });
}
export function setUsagePurpose(store:Store,id:string,purpose:AIPurpose) {
  store.db.prepare("UPDATE ai_requests SET purpose=? WHERE id=? AND outcome='running'").run(purpose,id);
}
export function intentPurpose(intent:string):AIPurpose {
  if(intent.startsWith('recruitment_'))return 'recruitment';
  if(intent.startsWith('calendar_')||['enroll','update','passed','pause','resume','undo'].includes(intent))return 'calendar';
  return 'agent';
}
export function usageSummary(store:Store) {
  const today=todayCN(),from=todayCN(new Date(Date.parse(today+'T00:00:00+08:00')-6*86400000));
  // Preserve the old daily counters. Detailed requests start only with this version.
  const rows=store.db.prepare(`SELECT u.*,COALESCE(r.extra_tokens,0) extra_tokens,COALESCE(r.tracked,0) tracked,
    COALESCE(r.missing,0) missing,COALESCE(r.pending,0) pending,COALESCE(r.failed,0) failed
    FROM usage u LEFT JOIN (
      SELECT day,COUNT(*) tracked,SUM(MAX(0,COALESCE(total_tokens,0)-COALESCE(input_tokens,0)-COALESCE(output_tokens,0))) extra_tokens,
      SUM(CASE WHEN usage_complete=0 AND (outcome!='running' OR started_at<?) THEN 1 ELSE 0 END) missing,
      SUM(CASE WHEN outcome='running' AND started_at>=? THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN outcome='error' THEN 1 ELSE 0 END) failed FROM ai_requests GROUP BY day
    ) r ON r.day=u.day ORDER BY u.day DESC`).all(new Date(Date.now()-180000).toISOString(),new Date(Date.now()-180000).toISOString()) as any[];
  const sum=(items:any[])=>items.reduce((a,r)=>({calls:a.calls+r.calls,input:a.input+r.input_tokens,output:a.output+r.output_tokens,total:a.total+r.input_tokens+r.output_tokens+r.extra_tokens,missing:a.missing+r.missing,pending:a.pending+r.pending,failed:a.failed+r.failed,legacyCalls:a.legacyCalls+Math.max(0,r.calls-r.tracked)}),{calls:0,input:0,output:0,total:0,missing:0,pending:0,failed:0,legacyCalls:0});
  const recent=store.db.prepare('SELECT id,day,model,purpose,started_at,finished_at,outcome,input_tokens,output_tokens,total_tokens,usage_complete FROM ai_requests ORDER BY started_at DESC,id DESC LIMIT 20').all();
  const purposeRows=(start:string)=>store.db.prepare('SELECT purpose,COUNT(*) calls,COALESCE(SUM(total_tokens),0) total FROM ai_requests WHERE day>=? AND day<=? GROUP BY purpose ORDER BY total DESC').all(start,today);
  const purposePeriods={today:purposeRows(today),week:purposeRows(from),all:purposeRows('')};
  const byPurpose=purposePeriods.week;
  const days=Array.from({length:7},(_,i)=>{const day=todayCN(new Date(Date.parse(today+'T00:00:00+08:00')-i*86400000));return {day,...sum(rows.filter(r=>r.day===day))};});
  return {updatedAt:now(),timezone:'Asia/Shanghai',since:rows.at(-1)?.day||today,detailSince:(store.db.prepare('SELECT MIN(started_at) value FROM ai_requests').get() as any).value,periods:{today:sum(rows.filter(r=>r.day===today)),week:sum(rows.filter(r=>r.day>=from&&r.day<=today)),all:sum(rows)},days,byPurpose,purposePeriods,recent};
}
