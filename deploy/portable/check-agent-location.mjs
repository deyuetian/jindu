import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../backend/db.ts';
import {schemas} from '../../backend/model.ts';
import {manageRecruitmentRequest,undoRecruitmentManagement} from '../../backend/agent-management.ts';
import {repairSavedRequest} from './repair-agent-request.ts';

const title='四川省面向中国农业大学选调2027届优秀大学毕业生公告';
let checks=0;
for(const text of ['将四川选调从日历和AI助手里也删除','将四川选调从日历里删除','将四川选调从日历以及AI助手中删除',
  '不要将四川选调从日历和AI助手里删除','将四川选调从日历和AI助手里删除聊天记录','将四川选调从日历里删除和湖北选调的关注']){
  const store=new Store(mkdtempSync(join(tmpdir(),'jindu-agent-location-')));
  try{
    store.put('synthetic-sichuan','announcement',{title});
    store.put('synthetic-calendar','exam',schemas.exam.parse({title,url:'https://example.test/announcement',announcementId:'synthetic-sichuan',type:'选调',stages:[
      {id:'a',label:'网上报名开始',date:'2026-10-01',time:'09:00',origin:'ai'},
      {id:'b',label:'报名开始',date:'2026-10-01',time:'09:00',origin:'ai'},
    ],tracking:{enabled:false,query:title}}));
    store.put('other','exam',schemas.exam.parse({title:'湖北省2027年选调公告',url:'https://example.test/other',stages:[],type:'选调',tracking:{enabled:true,query:'湖北选调'}}));
    const original=store.get('synthetic-calendar'),other=store.get('other');let result;
    assert.equal(manageRecruitmentRequest(store,text,value=>{result=value;}),true);
    if(checks<3){
      assert.equal(store.get(original.id).archived,true);
      assert.ok(result.reply.includes('1 个有日期的节点')&&result.reply.includes('已选考试'));
      store.transaction(()=>assert.equal(undoRecruitmentManagement(store,result.before),true));
      assert.equal(store.get(original.id).archived,false);
      assert.deepEqual(store.get(original.id).stages,original.stages);
    }else{assert.deepEqual(store.get(original.id),original);assert.ok(!result.before);}
    assert.deepEqual(store.get('other'),other);checks++;
    if(checks===1){
      const current=store.get(original.id);
      const fixed={receiptId:'repair:synthetic-sichuan',text,announcementId:'synthetic-sichuan',expected:[{id:current.id,kind:'exam',version:current.version}]};
      assert.equal(repairSavedRequest(store,fixed).status,'completed');
      assert.equal(repairSavedRequest(store,fixed).status,'already-completed');
      assert.equal(store.get(current.id).archived,true);
      assert.equal(store.get(fixed.receiptId).actionVersion,current.version+1);
    }
  }finally{store.db.close();}
}
console.log(JSON.stringify({ok:true,checks,syntheticRepair:true,aiCalls:0,productionWrites:0}));
