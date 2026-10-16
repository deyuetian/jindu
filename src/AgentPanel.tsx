import {formatDateTime} from '../shared/datetime';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, CalendarDays, MessageCircle, RotateCcw } from 'lucide-react';

type Props={api:(path:string,options?:RequestInit)=>Promise<any>;onChanged:()=>void;onCalendar:()=>void;exams:any[]};
const statusNames:Record<string,string>={pending:'已排队',running:'正在处理',retry:'稍后重试',waiting_config:'等待配置 AI 接口',waiting_quota:'今日额度已用完，次日继续',error:'本次未完成'};
export default function AgentPanel({api,onChanged,onCalendar,exams}:Props) {
  const [turns,setTurns]=useState<any[]>([]),[text,setText]=useState(''),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[error,setError]=useState('');
  const loading=useRef(false),request=useRef<{id:string;text:string}|null>(null),end=useRef<HTMLDivElement>(null),last=useRef('');
  const messages=useRef<HTMLDivElement>(null),reading=useRef(new Set<string>());
  const [readError,setReadError]=useState('');
  const load=async()=>{if(loading.current)return;loading.current=true;try{const result=await api('/agent');setTurns(previous=>{const ids=new Set(result.map((t:any)=>t.id));return [...previous.filter(t=>t.notice&&!ids.has(t.id)).map(t=>({...t,seen:true,noticeUnread:false})),...result].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));});setLoaded(true);setError('');const stamp=result.map((t:any)=>[t.id,t.done,t.undone,t.reply,t.seen,t.noticeUnread].join(':')).join('|');if(stamp!==last.current){last.current=stamp;onChanged();}}catch(e){setError((e as Error).message);}finally{loading.current=false;}};
  useEffect(()=>{void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},3000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{end.current?.scrollIntoView({block:'nearest',behavior:'smooth'});},[turns.length,turns.at(-1)?.done]);
  const pending=turns.find(t=>!t.done&&t.job?.state!=='error');
  const post=(path:string,data:any={})=>api(path,{method:'POST',body:JSON.stringify(data)});
  const unread=turns.filter(t=>t.noticeUnread);
  async function markRead(ids:string[]) {
    const selected=ids.filter(id=>!reading.current.has(id));if(!selected.length)return;
    selected.forEach(id=>reading.current.add(id));
    try{await post('/agent/seen',{ids:selected});setTurns(value=>value.map(t=>selected.includes(t.id)?{...t,seen:true,noticeUnread:false}:t));setReadError('');onChanged();}
    catch{setReadError('未读状态暂未同步，可以稍后点击“全部标为已读”。');}
    finally{selected.forEach(id=>reading.current.delete(id));}
  }
  const unreadKey=unread.map(t=>t.id).join('|');
  useEffect(()=>{
    const root=messages.current;if(!root||!unreadKey)return;
    const timers=new Map<string,ReturnType<typeof setTimeout>>();
    const observer=new IntersectionObserver(entries=>{
      for(const entry of entries){const id=(entry.target as HTMLElement).dataset.noticeId!;
        if(!entry.isIntersecting||entry.intersectionRatio<0.5||document.visibilityState!=='visible'){const timer=timers.get(id);if(timer)clearTimeout(timer);timers.delete(id);continue;}
        if(!timers.has(id))timers.set(id,setTimeout(()=>{timers.delete(id);if(document.visibilityState==='visible')void markRead([id]);},900));
      }
    },{threshold:[0,0.5]});
    root.querySelectorAll('[data-notice-unread="true"]').forEach(node=>observer.observe(node));
    const hide=()=>{if(document.visibilityState!=='visible'){timers.forEach(clearTimeout);timers.clear();}else root.querySelectorAll('[data-notice-unread="true"]').forEach(node=>{observer.unobserve(node);observer.observe(node);});};
    document.addEventListener('visibilitychange',hide);
    return()=>{observer.disconnect();timers.forEach(clearTimeout);document.removeEventListener('visibilitychange',hide);};
  },[unreadKey]);
  async function act(path:string){setBusy(true);setError('');try{await post(path);await load();onChanged();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function send(e:FormEvent){e.preventDefault();const value=text.trim();if(!value||busy)return;setBusy(true);setError('');if(request.current?.text!==value)request.current={id:crypto.randomUUID(),text:value};try{await post('/agent',request.current);setText('');request.current=null;await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <div className="agent-layout"><section className="panel agent-conversation" aria-label="日历与岗位助手对话"><div className="agent-heading"><div><MessageCircle size={19}/><strong>安排日程，也能筛选岗位</strong></div><span>对话保存在你的服务器</span></div>
    {unread.length>0&&<div className="agent-notice-toolbar"><button className="text-btn" onClick={()=>messages.current?.querySelector('[data-notice-unread="true"]')?.scrollIntoView({block:'center',behavior:'smooth'})}>未读通知 {unread.length}</button><button className="text-btn" onClick={()=>void markRead(unread.map(t=>t.id))}>全部标为已读</button></div>}
    {readError&&<p className="form-error" role="status">{readError}</p>}
    <div className="agent-messages" ref={messages} aria-live="polite" aria-busy={!loaded}>
      {!turns.length&&<div className="agent-welcome"><span className="eyebrow">从一句话开始</span><h2>今天需要我做什么？</h2><p>安排日历，筛选报考岗位，整理条件和报名材料。可以直接提供官方公告链接。</p><div className="agent-examples">{['明天晚上 7 点安排一小时复习','帮我筛选这个选调公告的岗位和报名材料','帮我安排 2027 年国家公务员考试的节点'].map(s=><button key={s} onClick={()=>setText(s)}>{s}<span>↗</span></button>)}</div></div>}
      {turns.map(t=><article className="agent-turn" key={t.id}>{t.text&&<div className="agent-bubble user"><small>我</small><p>{t.text}</p></div>}<div className={'agent-bubble assistant '+(t.notice?'notice':'')} data-notice-id={t.notice?t.id:undefined} data-notice-unread={t.noticeUnread?'true':undefined}><small>{t.notice?(t.noticeActive?`自动跟进 · 时间更新${t.noticeUnread?' · 未读':''}`:'历史通知 · 对应日历已移除'):'日历与岗位助手'}</small>{t.done?<p>{t.reply}</p>:<><p>{t.job?.state==='running'?t.progress:statusNames[t.job?.state]||t.progress}</p><span className="agent-progress">关闭网页后继续处理，结果会保留在这里。</span>{t.job?.error&&<p className="late">{t.job.error}</p>}</>}
        <div className="agent-message-actions">{t.reportAnnouncementId&&<a className="text-btn" href={'/api/announcements/'+encodeURIComponent(t.reportAnnouncementId)+'/jobs.xlsx'}>下载岗位筛选表</a>}{t.examId&&<button className="text-btn" onClick={onCalendar}><CalendarDays size={14}/>查看日历</button>}{t.actionVersion>0&&<button className="text-btn" disabled={busy||t.undone} onClick={()=>void act('/agent/'+encodeURIComponent(t.id)+'/undo')}><RotateCcw size={14}/>{t.undone?'已撤销':'撤销这次修改'}</button>}{!t.done&&t.job?.state==='error'&&<button className="text-btn" disabled={busy} onClick={()=>void act('/agent/'+encodeURIComponent(t.id)+'/retry')}>重试</button>}{!t.done&&<button className="text-btn muted" disabled={busy} onClick={()=>void act('/agent/'+encodeURIComponent(t.id)+'/cancel')}>取消这次请求</button>}</div>
      </div></article>)}<div ref={end}/>
    </div>
    <form className="agent-composer" onSubmit={send}>{error&&<p role="alert" className="form-error">{error}</p>}<label htmlFor="agent-message">给助手发消息</label><textarea id="agent-message" value={text} onChange={e=>setText(e.target.value)} maxLength={6000} rows={3} placeholder="例如：明天下午 3 点安排组会；取消关注某份公告，并移除它的日历。直接说明名称和要做的事即可。"/><div><span>{pending?'上一条消息正在处理':'时间均为北京时间。修改后可以撤销；考试报名仍需你自行办理。'}</span><button className="btn primary" disabled={busy||!!pending||!loaded||!text.trim()}><ArrowUp size={17}/>{busy?'正在发送':'发送'}</button></div></form>
  </section><aside className="agent-aside"><section className="panel settings-card"><span className="eyebrow">考试自动跟进</span><h2>已选考试</h2><p>每天检查官方公告。新公布和改期的日期会更新；你手动修改过的节点会保留。</p>{exams.filter(e=>!e.archived&&e.calendarKind!=='personal'&&e.tracking).map(e=><div className="agent-follow" key={e.id}><button className="text-heading" onClick={onCalendar}>{e.title}</button><span>{e.tracking.enabled?'跟进中':'已暂停'} · {e.stages.filter((s:any)=>!s.date).length} 项待公布或核对</span>{e.tracking.checkedAt&&<small>最近检查 {formatDateTime(e.tracking.checkedAt)}</small>}{e.tracking.error&&<p className="late">{e.tracking.error}</p>}</div>)}{!exams.some(e=>!e.archived&&e.calendarKind!=='personal'&&e.tracking)&&<p>安排第一场考试后，会出现在这里。</p>}<button className="text-btn" onClick={onCalendar}>打开重要日历 →</button></section><section className="panel settings-card"><h2>考试后续阶段</h2><p>明确告诉我“我已通过某某考试的笔试”，才会加入面试、体检和后续节点。</p><p>可以说“暂停跟进某某考试”，也能在日历里直接修改节点。</p></section></aside></div>;
}
