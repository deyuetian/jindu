import {z} from 'zod';
import {hasEvidence} from './eligibility.ts';

const fact=z.object({text:z.string().max(300),evidence:z.string().max(1200)});
export const introductionSchema=z.object({organization:fact.optional(),year:fact.optional(),audience:fact.optional(),education:fact.optional(),majors:fact.optional(),positions:fact.optional(),locations:fact.optional(),application:fact.optional()}).default({});
const keys=['organization','year','audience','education','majors','positions','locations','application'] as const;
const analysisLanguage=/(?:本人|个人条件|个人档案|用户|你的|我的|最高学历|专业目录|目录(?:显示|明确|将)|归入|归属|所属.*类|按.*核对|专业(?:均)?不符|专业匹配|岗位表第|省直岗位第|第\s*\d+\s*[—－至/-]?\s*\d*\s*(?:行|号|部分)|\d+\s*个岗位(?:均|分别)|本部分|本段|已核对|已提取|未提供|未读取|未读到|未明确|未说明|无法|不能据此|因此仅|表面匹配|仍待核对|需手动核对)/;
const campusLanguage=/盖章|公章|签章|智能印章|自助机|校内登记|就业创业办公室|学校党委组织部/;
const referencePart=(r:any)=>!!r._table||!!r._imageId||/专业(?:指导)?目录|专业对照|盖章|印章|校内办理/.test(r._partName||'');
const safeFact=(value:unknown)=>typeof value==='string'&&value.trim()&&!analysisLanguage.test(value)&&!campusLanguage.test(value)?value.trim():'';
const shortText=(s:string,limit:number)=>s.length<=limit?s:s.slice(0,limit-1)+'…';

export function introductionFields(item:any,compact=true):Record<string,string>{
  const fields:Record<string,string>={};
  for(const key of keys){const value=safeFact(item.introduction?.[key]);if(value)fields[key]=compact?shortText(value,key==='positions'||key==='application'?120:100):value;}
  if(fields.year&&!/^20\d{2}$/.test(fields.year))delete fields.year;
  return fields;
}

export function mergeIntroduction(results:any[]){
  const fields:Record<string,string>={};
  const general=results.filter(r=>!referencePart(r)).sort((a,b)=>Number(b._partName==='公告正文')-Number(a._partName==='公告正文'));
  for(const result of general)for(const key of keys){
    const value=result.introduction?.[key];
    if(!fields[key]&&safeFact(value?.text)&&hasEvidence(result._source||'',value.evidence)&&value.evidence.replace(/\s/g,'').includes(value.text.replace(/\s/g,'')))fields[key]=value.text.trim();
  }
  if(fields.year&&!/^20\d{2}$/.test(fields.year))delete fields.year;
  return fields;
}
function recruitmentLabel(title:string){return /校园招聘|校招/.test(title)?'校园招聘':/实习/.test(title)?'实习招聘':/社会招聘|社招/.test(title)?'社会招聘':/招聘/.test(title)?'招聘':'';}
export function announcementTitle(item:any){
  const original=String(item.title||'');
  if(item.type==='选调'||/选调/.test(original))return original;
  if(item.displayTitle)return item.displayTitle;
  const intro=item.introduction||{},label=recruitmentLabel(original)||recruitmentLabel(item.summary||'');
  if(!label)return original;
  const match=(original.match(/^(.{2,90}?)(20\d{2})(?:年度|年|届)/)||String(item.summary||'').match(/^(.{2,90}?)(20\d{2})(?:年度|年|届)/));
  const org=match?.[1]?.replace(/^[【\[].*?[】\]]\s*/,'').trim()||intro.organization,year=match?.[2]||intro.year;
  if(!org||!year||/[。！？；]/.test(org))return original;
  return `${org}${year}年度${label}`;
}
export function cleanIntroduction(summary:string){
  const sentences=(summary||'').replace(/正文明确面向/g,'面向').replace(/正文(?:中)?列(?:出|明)/g,'招聘').replace(/(?:公告|正文)显示[，：:]?/g,'').split(/(?<=[。！？])|\n+/u)
    .map(s=>s.trim()).filter(s=>s&&!analysisLanguage.test(s)&&!campusLanguage.test(s));
  let result='';const seen=new Set<string>();
  for(const sentence of sentences){const key=sentence.replace(/[\s，。；：]/g,'');if(seen.has(key))continue;seen.add(key);if(result.length+sentence.length>260){if(!result)result=shortText(sentence,260);break;}result+=sentence;}
  return result;
}
export function mergedSummary(results:any[]){return cleanIntroduction(results.filter(r=>!referencePart(r)).map(r=>r.summary||'').join('\n'));}

export function overviewFacts(item:any){
  const f=introductionFields(item,false),facts:{key:string;label:string;text:string}[]=[];
  for(const [key,label] of [['audience','面向对象'],['education','学历要求'],['positions','招聘方向'],['locations','工作地点'],['majors','专业范围'],['application','报名安排']]){
    let value=f[key];if(!value)continue;
    value=value.replace(/^(?:面向|招聘对象[：:]?|学历要求[：:]?|招聘岗位[：:]?|工作地点[：:]?|专业要求[：:]?|需求专业[：:]?|报名安排[：:]?)\s*/,'');
    if(key==='positions'&&/^招聘岗位\s*[（(]/.test(f[key]))continue;
    if(key==='education'&&f.audience?.includes(value))continue;
    if(value)facts.push({key,label,text:value.replace(/[；。]+$/,'')});
  }
  return facts;
}
export function announcementIntroduction(item:any){
  const f=introductionFields(item);
  if(!Object.values(f).some(Boolean))return cleanIntroduction(item.summary||'');
  const first=announcementTitle(item),parts=[first];
  if(f.audience)parts.push(`面向${f.audience.replace(/^(?:面向|招聘对象[：:]?)\s*/, '')}`);
  if(f.education)parts.push(`学历要求：${f.education.replace(/^学历要求[：:]?\s*/, '')}`);
  if(f.majors)parts.push(`专业要求：${f.majors.replace(/^(?:专业要求|需求专业)[：:]?\s*/, '')}`);
  if(f.positions&&!/^招聘岗位\s*[（(]/.test(f.positions))parts.push(`招聘岗位：${f.positions.replace(/^招聘岗位[：:]?\s*/, '')}`);
  if(f.locations)parts.push(`工作地点：${f.locations.replace(/^工作地点[：:]?\s*/, '')}`);
  if(f.application)parts.push(`报名安排：${f.application.replace(/^报名安排[：:]?\s*/, '')}`);
  return shortText(parts.join('；').replace(/[；。]+$/,'')+'。',300);
}
export function reviewNotes(values:string[]=[]){
  return [...new Set(values.filter(v=>v&&!/^正文或附件分段分析/.test(v)).map(v=>v.replace(/(?:为|是)unknown\b/g,'尚待确认').replace(/\bunknown\b/g,'待核对').replace(/本部分|当前提供的/g,'').replace(/个人档案未提供/g,'请补充').trim()))];
}
