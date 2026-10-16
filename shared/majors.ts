// Verified initial catalogue entries. Unknown entries remain editable and require
// an explicit catalogue/source; codes from different education systems are not mixed.
export const majorCatalogue=[
  {levels:['本科'],major:'土地资源管理',code:'120404',discipline:'管理学',disciplineCode:'12',category:'公共管理类',categoryCode:'1204',catalog:'普通高等学校本科专业目录（2026年）',catalogUrl:'https://www.moe.gov.cn/srcsite/A08/moe_1034/s3882/202604/t20260427_1434931.html'},
  {levels:['本科'],major:'城市管理',code:'120405',discipline:'管理学',disciplineCode:'12',category:'公共管理类',categoryCode:'1204',catalog:'普通高等学校本科专业目录（2026年）',catalogUrl:'https://www.moe.gov.cn/srcsite/A08/moe_1034/s3882/202604/t20260427_1434931.html'},
  {levels:['硕士','博士'],major:'土壤学',code:'090301',discipline:'农学',disciplineCode:'09',category:'农业资源与环境',categoryCode:'0903',catalog:'中国农业大学学术学位学科专业目录（2025年4月）',catalogUrl:'https://gradsch1.cau.edu.cn/art/2025/4/9/art_40279_1062390.html'},
];
export function majorHierarchy(education:any) {
  const known=majorCatalogue.find(c=>c.levels.includes(education.level)&&c.major===education.major?.trim());
  if(known&&education.code&&education.code.trim()!==known.code)return {...education,verified:false,warning:`${education.level}“${known.major}”目录编码为 ${known.code}，当前 ${education.code} 需核对。`};
  if(known)return {...education,...known,code:known.code,verified:true,warning:''};
  const verified=!!(education.hierarchyConfirmed&&education.catalog&&education.catalogUrl&&education.category&&education.categoryCode);
  return {...education,verified,warning:verified?'':'该专业的上级类别尚未核对，请补充目录和层级；不会仅凭编码前缀推断。'};
}
export type MajorRequirement={levels:string[];names:string[];codes:string[];unrestricted:boolean;evidence:string;catalog:string};
import {evidenceContains} from './evidence.ts';
export function matchMajor(requirements:MajorRequirement[],profiles:any[],source:string) {
  const normalize=(s:string)=>s.replace(/\s/g,'');
  const valid=requirements.filter(r=>r.evidence.length>=4&&evidenceContains(source,normalize(r.evidence)));
  const unknown={status:'unknown',reason:'专业要求或对应目录缺少可核对证据',profileId:'',level:''};
  profiles=profiles.filter(p=>!p.archived);
  if(!valid.length||!profiles.some(p=>p.education?.length))return unknown;
  // Combined degree requirements need all clauses checked, not the first match.
  if(valid.some(r=>new Set(r.evidence.match(/专科|本科|硕士|博士/g)||[]).size>1&&/(?:且|同时|均须|均需|均应|均为|均符合|均要求)/.test(r.evidence)))return {...unknown,reason:'岗位同时限制多段学历的专业，需核对每一项条件'};
  let unresolved=false;
  const preferred=['硕士','本科','博士','专科'];
  for(const profile of profiles)for(const entry of [...(profile.education||[])].sort((a,b)=>preferred.indexOf(a.level)-preferred.indexOf(b.level))) {
    const e=majorHierarchy(entry);
    for(const r of valid) {
      const stated=[...new Set(r.evidence.match(/专科|本科|硕士|博士/g)||[])];
      if((!r.levels.length&&stated.length)||stated.length===1&&r.levels.some(l=>l!==stated[0])||/相关专业|相近专业/.test(r.evidence)){unresolved=true;continue;}
      if(r.levels.length&&!r.levels.includes(entry.level))continue;
      if(r.catalog&&(/本科/.test(r.catalog)&&['硕士','博士'].includes(entry.level)||/研究生|硕士|博士/.test(r.catalog)&&entry.level==='本科')){unresolved=true;continue;}
      if(r.unrestricted&&/不限专业|专业不限|不限制专业/.test(r.evidence)) {
        if(/不含|不包括|不接收|不招收|排除|除外|但(?:须|限|要求)/.test(r.evidence)){unresolved=true;continue;}
        return {status:'unrestricted',reason:'专业符合：岗位不限专业',profileId:profile.id,level:entry.level};
      }
      const names=[entry.major,...(e.verified?[e.category,e.discipline]:[])].filter(Boolean);
      const codes=e.verified?[e.code,e.categoryCode,e.disciplineCode].filter(Boolean):[];
      const named=r.names.find(n=>names.includes(n)&&normalize(r.evidence).includes(normalize(n)));
      const coded=r.codes.find(c=>codes.includes(c)&&new RegExp(`(^|[^0-9A-Za-z])${c}([^0-9A-Za-z]|$)`).test(r.evidence));
      if(named||coded) {
        const excluded=[...names,...codes].some(n=>{
          const escaped=n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
          return new RegExp(`(?:不含|不包括|不接收|不招收|排除)\\s*${escaped}|${escaped}\\s*(?:专业)?(?:除外|不在范围内|不符合)`).test(r.evidence);
        });
        if(excluded)continue;
        if(/不含|不包括|不接收|不招收|排除|除外/.test(r.evidence)){unresolved=true;continue;}
        if(e.warning&&entry.code){unresolved=true;continue;}
        // Province-specific catalogues can redefine categories; require their exact mapping.
        if(r.catalog&&r.catalog!==e.catalog&&!/教育部|普通高等学校本科专业目录|研究生教育学科专业目录|中国农业大学学术学位/.test(r.catalog)&&named!==entry.major&&coded!==entry.code){unresolved=true;continue;}
        return {status:'matched',reason:`${entry.level} ${entry.major} → ${named||coded}（${e.catalog||'原文明确列出专业'}）`,profileId:profile.id,level:entry.level};
      }
      if(!e.verified||(!r.names.length&&!r.codes.length)||/相关专业|相近专业|等专业/.test(r.evidence))unresolved=true;
    }
  }
  return unresolved?unknown:{status:'excluded',reason:'原文所列专业或对应学历范围未包含档案中的专业',profileId:'',level:''};
}
