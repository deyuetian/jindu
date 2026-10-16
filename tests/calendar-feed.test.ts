import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync,mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../backend/db.ts';
import { hash,type Config } from '../backend/config.ts';
import { createApp } from '../backend/app.ts';
import { calendarFeed,subscriptionLink,subscriptionStatus,updateSubscription } from '../backend/calendar-feed.ts';
import { requestPublic } from '../backend/net.ts';
vi.mock('../backend/net.ts',async original=>({...await original<typeof import('../backend/net.ts')>(),requestPublic:vi.fn()}));

let store:Store,config:Config;
const task={title:'续费',category:'日常',due:'2026-09-30',time:'10:00',priority:'普通',done:false,notes:'私人备注不会订阅',goalId:'',archived:false};
const personal={title:'开会',calendarKind:'personal',type:'其他',url:'',notes:'私人备注不会订阅',stages:[{id:'start',label:'开始',date:'2026-09-30',time:'14:00'}],archived:false};
beforeEach(()=>{
  mkdirSync('.check/tests/calendar-sync-v6',{recursive:true});const dataDir=mkdtempSync(resolve('.check/tests/calendar-sync-v6/case-'));
  config={dataDir,origin:'http://127.0.0.1:8788',host:'127.0.0.1',port:8788,adminUsername:'test',passwordHash:'unused',masterKey:randomBytes(32).toString('hex'),python:process.env.JINDU_TEST_PYTHON||'python',distDir:resolve('dist')};
  store=new Store(dataDir);vi.mocked(requestPublic).mockClear();
});
afterEach(()=>store.db.close());
function enable() {updateSubscription(store,config,{action:'enable',version:0});return subscriptionLink(store,config).url.split('/').at(-1)!.slice(0,-4);}
const unfolded=(body:string)=>body.replace(/\r\n /g,'');
const events=(body:string)=>unfolded(body).split('BEGIN:VEVENT\r\n').slice(1).map(e=>e.split('END:VEVENT')[0]);
const value=(event:string,key:string)=>event.split('\r\n').find(line=>line.startsWith(key+':'))?.slice(key.length+1);

