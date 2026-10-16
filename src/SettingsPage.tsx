import {formatDateTime} from '../shared/datetime';
import type { ComponentProps } from 'react';
import { Archive, ArrowDownToLine, Database, LogOut, Settings2, Activity } from 'lucide-react';
import AIForm from './AIForm';
import UsagePanel from './UsagePanel';
import CalendarSubscription from './CalendarSubscription';
import SourcesForm from './SourcesForm';
import { PagedItems } from './Pagination';
import './settings.css';

type RecordItem=Record<string,any>&{id:string;version:number};
type Props={
  state:any;busy:boolean;usageRevision:number;
  ai:Omit<ComponentProps<typeof AIForm>,'value'>;
  onBackup:()=>void;onRestore:()=>void;onRetry:()=>void;onQueue:()=>void;
  onLogout:()=>void;onRestoreRecord:(kind:string,item:RecordItem)=>void;
  onSourcesSaved:()=>void;
};
const time=formatDateTime;
const size=(n:number)=>n>=1048576?(n/1048576).toFixed(1)+' MB':Math.ceil(n/1024)+' KB';
const collections={task:'tasks',goal:'goals',study:'studies',profile:'profiles',exam:'exams',job:'jobs'};

export default function SettingsPage({state,busy,usageRevision,ai,onBackup,onRestore,onRetry,onQueue,onLogout,onRestoreRecord,onSourcesSaved}:Props) {
  const archived=Object.entries(collections).flatMap(([kind,key])=>(state[key] as RecordItem[]).filter(item=>item.archived).map(item=>({kind,item})));
  const waiting=state.queue.filter((q:any)=>!['done','error'].includes(q.state)).reduce((n:number,q:any)=>n+q.count,0);
  const failed=state.queue.filter((q:any)=>q.state==='error').reduce((n:number,q:any)=>n+q.count,0);
  return <div className="settings-page">
    <UsagePanel revision={usageRevision}/>
    <SourcesForm onSaved={onSourcesSaved}/>
    <div className="settings-columns">
      <section className="panel settings-section settings-ai" aria-label="AI 接口">
        <div className="settings-card-heading"><div><Settings2 size={19}/><h2>AI 接口</h2></div><span className="settings-kicker">今日 {Number(state.usage.calls||0).toLocaleString('zh-CN')} / {state.ai.unlimited?'不限':Number(state.ai.dailyLimit??60).toLocaleString('zh-CN')} 次</span></div>
        <AIForm value={state.ai} {...ai}/>
      </section>
      <div className="settings-side">
        <CalendarSubscription/>
        <section className="panel settings-section" aria-label="数据与备份">
          <div className="settings-card-heading"><div><Database size={19}/><h2>数据与备份</h2></div><span className="settings-kicker">保留 3 份</span></div>
          <div className="settings-meta-row"><span>最近备份</span><strong>{time(state.backupStatus.lastSuccess)}</strong></div>
          {state.backupStatus.error&&<p className="form-error" role="alert">{state.backupStatus.error}</p>}
          {state.health?.backup.state==='overdue'&&<p className="form-error" role="alert">超过 36 小时没有成功备份，请检查后台和服务器剩余空间。</p>}
          {state.health?.backup.state==='missing'&&<p className="settings-muted">尚无成功备份，请完成首次备份。</p>}
          <div className="settings-actions"><button className="btn secondary" disabled={busy} onClick={onBackup}><ArrowDownToLine size={16}/>立即备份</button><button className="text-btn" onClick={onRestore}>从备份恢复</button></div>
          {!!state.backups.length&&<details className="settings-disclosure"><summary>下载备份 <span>{state.backups.length}</span></summary><div className="backup-files">{state.backups.map((b:any)=><a key={b.name} href={'/api/backups/'+encodeURIComponent(b.name)}><span>{b.name}</span><small>{size(b.size)}</small><ArrowDownToLine size={15}/></a>)}</div></details>}
        </section>
        <section className="panel settings-section" aria-label="后台状态">
          <div className="settings-card-heading"><div><Activity size={19}/><h2>后台状态</h2></div><button className="text-btn" onClick={onQueue}>查看详情</button></div>
          <div className="worker-counts"><div><span>待处理</span><strong>{waiting}</strong></div><div><span>失败</span><strong className={failed?'late':''}>{failed}</strong></div><div><span>最近运行</span><strong className="worker-time">{time(state.worker.lastHeartbeat)}</strong></div></div>
          {state.health&&!state.health.worker.healthy&&<p className="form-error" role="alert">后台{state.health.worker.state==='stopped'?'已停止':'心跳未更新'}，新任务可能无法处理，请检查后台服务。</p>}
          {state.health?.queue.longRunning>0&&<p className="form-error" role="alert">有 {state.health.queue.longRunning} 项任务超过 15 分钟未推进，请在详情中检查原因。</p>}
          {state.health?.version&&<p className="settings-muted">程序版本 {state.health.version}</p>}
          {!!state.analysisProgress.total&&<p className="settings-muted">已保存 {state.analysisProgress.part} / {state.analysisProgress.total} 部分{state.analysisProgress.pendingParts>0&&`，${state.analysisProgress.pendingParts} 部分待处理`}</p>}
          <button className="text-btn worker-retry" disabled={busy} onClick={onRetry}>继续待处理任务</button>
        </section>
      </div>
    </div>
    <section className="panel settings-bottom">
      <details className="settings-archive"><summary><Archive size={17}/><span>已归档记录</span><span className="archive-count">{archived.length}</span></summary><div className="settings-archive-list"><PagedItems cacheKey="archived" items={archived}>{({kind,item})=><div key={kind+item.id}><span>{item.title||item.name||item.date+' 学习记录'}</span><button className="text-btn" disabled={busy} onClick={()=>onRestoreRecord(kind,item)}>恢复</button></div>}</PagedItems>{!archived.length&&<p className="settings-muted">暂无归档记录</p>}</div></details>
      <div className="settings-account"><span>当前设备</span><button className="text-btn" disabled={busy} onClick={onLogout}><LogOut size={16}/>退出登录</button></div>
    </section>
  </div>;
}
