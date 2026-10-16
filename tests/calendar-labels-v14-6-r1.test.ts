import {afterEach,beforeEach,describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../backend/db.ts';
import {listRecords} from '../backend/listings.ts';
import {addJobCalendar} from '../backend/job-actions.ts';

let store:Store;
beforeEach(()=>{mkdirSync('.check/quality-v14-6-r1/tests',{recursive:true});store=new Store(mkdtempSync(resolve('.check/quality-v14-6-r1/tests/calendar-')));});
afterEach(()=>store.db.close());
const list=(status='全部')=>listRecords(store,'announcement',new URLSearchParams({status}));
function notice(id:string,status='pending'){
 return store.put(id,'announcement',{title:id+'选调公告',type:'选调',province:'北京市',status,published:'2026-09-23',candidates:[{id:'print',label:'准考证打印开始',date:'2026-10-14',time:'10:00'}]});
}
describe('announcement calendar labels reflect linked records',()=>{
 it('finds calendars added by jobs or an assistant, without treating a status flag or personal schedule as an import',()=>{
  notice('jobs');notice('assistant');notice('stale','accepted');notice('personal');
  store.put('job','job',{title:'岗位',announcementId:'jobs',type:'选调'});
  const plan=store.get('jobs')!;
  addJobCalendar(store,'job',{version:plan.version,stageIds:['candidate:0'],follow:false});
  store.put('exam:agent:unique','exam',{title:'助理建立的日历',announcementId:'assistant',calendarKind:'exam',stages:[]});
  store.put('exam:personal','exam',{title:'个人备忘',announcementId:'personal',calendarKind:'personal',stages:[]});
  const items=new Map(list().items.map(a=>[a.id,a.calendarStatus]));
  expect(items.get('jobs')).toBe('added');expect(items.get('assistant')).toBe('added');expect(items.get('stale')).toBe('');
  expect(list('已加入日历').items.map(a=>a.id).sort()).toEqual(['assistant','jobs']);
 });
 it('updates labels after archive and restore, while a remaining active linked calendar takes precedence',()=>{
  notice('linked');store.put('exam:linked','exam',{title:'旧日历',archived:true,stages:[]});
  expect(list().items[0].calendarStatus).toBe('archived');
  expect(list('已加入日历').total).toBe(0);
  const exam=store.get('exam:linked')!;
  store.put(exam.id,'exam',{...exam,archived:false},exam.version);
  expect(list().items[0].calendarStatus).toBe('added');
  store.put('another','exam',{title:'历史日历',announcementId:'linked',archived:true,stages:[]});
  expect(list().items[0].calendarStatus).toBe('added');
 });
});
