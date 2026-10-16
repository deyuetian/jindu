import { useEffect, useState } from 'react';
import { CalendarDays, Copy, RefreshCw } from 'lucide-react';
import { api } from './api';

type Status={enabled:boolean;configured:boolean;version:number;lastFetchedAt:string};
export default function CalendarSubscription() {
  const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[url,setUrl]=useState('');
  useEffect(()=>{
    const controller=new AbortController();
    api<Status>('/calendar/subscription',{signal:controller.signal}).then(v=>{if(!controller.signal.aborted)setStatus(v);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>controller.abort();
  },[]);
  async function refresh() {setBusy(true);setError('');setMessage('');try{setStatus(await api('/calendar/subscription'));setUrl('');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function change(action:'enable'|'disable'|'rotate') {
    if(!status)return;
    if(action==='disable'&&!window.confirm('停用后，手机和电脑无法再读取更新。已下载的日程可能仍保留在设备中。确定停用？'))return;
    if(action==='rotate'&&!window.confirm('重置后旧链接立即失效，所有设备都需要换成新链接。确定重置？'))return;
    setBusy(true);setError('');setMessage('');setUrl('');
    try{setStatus(await api('/calendar/subscription',{method:'PUT',body:JSON.stringify({action,version:status.version})}));setMessage(action==='disable'?'已停用订阅。':action==='rotate'?'已重置，请复制新链接并在设备上重新订阅。':'已启用，请复制链接到手机日历。');}
    catch(e){setError((e as Error).message);try{setStatus(await api('/calendar/subscription'));}catch{/* Preserve the visible state and provide a retry button. */}}
    finally{setBusy(false);}
  }
  async function copy() {
    setBusy(true);setError('');setMessage('');
    try {
      const data=await api<{url:string}>('/calendar/subscription/link');setUrl(data.url);
      try{await navigator.clipboard.writeText(data.url);setMessage('已复制订阅链接');}
      catch{setMessage('请选中下方链接复制');}
    }catch(e){setUrl('');setError((e as Error).message);}finally{setBusy(false);}
  }
  return <section className="panel calendar-subscription" aria-label="日历同步">
    <div className="settings-card-heading"><div><CalendarDays size={19}/><h2>日历同步</h2></div><button className="icon-btn" disabled={busy} onClick={()=>void refresh()} aria-label="刷新订阅状态"><RefreshCw size={16} className={busy?'is-refreshing':''}/></button></div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {message&&<p className="form-hint" role="status">{message}</p>}
    {!status&&!error&&<p>正在读取订阅状态…</p>}
    {status&&<>
      <div className="subscription-status"><span className={'settings-badge '+(status.enabled?'enabled':'')}>{status.enabled?'已启用':'未启用'}</span><span>最近读取 {status.lastFetchedAt?new Date(status.lastFetchedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'暂无'}</span></div>
      <div className="subscription-actions">
        {status.enabled?<><button className="btn primary" disabled={busy} onClick={()=>void copy()}><Copy size={16}/>复制订阅链接</button><button className="text-btn" disabled={busy} onClick={()=>void change('disable')}>停用订阅</button></>:<button className="btn primary" disabled={busy} onClick={()=>void change('enable')}>{status.configured?'重新启用订阅':'启用日历订阅'}</button>}
      </div>
      {url&&<label className="subscription-link">私人订阅链接<input readOnly value={url} onFocus={e=>e.target.select()} autoComplete="off" spellCheck={false}/></label>}
      <div className="subscription-footer"><details><summary>如何订阅</summary><dl><dt>手机</dt><dd>日程同步与导入 → URL 日历 → 粘贴链接 → 订阅。</dd><dt>Outlook</dt><dd>添加日历 → 从 Web 订阅 → 粘贴链接。</dd></dl><p>同步个人日程、已加入日历的考试节点和非每日任务的截止日期。每日任务不参与同步。在本站修改日程，设备定期读取更新。链接仅供自己使用。</p></details>{status.enabled&&<button className="text-btn" disabled={busy} onClick={()=>void change('rotate')}>重置链接</button>}</div>
    </>}
  </section>;
}
