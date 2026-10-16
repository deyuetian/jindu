// Isolated smoke test: no source URLs to connect to and no persistent data.
import assert from 'node:assert/strict';
import {gatherSources, localSources} from '../../backend/agent-sources.ts';
import {cauCalendarURL} from '../../backend/cau-calendar-source.ts';

const id='a'.repeat(32), url=`https://scc.cau.edu.cn/frontpage/cau/html/newsDetail.html?id=${id}`;
const item={id:'cau:'+id,kind:'announcement',title:'2027 湖北选调',url,body:'公告正文',fileIds:['large-attachment']};
const store={list:()=>[],get:()=>item,db:{prepare:()=>{throw new Error('Calendar source selection must not read attachment storage');}}};
const empty=await gatherSources(store,{},'找不到的考试',['找不到'],[]);
assert.deepEqual(empty.docs,[]);assert.deepEqual(empty.warnings,[]);
assert.equal(cauCalendarURL(url),url);
assert.equal(cauCalendarURL('https://example.gov.cn/notice'),'');
assert.equal(cauCalendarURL('https://scc.cau.edu.cn/file.doc'),'');
const linked=localSources(store,[],{announcementId:item.id});
assert.equal(linked.length,1);assert.equal(linked[0].text,'公告正文');
await assert.rejects(gatherSources(store,{},'',[],['https://example.gov.cn/notice']),/只支持农大公告正文/);
console.log(JSON.stringify({passed:true,calendarCauBodyOnly:true,unmatchedRequestDoesNotSearch:true,attachmentStorageNotRead:true,externalAICalls:0,businessWrites:false}));
