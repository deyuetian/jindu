import {announcementTitle,reviewNotes} from './announcement-presentation.ts';
import {regionName,applicationStatus,majorSummary} from './job-display.ts';
import {jobPlaces,locationText} from './job-location.ts';
import {sourceRows} from './source-position.ts';

export const compactText=(v:unknown)=>String(v||'').replace(/\s+/g,'');
export function applicationKey(item:any){return JSON.stringify([item.kind,compactText(item.evidence),item.required!==false,item.phase||'',item.deadline||'',compactText(item.method)]);}
export function applicationCoveredBy(item:any,common:any[]){
  return common.some(c=>c.kind===item.kind&&(c.required!==false)===(item.required!==false)&&(!item.phase||!c.phase||item.phase===c.phase)&&compactText(item.evidence).length>=8&&compactText(c.evidence).includes(compactText(item.evidence))&&(!item.deadline||!c.deadline||item.deadline===c.deadline));
}
export function criterionKey(c:any){return JSON.stringify([c.kind,compactText(c.evidence),c.accepted||[],c.levels||[],c.from||'',c.to||'',c.asOf||'',c.minMonths||0,c.minCount||1]);}
export function eligibilityKey(g:any){return JSON.stringify([g.mode,compactText(g.evidence),(g.criteria||g.items||[]).map(criterionKey).sort()]);}
export function uniqueBy<T>(values:T[],key:(value:T)=>string):T[]{const seen=new Set<string>();return values.filter(v=>{const k=key(v);if(seen.has(k))return false;seen.add(k);return true;});}
export function isProcessItem(item:any){
  if(['material','procedure'].includes(item.kind))return true;
  // Older results occasionally placed contact details and declarations in "other".
  return item.kind==='other'&&/联系电话|联系方式|资料真实性|信息真实性|审核周期|盖章.*周期/.test(item.label||'');
}
export function isProcessGroup(group:any){
  const criteria=group.criteria||group.items||[];
  return criteria.length>0&&criteria.every((c:any)=>c.kind==='other'&&isProcessItem({...c,kind:'other'}));
}
export function userFacingNote(value:string){
  return value.replace(/freshGraduateYear/g,'应届毕业年份').replace(/degreePolicy/g,'报考学历规则')
    .replace(/个人档案|用户(?:的)?档案|你的档案/g,'你的个人条件').replace(/用户/g,'你')
    .replace(/(?:本部分|本段|当前提供的|当前图片)(?:中)?/g,'').replace(/正文明确/g,'公告注明')
    .replace(/(?:只能保留为|为|是)\s*(?:unknown|partial|待核对)/g,'尚待确认').trim();
}

/** Format source-backed identity without replacing the stored name or application history. */
export function jobPresentation(job:any,announcement?:any,source=''){
  const row=job.sourceRow;
  const cells=job.sourcePosition?.fields||(row?sourceRows(source).get(row.sheet+'\0'+row.row):[])||[];
  const field=(label:string)=>cells.find((f:any)=>new RegExp(`^(?:${label})$`).test(f.header.replace(/\s/g,'')))?.value?.trim()||'';
  const original=field('岗位名称|职位名称')||job.title||'';
  const local=original.match(/^(.{2,8}?)(市直)岗位\s*(\d+)$/);
  const city=local?(local[1].endsWith('市')?local[1]:local[1]+'市'):'';
  const provinces='北京|天津|河北|山西|内蒙古|辽宁|吉林|黑龙江|上海|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|重庆|四川|贵州|云南|西藏|陕西|甘肃|青海|宁夏|新疆';
  const province=(announcement?.title||'').match(new RegExp(`(${provinces})(?:省|市|自治区)?`))?.[1];
  const region=locationText(jobPlaces(job,announcement))||regionName(job.sourcePosition?.location||job.province);
  const sourceCode=row?row.positionCode||'':job.positionCode||'';
  return {
    displayTitle:local?`${city} · ${local[2]}岗位 ${local[3]}`:original,
    displayOrganization:field('单位名称|招录机关|招聘单位|用人单位|部门名称')||field('单位层级')||(local?local[2]+'单位':job.organization||''),
    displayRegion:regionName(region),displayPositionCode:sourceCode,sourceSerial:field('序号'),
    applicationStatus:applicationStatus(job),majorSummary:majorSummary(job),
    sourceAnnouncementTitle:announcement?announcementTitle(announcement):'',
  };
}

