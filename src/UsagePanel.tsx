import {formatDateTime} from '../shared/datetime';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from './api';

const format=(value:number)=>Number(value||0).toLocaleString('zh-CN');
const headline=(value:number)=>value>=100000000?`${(value/100000000).toLocaleString('zh-CN',{maximumFractionDigits:2})} 亿`:format(value);
const purposes:Record<string,string>={announcement:'公告分析',recruitment:'岗位助手',agent:'助手对话',calendar:'日历对话',exam:'考试日期核对',test:'接口测试',other:'其他'};
export default function UsagePanel({revision=0}:{revision?:number}) {
  const [data,setData]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[period,setPeriod]=useState('today');
  const refresh=useRef<()=>void>(()=>{});
  useEffect(()=>{
    const controller=new AbortController();let pending=false;
    const load=async()=>{
      if(pending||controller.signal.aborted)return;pending=true;setBusy(true);
      try{const next=await api('/usage',{signal:controller.signal},15000);if(!controller.signal.aborted){setData(next);setError('');}}
      catch(e){if(!controller.signal.aborted)setError((e as Error).message);}
      finally{pending=false;if(!controller.signal.aborted)setBusy(false);}
    };
    refresh.current=()=>void load();void load();
    const visible=()=>{if(document.visibilityState==='visible')void load();};
    const timer=setInterval(visible,15000);window.addEventListener('focus',visible);window.addEventListener('online',visible);
    return()=>{controller.abort();clearInterval(timer);window.removeEventListener('focus',visible);window.removeEventListener('online',visible);};
  },[revision]);
  const stats=data?.periods[period];
  const purposeRows=data?.purposePeriods?.[period]||data?.byPurpose||[];
  return <section className="panel usage-panel" aria-label="AI Token 用量">
    <div className="usage-header"><h2>Token 用量</h2><div className="usage-controls"><div className="usage-periods" role="group" aria-label="用量时间范围">{[['today','今日'],['week','近 7 天'],['all','累计']].map(([id,label])=><button type="button" key={id} aria-pressed={period===id} onClick={()=>setPeriod(id)}>{label}</button>)}</div><button className="icon-btn" aria-label="刷新用量" title="刷新用量" disabled={busy} onClick={()=>refresh.current()}><RefreshCw size={16} className={busy?'is-refreshing':''}/></button></div></div>
    {error&&<p role="alert" className="form-error">{error}{data?' · 显示上次统计':''}</p>}
    {!stats&&!error&&<p className="settings-muted" role="status">正在读取用量…</p>}
    {stats&&<><div className="usage-stats">{[['总 Token',stats.total],['输入',stats.input],['输出',stats.output],['请求次数',stats.calls]].map(([label,value])=><div key={label}><span>{label}</span><strong title={format(Number(value))} aria-label={`${label} ${format(Number(value))}`}>{headline(Number(value))}</strong></div>)}</div>
      <div className="usage-meta"><span>{period==='all'?`${data.since} 起`:'北京时间'}{stats.missing>0?' · 部分用量缺失':''}</span><span>更新于 {new Date(data.updatedAt).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</span></div>
      <details className="usage-details"><summary>查看明细</summary>
        <div className="usage-breakdown"><div><div className="usage-table-wrap" tabIndex={0} aria-label="每日用量表格"><table><caption>近 7 天用量</caption><thead><tr><th>日期</th><th>请求</th><th>输入</th><th>输出</th><th>Token</th></tr></thead><tbody>{data.days.map((d:any)=><tr key={d.day}><td>{d.day}</td><td>{format(d.calls)}</td><td>{format(d.input)}</td><td>{format(d.output)}</td><td>{format(d.total)}</td></tr>)}</tbody></table></div>
        {!!purposeRows.length&&<div className="usage-purposes"><h3>{period==='today'?'今日':period==='week'?'近 7 天':'累计'}用途</h3>{purposeRows.map((p:any)=><div key={p.purpose}><span>{purposes[p.purpose]||'其他'}</span><strong>{format(p.total)}<small>{format(p.calls)} 次</small></strong></div>)}</div>}</div>
        <div className="usage-recent"><h3>最近请求</h3><div className="usage-requests">{data.recent.map((r:any)=>{const pending=r.outcome==='running'&&Date.parse(r.started_at)>Date.parse(data.updatedAt)-180000;return <div className="usage-request" key={r.id}><div><strong>{purposes[r.purpose]||'其他'}</strong><span className="request-model">{r.model}</span><small>{formatDateTime(r.started_at)} · {pending?'进行中':r.outcome==='success'?'已返回':r.outcome==='error'?'请求失败':'状态未知'}</small></div><span>{r.total_tokens===null?(pending?'等待返回':'用量未知'):`${format(r.total_tokens)} Token${r.usage_complete?'':'（部分）'}`}</span></div>;})}{!data.recent.length&&<p className="settings-muted">暂无请求明细</p>}</div></div></div>
      </details>
    </>}
  </section>;
}
