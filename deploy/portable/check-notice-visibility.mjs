import {strict as assert} from 'node:assert';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../backend/db.ts';
import {listRecords} from '../../backend/listings.ts';
import {announcementReport} from '../../backend/announcement-report.ts';
const store=new Store(mkdtempSync(join(tmpdir(),'jindu-notice-visibility-')));
try{
  for(const [id,province,state] of [['ah','安徽省','error'],['hlj','黑龙江省','retry']]){
    const a=store.put(id,'announcement',{title:province+'2027年度定向选调应届优秀大学毕业生公告',type:'其他',province:'',analysisStatus:state,status:'pending',body:'原文',fileIds:[],candidates:[],published:'2026-10-09'});
    const result=listRecords(store,'announcement',new URLSearchParams({province,type:'选调'}));
    assert.equal(result.total,1);assert.equal(result.items[0].id,id);assert.equal(result.items[0].analysisStatus,state);
    assert.equal(announcementReport(store,a).province,province);assert.equal(store.get(id).province,'');
  }
  assert.equal(store.prepare('SELECT COUNT(*) n FROM ai_requests').get().n,0);
  console.log('Collected notices remain visible in province/type filters without AI or record rewrites.');
}finally{store.db.close();}
