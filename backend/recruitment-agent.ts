import { analyze } from './ai.ts';
import { fetchOfficial, officialURL } from './agent-sources.ts';
import {recruitmentReader} from './recruitment-reader.ts';
import type { Store } from './db.ts';
import type { Config } from './config.ts';
import { hash } from './config.ts';
import {announcementReport} from './announcement-report.ts';
import {announcementTitle} from '../shared/announcement-presentation.ts';
import {jobPresentation,isProcessItem,applicationKey,applicationCoveredBy,uniqueBy} from '../shared/recruitment-report.ts';

type Plan={intent:string;query:string;terms:string[];announcementId?:string};
type Reply={reply:string;reportAnnouncementId?:string;pending?:boolean};
export async function recruitmentTurn(store:Store,config:Config,turn:any,plan:Plan):Promise<Reply> {
  const text=turn.text as string;
  const words=[...new Set([plan.query,...plan.terms].filter(Boolean))];
  const all=store.list('announcement');
  let id=store.getSetting<string>('recruitment-target:'+turn.id,'');
  const normalize=(s:string)=>s.replace(/\s+/g,'');
  const candidates=all.filter(a=>words.some(w=>[a.title,announcementTitle(a)].some(title=>normalize(title).includes(normalize(w))||normalize(w).includes(normalize(title)))));
  if(!id&&plan.announcementId){
    const named=all.find(a=>a.id===plan.announcementId);
    if(named&&(text.includes(named.title)||candidates.length===1&&candidates[0].id===named.id))id=named.id;
  }
  const urls=[...text.matchAll(/https?:\/\/[^\s<>，。；）)]+/g)].map(m=>m[0]);
  if(!id&&urls.length===1){const linked=all.find(a=>a.url===urls[0]);if(linked)id=linked.id;}
  if(!id&&plan.intent==='recruitment_search'&&candidates.length===1)id=candidates[0].id;
  if(plan.intent==='recruitment_analyze'&&!id){
    if(urls.length>1)return {reply:'请一次指定一个公告链接，我会把该公告和岗位表一起筛选。'};
    if(urls.length===1){
      if(!officialURL(urls[0]))return {reply:'请提供学校就业网或官方招考页面链接；也可以指定已收集公告的完整标题。'};
      await fetchOfficial(store,config,urls[0],20);
      id='official:'+hash(urls[0]).slice(0,32);
    }else if(candidates.length===1)id=candidates[0].id;
    else return {reply:candidates.length?'找到多个公告，请指定完整标题：\n'+candidates.slice(0,8).map(a=>'• '+a.title).join('\n'):'没有找到对应公告。请提供完整标题或官方公告链接，我会读取正文及附件筛岗。'};
    store.setSetting('recruitment-target:'+turn.id,id);
  }
  if(id)store.setSetting('recruitment-target:'+turn.id,id);
  if(plan.intent==='recruitment_analyze') {
    const ann=store.get(id);if(!ann||ann.kind!=='announcement')return {reply:'该公告已不可用，请重新指定。'};
    if(store.get(turn.id)?.done)return {reply:'本次请求已取消。'};
    if(await analyze(store,config,id,1,'recruitment')===false)return {reply:'正在逐段核对公告与岗位要求，结果会保留在此。',pending:true};
  }
  const reader=recruitmentReader(store);
  const items=store.list('job').filter(j=>!j.archived&&j.analysisCurrent!==false&&(id?j.announcementId===id:!words.length||words.some(w=>(j.title+' '+j.organization+' '+(store.get(j.announcementId)?.title||'')).includes(w)))).map(j=>reader.job(reader.get(j.id)||j));
  items.sort((a,b)=>['符合','待核对','不符合'].indexOf(a.match)-['符合','待核对','不符合'].indexOf(b.match)||(['硕士','本科','博士','专科'].indexOf(a.matchedLevel)-['硕士','本科','博士','专科'].indexOf(b.matchedLevel)));
  const report=id?announcementReport(store,store.get(id)):null,warnings=report?.uncertainties||[];
  const title=report?announcementTitle(report):'你的岗位候选';
  const summary=items.length?`${title}\n专业符合 ${items.filter(j=>['matched','unrestricted'].includes(j.majorStatus)).length} 个；全部已核查条件满足 ${items.filter(j=>j.match==='符合').length} 个；资格待补充或核对 ${items.filter(j=>j.match==='待核对').length} 个。`:title;
  const common=report?.applicationProcess||[];
  const commonEvidence=new Set(common.map((i:any)=>applicationKey(i)));
  const result=items.filter(j=>j.match!=='不符合').slice(0,12).map(j=>{
    const missing=j.eligibilityChecks.groups.flatMap((g:any)=>g.items.filter((c:any)=>c.status!=='met').map((c:any)=>c.label));
    const materials=uniqueBy(j.applicationItems.filter((i:any)=>isProcessItem(i)&&!commonEvidence.has(applicationKey(i))&&!applicationCoveredBy(i,common)),applicationKey).map((i:any)=>i.label);
    return [`• ${j.displayPositionCode?'['+j.displayPositionCode+'] ':''}${j.displayTitle} — ${j.match}`,`  ${j.displayOrganization} · ${j.displayRegion}`,!id&&`  来源：${j.sourceAnnouncementTitle}`,`  专业要求：${j.majorSummary}`,j.degreeCheck&&`  ${j.degreeCheck}`,missing.length&&`  还需核对：${[...new Set(missing)].slice(0,6).join('；')}`,materials.length&&`  此岗位申请要求：${materials.slice(0,8).join('；')}`].filter(Boolean).join('\n');
  });
  const qualification=report?.commonEligibilityChecks?.groups||[];
  return {reply:[summary,qualification.length?'通用资格：'+qualification.map((g:any)=>g.label).join('；'):'',...result,!items.length?(report?.sourceNeedsRefresh?'网页岗位明细尚未补齐，请更新此公告后再筛选。':qualification.length?'本公告尚未单列可筛选岗位，可先核对通用报考资格。':'暂未找到可核对的岗位，请补充对应公告或岗位表。'):!result.length?'目前的候选岗位都有不满足的条件，可在岗位详情查看具体要求。':'',common.length?'申请流程与材料：\n'+common.map((i:any)=>'• '+i.label+(i.detail?'：'+i.detail:'')).join('\n'):'',warnings.length?'还需确认：\n'+warnings.slice(0,6).map((s:string)=>'• '+s).join('\n'):'',items.length>12?'其余岗位可在岗位页查看。':''].filter(Boolean).join('\n\n').slice(0,15000),reportAnnouncementId:id||undefined};
}
