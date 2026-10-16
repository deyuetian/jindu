import {useState} from 'react';
import {Check, CheckCheck, ChevronLeft, ChevronRight, ListChecks, Plus} from 'lucide-react';
import DateInput from './DateInput';
import './daily-tasks.css';

type Item = Record<string, any> & {id: string; version: number};
type Props = {
  tasks: Item[];
  today: string;
  busy: boolean;
  onToggle: (task: Item) => void;
  onEdit: (task: Item) => void;
  onAdd: () => void;
};

const shiftDate = (date: string, amount: number) => {
  const value = new Date(date + 'T00:00:00Z');
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
};
const priority = (value: string) => ({紧急: 0, 重要: 1, 普通: 2}[value] ?? 2);

export default function DailyTasks({tasks, today, busy, onToggle, onEdit, onAdd}: Props) {
  // An empty selection follows today across midnight; a chosen history date stays put.
  const [selected, setSelected] = useState('');
  const date = selected || today;
  const choose = (value: string) => { if (value && value <= today) setSelected(value === today ? '' : value); };
  const entries = tasks.filter(t => !t.archived && t.repeat === 'daily' && t.due === date)
    .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || priority(a.priority) - priority(b.priority) || a.title.localeCompare(b.title, 'zh-CN'));
  const pending = entries.filter(t => !t.done), completed = entries.filter(t => t.done);
  const isToday = date === today;
  const weekday = new Intl.DateTimeFormat('zh-CN', {weekday: 'long', timeZone: 'UTC'}).format(new Date(date + 'T00:00:00Z'));

  function taskRow(task: Item) {
    return <li key={task.id} className={'daily-task-row' + (task.done ? ' is-done' : '')}>
      <button className="daily-task-check" role="checkbox" aria-checked={!!task.done} aria-label={`${task.done ? '恢复' : '完成'}任务：${task.title}`} disabled={busy} onClick={() => onToggle(task)}>
        {task.done && <Check size={19} aria-hidden="true"/>}
      </button>
      <button className="daily-task-content" onClick={() => onEdit(task)}>
        <strong>{task.title}</strong>
        <span>{task.category}{task.priority !== '普通' && <span className="daily-task-priority">{task.priority}</span>}</span>
      </button>
      <span className="daily-task-time">{task.time || '不限时刻'}</span>
    </li>;
  }

  return <div className="daily-page">
    <p className="daily-intro">每天要做的事，在这里逐项完成。</p>
    <section className="panel daily-checklist" aria-label="每日任务清单">
      <div className="daily-date-bar">
        <div className="daily-date-title"><div><span>{isToday ? '今天' : '历史记录'}</span><h2>{Number(date.slice(5, 7))} 月 {Number(date.slice(8, 10))} 日 <small>{weekday}</small></h2></div>
          {!isToday && <button className="text-btn" onClick={() => setSelected('')}>回到今天</button>}
        </div>
        <div className="daily-date-controls">
          <button className="icon-btn" aria-label="前一天" disabled={date <= '0001-01-01'} onClick={() => choose(shiftDate(date, -1))}><ChevronLeft size={19}/></button>
          <DateInput aria-label="查看日期" value={date} min="0001-01-01" max={today} onChange={event => choose(event.target.value)}/>
          <button className="icon-btn" aria-label="后一天" disabled={isToday} onClick={() => choose(shiftDate(date, 1))}><ChevronRight size={19}/></button>
        </div>
      </div>
      <div className="daily-progress" role="status" aria-live="polite" aria-atomic="true">
        <div><span>已完成 <strong>{completed.length}</strong> / {entries.length} 项</span><span>{entries.length ? pending.length ? `还有 ${pending.length} 项` : '全部完成' : '还没有安排'}</span></div>
        <progress aria-label="每日任务完成进度" value={completed.length} max={Math.max(1, entries.length)}/>
      </div>
      {entries.length === 0 ? <div className="daily-empty">
        <ListChecks size={32} aria-hidden="true"/>
        <h3>{isToday ? '从一件每天要做的事开始' : '这一天没有每日任务记录'}</h3>
        <p>{isToday ? '例如阅读、刷题或运动。设置一次，以后每天出现在这里。' : '可以切换日期查看，或回到今天安排任务。'}</p>
        {isToday ? <button className="btn secondary" onClick={onAdd}><Plus size={16}/>创建第一项每日任务</button> : <button className="btn secondary" onClick={() => setSelected('')}>回到今天的清单</button>}
      </div> : <>
        <section className="daily-task-section" aria-labelledby="daily-pending-heading">
          <div className="daily-list-heading"><h3 id="daily-pending-heading">待完成 <span>{pending.length}</span></h3><span>{isToday ? '今天的清单' : '当天的清单'}</span></div>
          {pending.length ? <ul className="daily-task-list" aria-label="待完成的每日任务">{pending.map(taskRow)}</ul> : <div className="daily-all-done"><CheckCheck size={22}/><span>{isToday ? '今天的每日任务已全部完成' : '这一天的每日任务已全部完成'}</span></div>}
        </section>
        {completed.length > 0 && <section className="daily-task-section daily-completed" aria-labelledby="daily-completed-heading">
          <div className="daily-list-heading"><h3 id="daily-completed-heading">已完成 <span>{completed.length}</span></h3></div>
          <ul className="daily-task-list" aria-label="已完成的每日任务">{completed.map(taskRow)}</ul>
        </section>}
      </>}
    </section>
    <p className="daily-footnote">每天独立记录完成情况；漏做的任务保留在原日期。按北京时间生成当天清单，不加入日历或日历订阅。</p>
  </div>;
}