/** Resolve only demonstrated cross-part absences. Genuine missing evidence stays visible. */
export function consolidatedNotes({values,files=[],results=[],jobs=[],dates=[],issues=[]}:{values:string[];files?:any[];results?:any[];jobs?:any[];dates?:any[];issues?:string[]}){
  const readable=files.filter(f=>f.text&&!f.error&&results.some(r=>compactText(r._source).includes(compactText(f.text))||String(r._source||'').includes(f.id)));
  const source=results.map(r=>r._source||'').join('\n');
  const common=results.filter(r=>!r._table).flatMap(r=>r.commonEligibility||[]);
  const items=results.flatMap(r=>r.applicationItems||[]);
  const allNotes:string[]=[...issues];
  for(const raw of values||[]){
    if(!raw||/^正文或附件分段分析/.test(raw))continue;
    const scoped=/本部分|本段|仅为|仅提供文档第|图片(?:附件|中|未|仅)|当前图片/.test(raw);
    if(/未读|尚未读|不能.*读取|无法.*读取/.test(raw)){
      const named=readable.some(f=>{const stem=f.name.replace(/\.(docx?|pdf|xlsx?)(?:\.[a-z]+)?$/i,'');return stem.length>5&&raw.includes(stem);});
      const scopeResolved=/高校范围|高校名单|选调范围/.test(raw)&&readable.some(f=>/选调范围|高校名单/.test(f.name))&&common.some(g=>/高校/.test(g.label));
      const formResolved=/推荐登记表/.test(raw)&&readable.some(f=>/推荐登记表/.test(f.name));
      if(named||scopeResolved||formResolved)continue;
    }
    if(/最高学历|非最高学历|报考学历|学历使用政策/.test(raw)&&/未说明|未明确|未规定|未提供|未知|不明确|unknown|无法确认|无法确定/.test(raw)){
      if(!results.some(r=>r.degreePolicy?.policy&&r.degreePolicy.policy!=='unknown'))allNotes.push('如需用非最高学历报考，请先确认招聘方是否接受。');
      continue;
    }
    if(/freshGraduateYear|应届(?:毕业)?年份|应届年份/.test(raw)&&/未填|为空|未提供/.test(raw)){allNotes.push('请在个人条件中补充应届毕业年份，以核对招聘届别。');continue;}
    if(/未说明|未提供|没有提供/.test(raw)&&/报名.*(?:起止|截止)|报名截止/.test(raw)&&!/(?:图片|二维码)/.test(raw)){
      if(!dates.some(d=>/报名.*(?:截止|结束)/.test(d.label||'')))allNotes.push('报名截止日期待确认。');
      continue;
    }
    if(/未提供.*岗位.*专业要求/.test(raw)&&jobs.some(j=>j.majorRequirements?.length)&&!/(缺少|未读).*附件/.test(raw))continue;
    if(scoped&&/未提供|未出现|没有|无法核对/.test(raw)&&/通用|公告正文|其他资格/.test(raw)&&common.length)continue;
    if(scoped&&/岗位表|岗位名称|岗位代码|专业范围/.test(raw)&&/没有|未提供/.test(raw)&&jobs.length)continue;
    if(/没有专业限制或专业目录信息|图片中没有.*岗位表/.test(raw)){if(!jobs.length)allNotes.push('具体岗位与专业要求需另行确认。');continue;}
    if(/表格列有.*填写项.*未说明.*资格条件/.test(raw))continue;
    if(/图片.*二维码.*(?:截止日期|截止时间)/.test(raw)){allNotes.push('校内扫码登记的截止时间和具体要求需要确认。');continue;}
    if(/图片.*(?:登记|扫码).*是否属于.*报名程序/.test(raw)){allNotes.push('校内登记与官方报名是否为同一流程，需向学校确认。');continue;}
    if(/(?:正文|公告)未列明报名阶段需要提交的具体材料/.test(raw)){allNotes.push('报名材料清单待确认。');continue;}
    if(/未提供报名材料|未说明.*提交(?:阶段|方式)|签章.*无法确定/.test(raw)&&items.some(i=>isProcessItem(i)&&/报名|上传|签章|盖章/.test(i.evidence))){
      if(scoped||/未提供报名材料/.test(raw)||/签章/.test(raw))continue;
    }
    // Preferences are already shown alongside the role, not as unresolved eligibility.
    if(/属于优先条件|不作为专业淘汰门槛/.test(raw))continue;
    if(/除.*(?:简历|联系方式).*未说明其他报名材料/.test(raw)&&items.some(i=>i.kind==='material'))continue;
    if(/(?:若|如果).*(?:必要资格|要求)/.test(raw)&&/获奖|经历|证书|学生干部/.test(raw)&&!common.some(g=>(g.criteria||[]).some((c:any)=>['award','leadership','certificate','experience'].includes(c.kind))))continue;
    if(scoped&&/仅提供文档第\d/.test(raw)&&source)continue;
    allNotes.push(userFacingNote(raw));
  }
  return uniqueBy(reviewNotes(allNotes),v=>compactText(v).replace(/[，。；：、]/g,''));
}
