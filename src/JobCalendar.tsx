import {useEffect,useState} from 'react';
import {CalendarDays,Check,ArrowRight} from 'lucide-react';
import {api} from './api';
export default function JobCalendar({job,onAdded,onOpenExam,onAnnouncement}:{job:any;onAdded:()=>void;onOpenExam:(exam:any)=>void;onAnnouncement:()=>void}){
  const [data,setData]=useState<any>(null),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0),[follow,setFollow]=useState(true),[saved,setSaved]=useState(false);
  const path='/jobs/'+encodeURIComponent(job.id)+'/calendar';
  useEffect(()=>{const controller=new AbortController();setError('');setData(null);api<any>(path,{signal:controller.signal}).then(v=>{if(!controller.signal.aborted){setData(v);setSelected(v.stages.map((s:any)=>s.id));}}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[path,reload]);
  useEffect(()=>{setSaved(false);setFollow(true);},[path]);
  async function submit(){
    if(busy||saved)return;
    setBusy(true);setError('');
    try{await api(path,{method:'POST',body:JSON.stringify({version:data.version,stageIds:selected,follow})});}
    catch(e){setError((e as Error).message);setBusy(false);return;}
    setSaved(true);onAdded();
    try{setData(await api<any>(path));}catch{setError('最新日历暂时读取失败，请重新读取。');}finally{setBusy(false);}
  }
  return <div className="job-calendar-view">{saved&&!data?.existing&&<div className="calendar-import-success" role="status"><Check size={22}/><strong>已加入日历</strong></div>}{error&&<p role="alert" className="form-error">{error} <button className="text-btn" disabled={busy} onClick={()=>setReload(v=>v+1)}>重新读取</button></p>}{!data&&!error&&<p className="list-placeholder">正在读取公告日期…</p>}{data&&<>
    <div className="calendar-import-heading"><CalendarDays size={25}/><div><span>所属公告</span><h3>{data.title}</h3></div></div>
    {data.existing?<><div className="calendar-import-success"><Check size={22}/><div><strong>{data.existing.archived?'这份公告的日历已归档':'已加入日历'}</strong><p>{data.existing.stages.filter((s:any)=>s.date).length} 个日期 · 同一公告共用日历安排</p></div></div><button className="btn primary" onClick={()=>onOpenExam(data.existing)}>{data.existing.archived?'查看归档安排':'查看日历安排'}<ArrowRight size={16}/></button></>:saved?null:data.stages.length?<>
      <p className="calendar-import-caption">选择要添加的时间节点</p><div className="calendar-import-list">{data.stages.map((s:any)=><label key={s.id}><input type="checkbox" checked={selected.includes(s.id)} disabled={busy} onChange={e=>setSelected(ids=>e.target.checked?[...ids,s.id]:ids.filter(id=>id!==s.id))}/><span><strong>{data.title} · {s.label}</strong><small>{s.date}{s.time?' '+s.time:' · 全天'}{s.inferredYear?' · 年份依据公告推定':''}</small></span></label>)}</div>
      <label className="calendar-follow"><input type="checkbox" checked={follow} onChange={e=>setFollow(e.target.checked)} disabled={busy}/>跟进公告日期更新</label><p className="calendar-import-caption">面试及后续节点在你确认通过后添加。</p>
      <button className="btn primary" disabled={busy||!selected.length} onClick={()=>void submit()}>{busy?'正在添加…':`加入 ${selected.length} 个节点`}</button>
    </>:<div className="calendar-import-empty"><CalendarDays size={30}/><h4>公告尚无明确日期</h4><p>可在所属公告中核对或手动补充时间节点。</p><button className="btn secondary" onClick={onAnnouncement}>查看公告时间节点 <ArrowRight size={15}/></button></div>}
  </>}</div>;
}
