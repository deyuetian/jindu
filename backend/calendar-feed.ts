import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { dateSchema } from '../shared/model.ts';
import { isCalendarTask,calendarExamView } from '../shared/calendar-policy.ts';
import { AppError, now, nextDate } from './model.ts';
import { equal, hash, seal, unseal, type Config } from './config.ts';
import type { Store } from './db.ts';

const settingKey = 'calendar-subscription';
const journalKey = 'calendar-subscription-events';
type Subscription = { enabled:boolean; secret:string; version:number; updatedAt:string; lastFetchedAt:string };
type Event = { date:string; time:string; title:string; category:string };
type Published = { event:Event; sequence:number; updatedAt:string; cancelled:boolean };
type Journal = Record<string, Published>;
const initial:Subscription = { enabled:false, secret:'', version:0, updatedAt:'', lastFetchedAt:'' };
const read = (store:Store) => store.getSetting<Subscription>(settingKey, initial);

export function subscriptionStatus(store:Store) {
  const { secret, ...value } = read(store);
  return { ...value, configured:!!secret };
}

export function updateSubscription(store:Store, config:Config, input:unknown) {
  const v = z.object({ action:z.enum(['enable','disable','rotate']), version:z.number().int().min(0) }).parse(input);
  return store.transaction(() => {
    const old = read(store);
    if (old.version !== v.version) throw new AppError(409, '订阅设置已变化，请刷新后重试');
    if (v.action === 'rotate' && !old.enabled) throw new AppError(400, '请先启用日历订阅');
    const secret = v.action === 'rotate' || (v.action === 'enable' && !old.secret)
      ? seal(randomBytes(32).toString('hex'), config.masterKey) : old.secret;
    store.setSetting(settingKey, { ...old, secret, enabled:v.action !== 'disable', version:old.version+1, updatedAt:now() });
    return subscriptionStatus(store);
  });
}

export function subscriptionLink(store:Store, config:Config) {
  const value = read(store);
  if (!value.enabled || !value.secret) throw new AppError(409, '日历订阅尚未启用');
  return { url:config.origin + '/api/calendar/feed/' + unseal(value.secret, config.masterKey) + '.ics' };
}

const uid = (kind:string, id:string, stage='') => hash(JSON.stringify([kind,id,stage])) + '@jindu.calendar';
function currentEvents(store:Store):Record<string,Event> {
  const result:Record<string,Event> = {};
  const add = (id:string, date:unknown, time:unknown, title:string, category:string) => {
    if (!dateSchema.safeParse(date).success) return;
    result[id] = { date:date as string, time:typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : '', title, category };
  };
  // This is the same set of saved dated records shown in the website calendar.
  // Announcements, profiles, notes, chat history and API settings are not published.
  for (const task of store.list('task')) if (isCalendarTask(task)) {
    add(uid('task',task.id), task.due, task.time, (task.done ? '已完成 · ' : '') + task.title, '任务');
  }
  for (const event of store.list('exam')) if (!event.archived) {
    for (const stage of calendarExamView(event).stages) add(uid('exam',event.id,stage.id), stage.date, stage.time,
      event.title + ' · ' + stage.label, event.calendarKind === 'personal' ? '个人日程' : '考试');
  }
  return result;
}

// RFC 5545 TEXT escaping also prevents user text from injecting ICS properties.
export function icalText(value:string) {
  return value.replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
}
export function foldLine(line:string) {
  let part='', bytes=0; const parts:string[]=[];
  for (const character of line) {
    const length=Buffer.byteLength(character,'utf8');
    if (bytes+length>75) { parts.push(part); part=' '; bytes=1; }
    part+=character; bytes+=length;
  }
  parts.push(part); return parts.join('\r\n');
}
const stamp = (date:string) => new Date(date).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
const day = (date:string) => date.replace(/-/g,'');

export function calendarFeed(store:Store, config:Config, credential:string) {
  const settings=read(store);
  if (!settings.enabled || !settings.secret || !/^[a-f0-9]{64}$/.test(credential)
    || !equal(credential, unseal(settings.secret,config.masterKey))) throw new AppError(404, '订阅链接无效或已停用');
  return store.transaction(() => {
    const current=currentEvents(store), journal=store.getSetting<Journal>(journalKey,{}), updatedAt=now();
    let changed=false;
    for (const [id,event] of Object.entries(current)) {
      const previous=journal[id];
      if (!previous || previous.cancelled || JSON.stringify(previous.event)!==JSON.stringify(event)) {
        journal[id]={ event, sequence:previous ? previous.sequence+1 : 0, updatedAt, cancelled:false }; changed=true;
      }
    }
    // Retain the last published start date and UID for removed/archived stages.
    // Clients that missed several refreshes can still recognize a cancellation.
    for (const [id,entry] of Object.entries(journal)) if (!current[id] && !entry.cancelled) {
      journal[id]={...entry,sequence:entry.sequence+1,updatedAt,cancelled:true}; changed=true;
    }
    if (changed) store.setSetting(journalKey,journal);
    const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//JINDU//Personal Calendar//ZH-CN','CALSCALE:GREGORIAN',
      'NAME:进度日历','X-WR-CALNAME:进度日历','X-WR-TIMEZONE:Asia/Shanghai',
      'REFRESH-INTERVAL;VALUE=DURATION:PT1H','X-PUBLISHED-TTL:PT1H'];
    for (const id of Object.keys(journal).sort()) {
      const entry=journal[id], event=entry.event;
      lines.push('BEGIN:VEVENT','UID:'+id,'DTSTAMP:'+stamp(entry.updatedAt),'LAST-MODIFIED:'+stamp(entry.updatedAt),'SEQUENCE:'+entry.sequence);
      // All website times are Beijing time. UTC timestamps avoid floating times
      // shifting when the subscriber travels or uses a different device timezone.
      if (event.time) lines.push('DTSTART:'+stamp(event.date+'T'+event.time+':00+08:00'));
      else {
        lines.push('DTSTART;VALUE=DATE:'+day(event.date));
        const end=nextDate(event.date,1);
        if(dateSchema.safeParse(end).success)lines.push('DTEND;VALUE=DATE:'+day(end));
      }
      lines.push('SUMMARY:'+icalText(event.title),'CATEGORIES:'+icalText(event.category),
        'STATUS:'+(entry.cancelled?'CANCELLED':'CONFIRMED'),'TRANSP:TRANSPARENT','END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    const body=lines.map(foldLine).join('\r\n')+'\r\n';
    return { body, etag:'"'+hash(body)+'"' };
  });
}

export function noteSubscriptionFetch(store:Store) {
  const value=read(store);
  if (value.enabled && (!value.lastFetchedAt || Date.now()-Date.parse(value.lastFetchedAt)>=60000)) {
    store.setSetting(settingKey,{...value,lastFetchedAt:now()});
  }
}
