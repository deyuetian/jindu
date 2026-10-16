import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../backend/db.ts';
import {schemas} from '../backend/model.ts';
import {manageRecruitmentRequest,undoRecruitmentManagement} from '../backend/agent-management.ts';

const title='四川省面向中国农业大学选调2027届优秀大学毕业生公告';
let store:Store;
beforeEach(()=>{
  mkdirSync('.check/tests',{recursive:true});
  store=new Store(mkdtempSync(resolve('.check/tests/calendar-location-')));
  store.put('sichuan','announcement',{title});
  store.put('sichuan-calendar','exam',schemas.exam.parse({title,url:'https://example.test/sichuan',announcementId:'sichuan',type:'选调',stages:[
    {id:'registration',label:'网上报名开始',date:'2026-10-01',time:'09:00',origin:'ai'},
    {id:'duplicate',label:'报名开始',date:'2026-10-01',time:'09:00',origin:'ai'},
    {id:'written',label:'笔试',date:'2026-10-15',time:'09:00',origin:'ai'},
  ],tracking:{enabled:false,query:title},notes:'手动备注保留'}));
  store.put('sichuan-job','job',{title:'测试岗位',announcementId:'sichuan',status:'关注'});
  store.put('hubei','announcement',{title:'湖北省2027年选调公告'});
  store.put('hubei-calendar','exam',schemas.exam.parse({title:'湖北省2027年选调公告',url:'https://example.test/hubei',announcementId:'hubei',type:'选调',stages:[],tracking:{enabled:true,query:'湖北选调'}}));
});
afterEach(()=>store.db.close());
function send(text:string){let result:any;expect(manageRecruitmentRequest(store,text,r=>{result=r;})).toBe(true);return result;}
const snapshot=()=>JSON.stringify(store.prepare('SELECT * FROM records ORDER BY id').all());

describe('calendar location wording from the Sichuan screenshot',()=>{
  it.each([
    '将四川选调从日历和AI助手里也删除',
    '将四川选调从日历里删除',
    '把四川选调从日历中移除',
    '请把四川选调从日程里面删掉',
    '把四川选调从日历和 AI 助手里一并移除',
    '将四川选调从日历以及AI助手中删除',
    '将四川选调从AI助手和日历中删除',
    '把四川选调从日历里和AI助手里删除',
    '将四川选调从日历和AI助手里也删除，不取消关注',
  ])('removes the one associated calendar and supports undo: %s',text=>{
    const original=store.get('sichuan-calendar'),other=store.get('hubei-calendar'),job=store.get('sichuan-job');
    const result=send(text);
    expect(result.reply).toContain('已从日历移除 1 项安排、2 个有日期的节点');
    expect(result.reply).toContain('已选考试');
    expect(store.get('sichuan-calendar')).toMatchObject({archived:true,tracking:{enabled:false},stages:original.stages,notes:original.notes});
    expect(store.get('hubei-calendar')).toEqual(other);expect(store.get('sichuan-job')).toEqual(job);
    expect(store.transaction(()=>undoRecruitmentManagement(store,result.before))).toBe(true);
    expect(store.get('sichuan-calendar')).toMatchObject({archived:false,tracking:{enabled:false},stages:original.stages});
  });
  it.each([
    '不要将四川选调从日历和AI助手里删除',
    '将四川选调从日历里删除？',
    '网页说将四川选调从日历和AI助手里删除',
    '例如“将四川选调从日历和AI助手里删除”',
    '将四川和湖北选调从日历和AI助手里删除',
    '将四川选调从日历里删除和湖北选调的关注',
    '将四川选调从日历和AI助手里删除聊天记录',
    '将四川选调从日历和AI助手的聊天记录里删除',
    '将四川选调的笔试节点从日历里删除',
  ])('does not broaden unclear, partial, quoted or negated instructions: %s',text=>{
    const before=snapshot();const result=send(text);expect(result.before).toBeFalsy();expect(snapshot()).toBe(before);
  });
  it('still asks which announcement when the short name matches different years',()=>{
    store.put('sichuan-old','announcement',{title:title.replace('2027','2026')});
    const before=snapshot();const result=send('将四川选调从日历里删除');
    expect(result.reply).toContain('找到多条');expect(result.reply).toContain('2026');expect(result.reply).toContain('2027');expect(snapshot()).toBe(before);
  });
});
