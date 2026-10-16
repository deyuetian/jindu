import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {mkdirSync, mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../backend/db.ts';
import {gatherSources} from '../backend/agent-sources.ts';
import {cauCalendarURL, readCauCalendarNotice} from '../backend/cau-calendar-source.ts';
import {followExam} from '../backend/agent.ts';
import {requestPublic} from '../backend/net.ts';
import {callAI} from '../backend/ai.ts';
import {saveFile} from '../backend/files.ts';
import type {Config} from '../backend/config.ts';

vi.mock('../backend/net.ts', async original=>({...await original<typeof import('../backend/net.ts')>(), requestPublic:vi.fn()}));
vi.mock('../backend/ai.ts', ()=>({callAI:vi.fn()}));
vi.mock('../backend/files.ts', ()=>({saveFile:vi.fn()}));
const id='a'.repeat(32), origin='https://scc.cau.edu.cn';
const url=`${origin}/frontpage/cau/html/newsDetail.html?id=${id}`;
const title='2027 湖北定向选调公告';
let store:Store, config:Config;
function response(content='<p>2027 湖北选调，报名截止时间为2026年10月24日18:00。</p>') {
  return {status:200,headers:{},url:`${origin}/f/newsCenter/ajax_view?id=${id}`,body:Buffer.from(JSON.stringify({state:1,object:{article:{id,title,createDate:'2026-09-20 09:00:00',articleData:{content}}}}))};
}
function announcement() { return store.put('cau:'+id,'announcement',{title,url,body:'旧正文',published:'2026-09-20',fileIds:['attachment']}); }
function exam() {
  announcement();
  return store.put('exam:test','exam',{title,type:'选调',province:'湖北',url,calendarKind:'exam',announcementId:'cau:'+id,archived:false,notes:'保留备注',stages:[{id:'manual',label:'报名截止',date:'2026-10-25',time:'12:00',milestone:'registration_end',origin:'manual',manualEdited:true}],tracking:{enabled:true,passed:false,query:title,sources:[url,'https://example.gov.cn/old.pdf'],checkedAt:'2026-09-23T01:00:00Z',fingerprint:'old',error:'搜索页面未返回可用结果'}});
}
const gather=(e?:any,explicit:string[]=[])=>gatherSources(store,config,title,['湖北','2027'],explicit,e);
beforeEach(()=>{
  mkdirSync('.check/tests',{recursive:true});store=new Store(mkdtempSync(resolve('.check/tests/cau-follow-')));
  config={dataDir:store.dir} as Config;
  vi.mocked(requestPublic).mockReset().mockResolvedValue(response());vi.mocked(callAI).mockReset();vi.mocked(saveFile).mockReset();
});
afterEach(()=>store.db.close());

describe('CAU announcement-body calendar checks',()=>{
  it('uses the content endpoint once, strips markup, and never saves or reads attachments',async()=>{
    const e=exam();const before=store.get(e.id);
    vi.mocked(requestPublic).mockResolvedValue(response('<script>bad()</script><p>报名时间：2026年10月24日&nbsp;18:00</p><a href="https://other.example/file.pdf">附件</a>'));
    const result=await gather(e);
    expect(result.docs).toHaveLength(1);expect(result.docs[0]).toMatchObject({id:'cau:'+id,url,title,text:'报名时间：2026年10月24日 18:00 附件'});
    expect(requestPublic).toHaveBeenCalledExactlyOnceWith(`${origin}/f/newsCenter/ajax_view?id=${id}`,expect.objectContaining({method:'GET',redirects:0}));
    expect(saveFile).not.toHaveBeenCalled();expect(callAI).not.toHaveBeenCalled();expect(store.get(e.id)).toEqual(before);
    expect(store.list('announcement')).toHaveLength(1);expect(result.warnings).toEqual([]);
  });
  it('ignores long stored attachments and outside tracking sources',async()=>{
    const e=exam();store.db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?)').run('attachment','cau:'+id,'岗位表.xlsx','https://other.example/jobs.xlsx','text/plain',200000,'fixture','附件'.repeat(100000),'');
    const first=await gather(e);store.db.prepare('UPDATE files SET text=?').run('附件新内容');const second=await gather(e);
    expect(first.fingerprint).toBe(second.fingerprint);expect(first.docs[0].text.length).toBeLessThan(200);expect(first.warnings).toEqual([]);
    expect(vi.mocked(requestPublic).mock.calls.every(([address])=>address.startsWith(origin+'/f/newsCenter/'))).toBe(true);
  });
  it('does not substitute cached text or clear a prior successful check when fresh reading fails',async()=>{
    const e=exam();const before=store.get(e.id);vi.mocked(requestPublic).mockRejectedValue(new Error('timeout'));
    const sources=await gather(e);expect(sources.docs).toEqual([]);expect(sources.warnings.join()).toContain('暂时无法读取');
    await expect(followExam(store,config,e.id)).rejects.toThrow('未读到农大公告正文');
    expect(store.get(e.id)).toEqual(before);expect(callAI).not.toHaveBeenCalled();
  });
  it('clears obsolete search warnings after an unchanged body is successfully checked, without AI or stage changes',async()=>{
    const e=exam(),sources=await gather(e);store.put(e.id,'exam',{...e,tracking:{...e.tracking,fingerprint:sources.fingerprint}},e.version);
    const before=store.get(e.id);await followExam(store,config,e.id);const after=store.get(e.id);
    expect(after.tracking.error).toBe('');expect(after.tracking.checkedAt).not.toBe(before.tracking.checkedAt);
    expect(after.stages).toEqual(before.stages);expect(after.notes).toBe(before.notes);expect(callAI).not.toHaveBeenCalled();
  });
  it('fingerprints changed body text, rather than volatile views or attachments',async()=>{
    const e=exam();const first=await gather(e);vi.mocked(requestPublic).mockResolvedValue(response('<p>2027 湖北选调，报名截止时间更正为2026年10月26日18:00。</p>'));
    expect((await gather(e)).fingerprint).not.toBe(first.fingerprint);
  });
  it('retains manual milestones when changed announcement dates are extracted',async()=>{
    const e=exam();vi.mocked(callAI).mockResolvedValue(JSON.stringify({matched:true,title,type:'选调',province:'湖北',clarification:'',stages:[{milestone:'registration_end',date:'2026-10-24',time:'18:00',evidence:'报名截止时间为2026年10月24日18:00',sourceId:'cau:'+id}]}));
    await followExam(store,config,e.id);expect(callAI).toHaveBeenCalledTimes(1);
    expect(store.get(e.id).stages.find((s:any)=>s.id==='manual')).toMatchObject({date:'2026-10-25',time:'12:00',manualEdited:true});
    expect(store.list('agent_turn').some(t=>t.reply.includes('已保留你的内容'))).toBe(true);
  });
  it('finds a collected CAU notice for a new request and fetches its current body',async()=>{
    announcement();store.put('outside','announcement',{title,body:'外站旧正文',url:'https://example.gov.cn/notice'});
    const result=await gather();expect(result.docs).toHaveLength(1);expect(result.docs[0].text).not.toBe('旧正文');expect(requestPublic).toHaveBeenCalledTimes(1);
  });
  it('accepts a supplied CAU URL, canonicalizes and deduplicates it against the bound notice',async()=>{
    const e=exam();const result=await gather(e,[url+'&from=calendar#date']);expect(result.docs).toHaveLength(1);expect(requestPublic).toHaveBeenCalledTimes(1);
  });
  it('does not search when no matching announcement exists',async()=>{
    const result=await gather();expect(result.docs).toEqual([]);expect(requestPublic).not.toHaveBeenCalled();
  });
  it('rejects outside sites, attachment links, credentials and ambiguous article IDs before connecting',async()=>{
    const invalid=['https://cn.bing.com/search?q=exam','https://example.gov.cn/notice',origin+'/file.doc',url.replace('scc.cau.edu.cn','scc.cau.edu.cn.example.com'),url.replace('https://','https://user:pass@'),url+'&id='+'b'.repeat(32)];
    for(const address of invalid){expect(cauCalendarURL(address)).toBe('');await expect(gather(undefined,[address])).rejects.toThrow('只支持农大公告正文');}
    expect(requestPublic).not.toHaveBeenCalled();
  });
  it('rejects a withdrawn announcement without treating it as an empty successful update',async()=>{
    const e=exam();vi.mocked(requestPublic).mockResolvedValue({...response(),body:Buffer.from(JSON.stringify({state:0,msg:'文章不存在'}))});
    const result=await gather(e);expect(result.docs).toEqual([]);expect(result.warnings.join()).toContain('可能已撤回');
  });
  it.each(['<html>页面外壳</html>',JSON.stringify({state:1,object:{article:{id,title,articleData:{content:''}}}}),JSON.stringify({state:1,object:{article:{id:'b'.repeat(32),title,articleData:{content:'错误公告'}}}})])('rejects malformed, empty or mismatched announcement data',async body=>{
    vi.mocked(requestPublic).mockResolvedValue({...response(),body:Buffer.from(body)});await expect(readCauCalendarNotice(url)).rejects.toThrow();
  });
  it('refuses oversized bodies instead of silently truncating date evidence',async()=>{
    const e=exam();vi.mocked(requestPublic).mockResolvedValue(response('<p>'+'正文'.repeat(50001)+'</p>'));
    await expect(gather(e)).rejects.toThrow('正文过长');expect(callAI).not.toHaveBeenCalled();expect(store.get(e.id)).toEqual(e);
  });
  it('retains every complete body when differently sized announcements fit the total limit',async()=>{
    const secondId='b'.repeat(32),secondURL=url.replace(id,secondId);
    vi.mocked(requestPublic).mockResolvedValueOnce(response('<p>'+'文'.repeat(60000)+'</p>'))
      .mockResolvedValueOnce({...response(),body:Buffer.from(JSON.stringify({state:1,object:{article:{id:secondId,title,articleData:{content:'<p>'+'字'.repeat(500)+'</p>'}}}}))});
    const result=await gather(undefined,[url,secondURL]);expect(result.docs.map(d=>d.text.length)).toEqual([60000,500]);expect(result.warnings).toEqual([]);
  });
  it('reads recruitment announcement content without attached files or separate position records',async()=>{
    const address=`${origin}/frontpage/cau/html/recruitmentinfoForm.html?positionDetailId=${id}`;
    vi.mocked(requestPublic).mockResolvedValue({...response(),body:Buffer.from(JSON.stringify({state:1,object:{recruitmentinfo:{id,title,content:'<p>公告正文</p>',recruitmentPositionList:[{positionDescription:'不能纳入的岗位明细'}],linkUrl:'https://other.example'}}}))});
    expect((await readCauCalendarNotice(address)).text).toBe('公告正文');
    expect(requestPublic).toHaveBeenCalledExactlyOnceWith(origin+'/f/recruitmentinfo/ajax_show',expect.objectContaining({method:'POST',body:'recruitmentId='+id,redirects:0}));
  });
});