describe('long-lived calendar subscription',()=>{
  it('starts disabled and only accepts the private subscription credential',()=>{
    expect(subscriptionStatus(store)).toMatchObject({enabled:false,configured:false,version:0});
    expect(()=>calendarFeed(store,config,'0'.repeat(64))).toThrow('无效');
    const credential=enable();
    expect(()=>calendarFeed(store,config,'1'.repeat(64))).toThrow('无效');
    expect(()=>calendarFeed(store,config,credential+'x')).toThrow('无效');
    expect(calendarFeed(store,config,credential).body).toContain('BEGIN:VCALENDAR');
    expect(JSON.stringify(store.db.prepare('SELECT * FROM settings').all())).not.toContain(credential);
    expect(JSON.stringify(subscriptionStatus(store))).not.toContain(credential);
  });
  it('keeps the URL and event UID stable while dates, titles and cancellation change',()=>{
    const record=store.save('exam',personal),credential=enable(),url=subscriptionLink(store,config).url;
    const first=calendarFeed(store,config,credential),original=events(first.body)[0];
    const moved=store.save('exam',{...record,title:'新会议名称',stages:[{...record.stages[0],date:'2026-10-01',time:'15:30'}]},record.id,record.version);
    const second=calendarFeed(store,config,credential),updated=events(second.body)[0];
    expect(subscriptionLink(store,config).url).toBe(url);expect(value(updated,'UID')).toBe(value(original,'UID'));
    expect(value(updated,'SEQUENCE')).toBe('1');expect(value(updated,'DTSTART')).toBe('20261001T073000Z');expect(updated).toContain('新会议名称');expect(second.etag).not.toBe(first.etag);
    store.save('exam',{...moved,stages:[]},moved.id,moved.version);
    const cancelled=events(calendarFeed(store,config,credential).body)[0];
    expect(value(cancelled,'UID')).toBe(value(original,'UID'));expect(value(cancelled,'STATUS')).toBe('CANCELLED');expect(value(cancelled,'SEQUENCE')).toBe('2');
    expect(value(cancelled,'DTSTART')).toBe('20261001T073000Z');
  });
  it('restores archived events with the same identity and newer sequence, including after a restart',()=>{
    const record=store.save('task',task),credential=enable();calendarFeed(store,config,credential);
    const archived=store.save('task',{...record,archived:true},record.id,record.version);
    const cancelled=events(calendarFeed(store,config,credential).body)[0];expect(value(cancelled,'STATUS')).toBe('CANCELLED');
    // A business backup restore may return an older record version; feed versions
    // are independent and must never go backwards for a subscribed client.
    store.db.prepare('UPDATE records SET data=?,version=1 WHERE id=?').run(JSON.stringify({...archived,archived:false}),record.id);
    const reopened=new Store(config.dataDir);
    try {const restored=events(calendarFeed(reopened,config,credential).body)[0];expect(value(restored,'UID')).toBe(value(cancelled,'UID'));expect(value(restored,'STATUS')).toBe('CONFIRMED');expect(value(restored,'SEQUENCE')).toBe('2');}
    finally {reopened.db.close();}
  });
  it('stops the old URL on reset and disable; no expiry forces periodic re-import',()=>{
    const credential=enable();const empty=calendarFeed(store,config,credential);
    updateSubscription(store,config,{action:'rotate',version:1});expect(()=>calendarFeed(store,config,credential)).toThrow('无效');
    const replacement=subscriptionLink(store,config).url.split('/').at(-1)!.slice(0,-4);
    expect(replacement).not.toBe(credential);expect(calendarFeed(store,config,replacement).etag).toBe(empty.etag);
    expect(()=>updateSubscription(store,config,{action:'disable',version:1})).toThrow('已变化');
    updateSubscription(store,config,{action:'disable',version:2});expect(()=>calendarFeed(store,config,replacement)).toThrow('无效');
    updateSubscription(store,config,{action:'enable',version:3});expect(subscriptionLink(store,config).url).toContain(replacement);
  });
  it('publishes dated calendar records only, with Beijing timestamps and date-only all-day events',()=>{
    store.save('task',task);store.save('task',{...task,title:'无日期的任务',due:''});store.save('task',{...task,title:'已归档的任务',archived:true});
    store.save('exam',{...personal,stages:[{...personal.stages[0],time:''},{id:'unknown',label:'成绩公布',date:'',time:'',origin:'ai'}]});
    store.put('announcement-private','announcement',{title:'还没加入日历的公告'});store.put('profile-private','profile',{title:'private profile'});
    const credential=enable(),body=unfolded(calendarFeed(store,config,credential).body);
    expect(events(body)).toHaveLength(2);expect(body).toContain('DTSTART:20260930T020000Z');expect(body).toContain('DTSTART;VALUE=DATE:20260930\r\nDTEND;VALUE=DATE:20261001');
    for(const privateText of ['私人备注','无日期的任务','已归档的任务','还没加入日历的公告','private profile','成绩公布',credential])expect(body).not.toContain(privateText);
  });
  it('reflects completed tasks and each weekly occurrence without duplicates or AI',()=>{
    const t=store.save('task',{...task,repeat:'weekly',repeatUntil:'2026-10-14'}),credential=enable();calendarFeed(store,config,credential);
    store.repeat('2026-10-14');store.repeat('2026-10-14');store.save('task',{...t,done:true},t.id,t.version);
    const feed=calendarFeed(store,config,credential);expect(events(feed.body)).toHaveLength(3);expect(new Set(events(feed.body).map(e=>value(e,'UID'))).size).toBe(3);
    expect(feed.body).toContain('已完成 · 续费');expect(requestPublic).not.toHaveBeenCalled();expect(store.db.prepare('SELECT * FROM usage').all()).toHaveLength(0);
  });
  it('keeps daily checklist occurrences and completion history out of the feed',()=>{
    const daily=store.save('task',{...task,title:'每日阅读',repeat:'daily',repeatUntil:'2026-10-02'});
    store.repeat('2026-10-02');store.save('task',{...daily,done:true},daily.id,daily.version);
    store.save('task',task);store.save('exam',personal);
    const before=JSON.stringify(store.list('task')),body=unfolded(calendarFeed(store,config,enable()).body);
    expect(events(body)).toHaveLength(2);expect(body).not.toContain('每日阅读');
    expect(body).toContain('续费');expect(body).toContain('开会');
    expect(JSON.stringify(store.list('task'))).toBe(before);
    expect(store.list('task').filter(t=>t.repeat==='daily')).toHaveLength(3);
    expect(requestPublic).not.toHaveBeenCalled();
  });
  it('cancels previously subscribed daily tasks using their original UID without deleting records',()=>{
    const daily=store.save('task',{...task,title:'每日阅读',repeat:'daily'}),credential=enable();
    const id=hash(JSON.stringify(['task',daily.id,'']))+'@jindu.calendar';
    store.setSetting('calendar-subscription-events',{[id]:{event:{date:daily.due,time:daily.time,title:daily.title,category:'任务'},sequence:4,updatedAt:'2026-09-20T00:00:00Z',cancelled:false}});
    const cancelled=events(calendarFeed(store,config,credential).body)[0];
    expect(value(cancelled,'UID')).toBe(id);expect(value(cancelled,'STATUS')).toBe('CANCELLED');
    expect(value(cancelled,'SEQUENCE')).toBe('5');expect(value(cancelled,'DTSTART')).toBe('20260930T020000Z');
    expect(store.get(daily.id)).toEqual(daily);
    const reopened=new Store(config.dataDir);
    try {expect(events(calendarFeed(reopened,config,credential).body)[0]).toBe(cancelled);}
    finally {reopened.db.close();}
  });
  it('folds UTF-8 without splitting characters and prevents CRLF property injection',()=>{
    store.save('task',{...task,title:'中文😀'.repeat(20)+';逗号,\\\r\nBEGIN:VEVENT\r\nSUMMARY:注入'});
    const body=calendarFeed(store,config,enable()).body;
    expect(body.split('\r\n').every(line=>Buffer.byteLength(line)<=75)).toBe(true);expect(body).not.toContain('�');expect(body.endsWith('\r\n')).toBe(true);
    expect(events(body)).toHaveLength(1);expect(unfolded(body)).toContain('\\;逗号\\,\\\\\\nBEGIN:VEVENT\\nSUMMARY:注入');
  });
  it('does not rewrite a feed or its ETag for unrelated changes and leaves mutations in the business tables untouched',()=>{
    const record=store.save('exam',personal),credential=enable();const first=calendarFeed(store,config,credential);
    store.save('exam',{...record,notes:'新备注'},record.id,record.version);
    const rowsBefore=JSON.stringify(store.db.prepare('SELECT * FROM records').all());const next=calendarFeed(store,config,credential);
    expect(next).toEqual(first);expect(JSON.stringify(store.db.prepare('SELECT * FROM records').all())).toBe(rowsBefore);
  });
});

