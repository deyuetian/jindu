import {useEffect,useState} from 'react';
import {ArrowRight,RefreshCw} from 'lucide-react';
import {api} from './api';
import {formatDateTime} from '../shared/datetime';
export default function QueuePanel({onAnnouncement}:{onAnnouncement:(id:string)=>void}){
  const [rows,setRows]=useState<any[]>([]),[error,setError]=useState(''),[ready,setReady]=useState(false),[revision,setRevision]=useState(0);
  useEffect(()=>{const controller=new AbortController();let loading=false;
    const load=async()=>{if(loading)return;loading=true;try{const r=await api<any[]>('/queue',{signal:controller.signal});if(!controller.signal.aborted){setRows(r);setError('');setReady(true);}}catch(e){if(!controller.signal.aborted)setError((e as Error).message);}finally{loading=false;}};
    void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},5000);
    return()=>{controller.abort();clearInterval(timer);};
  },[revision]);
  return <div className="queue-panel"><div className="queue-toolbar"><span>{rows.length} 项待处理任务</span><button className="text-btn" onClick={()=>setRevision(r=>r+1)}><RefreshCw size={15}/>刷新</button></div>
    {error&&<p className="form-error" role="alert">{error}</p>}{!ready&&!error&&<p>正在读取后台进度…</p>}
    {rows.map(row=><article className="queue-card" key={row.id}><div className="queue-card-top"><span className={'pill '+(row.state==='running'?'green':'orange')}>{row.stateLabel}</span><span>{row.phase}</span></div><h3>{row.title}</h3>{row.sourceName&&<p className="queue-source">{row.sourceName}</p>}<p>{row.description}</p>{row.total>0&&<div className="queue-progress"><progress value={row.completed} max={row.total}/><span>已保存 {row.completed} / {row.total}{row.unfinished>0&&`，${row.unfinished} 部分待处理`}</span></div>}{row.partName&&<p className="queue-source">{row.partName}</p>}{row.error&&<p className="form-error">{row.error}</p>}<div className="queue-card-bottom"><small>更新于 {formatDateTime(row.updatedAt)}{row.nextAttemptAt&&<><br/>下次处理 {formatDateTime(row.nextAttemptAt)}</>}</small>{row.announcementId&&<button className="text-btn" onClick={()=>onAnnouncement(row.announcementId)}>查看公告 <ArrowRight size={14}/></button>}</div></article>)}
    {ready&&!rows.length&&!error&&<p className="list-placeholder">没有待处理或失败任务</p>}
  </div>;
}
