// Isolated image check. Temporary records only; no worker or external requests.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../../backend/db.ts';
import {hash} from '../../backend/config.ts';
import {calendarFeed, subscriptionLink, updateSubscription} from '../../backend/calendar-feed.ts';
import {isCalendarTask} from '../../shared/calendar-policy.ts';

const dataDir=mkdtempSync(join(tmpdir(),'jindu-daily-'));
const store=new Store(dataDir);
const config={dataDir,origin:'http://127.0.0.1:8788',masterKey:randomBytes(32).toString('hex')};
try {
  const base={title:'每日阅读',category:'学习',due:'2026-09-20',time:'08:30',priority:'普通',done:false,notes:'',repeat:'daily',repeatUntil:'2026-09-22'};
  const first=store.save('task',base);
  store.save('task',{...first,done:true},first.id,first.version);
  store.repeat('2026-09-22');store.repeat('2026-09-22');
  const days=store.list('task').sort((a,b)=>a.due.localeCompare(b.due));
  assert.equal(days.length,3);assert.deepEqual(days.map(t=>t.done),[true,false,false]);
  assert.ok(days.every(t=>!isCalendarTask(t)));
  store.save('task',{...base,title:'一次性任务',repeat:'none'});
  store.save('task',{...base,title:'每周任务',repeat:'weekly'});
  store.save('exam',{title:'示例考试',type:'其他',url:'',stages:[{id:'exam',label:'准考证打印开始',date:'2026-09-22',time:'10:00'}]});
  updateSubscription(store,config,{action:'enable',version:0});
  const token=subscriptionLink(store,config).url.split('/').at(-1).slice(0,-4);
  // Simulate a daily occurrence published by the old version.
  const uid=hash(JSON.stringify(['task',first.id,'']))+'@jindu.calendar';
  store.setSetting('calendar-subscription-events',{[uid]:{event:{date:first.due,time:first.time,title:first.title,category:'任务'},sequence:2,updatedAt:'2026-09-20T00:00:00Z',cancelled:false}});
  const before=JSON.stringify(store.list('task'));
  const feed=calendarFeed(store,config,token);
  const entries=feed.body.replace(/\r\n /g,'').split('BEGIN:VEVENT\r\n').slice(1).map(e=>e.split('END:VEVENT')[0]);
  const active=entries.filter(e=>e.includes('STATUS:CONFIRMED'));
  assert.equal(active.length,3);assert.ok(active.every(e=>!e.includes('每日阅读')));
  const cancelled=entries.find(e=>e.includes(uid));
  assert.ok(cancelled.includes('STATUS:CANCELLED'));assert.ok(cancelled.includes('SEQUENCE:3'));
  assert.equal(calendarFeed(store,config,token).body,feed.body);
  assert.equal(JSON.stringify(store.list('task')),before);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM usage').get().n,0);
  console.log(JSON.stringify({passed:true,independentDailyCompletion:true,repeatIdempotent:true,dailyExcludedFromCalendar:true,legacySubscriptionCancelled:true,otherEventsPreserved:true,recordsUnchanged:true,externalAICalls:0}));
} finally {store.db.close();}