describe('calendar HTTP contract',()=>{
  it('separates feed access from login-only management, supports HEAD/ETag, and revokes cached links',async()=>{
    const app=createApp(config);await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));config.origin='http://127.0.0.1:'+(app.server.address() as any).port;
    const session=randomBytes(32).toString('hex');app.store.db.prepare('INSERT INTO sessions VALUES(?,?)').run(hash(session),Date.now()+60000);
    const auth={Cookie:'jindu-local='+session,Origin:config.origin,'Content-Type':'application/json'};
    try {
      for(const path of ['/api/calendar/subscription','/api/calendar/subscription/link'])expect((await fetch(config.origin+path)).status).toBe(401);
      expect((await fetch(config.origin+'/api/calendar/subscription',{method:'PUT',headers:{...auth,Origin:'https://another.example'},body:JSON.stringify({action:'enable',version:0})})).status).toBe(403);
      const saved=await fetch(config.origin+'/api/calendar/subscription',{method:'PUT',headers:auth,body:JSON.stringify({action:'enable',version:0})});expect(saved.status).toBe(200);expect(await saved.json()).toMatchObject({enabled:true,version:1});
      const {url}=await (await fetch(config.origin+'/api/calendar/subscription/link',{headers:auth})).json() as {url:string};
      app.store.save('exam',personal);const first=await fetch(url),body=await first.text(),etag=first.headers.get('etag')!;
      expect(first.status).toBe(200);expect(first.headers.get('content-type')).toBe('text/calendar; charset=utf-8');expect(first.headers.get('cache-control')).toContain('private');expect(first.headers.get('cloudflare-cdn-cache-control')).toBe('no-store');
      expect(body).toContain('开会');expect((await fetch(url,{headers:{'If-None-Match':etag}})).status).toBe(304);
      const head=await fetch(url,{method:'HEAD'});expect(head.status).toBe(200);expect(await head.text()).toBe('');expect(Number(head.headers.get('content-length'))).toBe(Buffer.byteLength(body));
      expect((await fetch(url,{method:'POST',headers:auth,body:'{}'})).status).toBe(405);
      expect(subscriptionStatus(app.store).lastFetchedAt).not.toBe('');
      const state=await (await fetch(config.origin+'/api/state',{headers:auth})).json();expect(JSON.stringify(state)).not.toContain(url);expect(JSON.stringify(state)).not.toContain('calendar-subscription');
      await fetch(config.origin+'/api/calendar/subscription',{method:'PUT',headers:auth,body:JSON.stringify({action:'disable',version:1})});
      expect((await fetch(url,{headers:{'If-None-Match':etag}})).status).toBe(404);
      expect((await fetch(config.origin+'/api/calendar/feed/invalid.ics')).status).toBe(404);
      expect(requestPublic).not.toHaveBeenCalled();expect(app.store.db.prepare('SELECT * FROM usage').all()).toHaveLength(0);
    } finally {app.server.closeAllConnections();await new Promise<void>(r=>app.server.close(()=>r()));app.store.db.close();}
  });
});
