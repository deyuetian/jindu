import { analysisSchema,AppError,nextDate } from './model.ts';
import { dateSchema } from '../shared/model.ts';
import { hasEvidence } from '../shared/eligibility.ts';

const degreeNames:Record<string,string>={'大学专科':'专科','大学本科':'本科','硕士研究生':'硕士','博士研究生':'博士'};
function degrees(value:unknown):unknown {
  if(!Array.isArray(value))return value;
  const order=['专科','本科','硕士','博士'];
  return [...new Set(value.flatMap(v=>{
    if(typeof v!=='string')return [v];
    const above=v.match(/^(专科|大学专科|本科|大学本科|硕士|硕士研究生|博士|博士研究生)及以上$/);
    if(above)return order.slice(order.indexOf(degreeNames[above[1]]||above[1]));
    return [degreeNames[v]||v];
  }))];
}

export class AIOutputError extends AppError {
  code:'truncated'|'empty'|'format';
  repairHint:string;
  constructor(code:'truncated'|'empty'|'format',message:string,repairHint='') {super(502,message);this.code=code;this.repairHint=repairHint;}
}

/** Accept a single unambiguous JSON object, including common Markdown/prose envelopes.
 * Never repair broken syntax, execute text, choose between objects, or invent values. */
export function modelObject(text:string):any {
  const clean=text.trim().replace(/^\uFEFF/,'');
  let direct:any;
  try{direct=JSON.parse(clean);}catch{}
  if(direct&&typeof direct==='object'&&!Array.isArray(direct))return direct;
  // A few compatible gateways double-encode the assistant's JSON content.
  if(typeof direct==='string')try{const inner=JSON.parse(direct);if(inner&&typeof inner==='object'&&!Array.isArray(inner))return inner;}catch{}
  if(direct!==undefined)throw invalidJSON();
  const candidates:string[]=[];let start=-1,stack:string[]=[],quoted=false,escaped=false;
  for(let i=0;i<clean.length;i++){
    const ch=clean[i];
    if(start<0){if(ch==='{'||ch==='['){start=i;stack=[ch];}continue;}
    if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
    if(ch==='"'){quoted=true;continue;}
    if(ch==='{'||ch==='[')stack.push(ch);
    if(ch==='}'||ch===']'){
      if(stack.pop()!==(ch==='}'?'{':'['))throw invalidJSON();
      if(!stack.length){candidates.push(clean.slice(start,i+1));start=-1;}
    }
  }
  if(start!==-1||candidates.length!==1)throw invalidJSON();
  try{const value=JSON.parse(candidates[0]);if(value&&typeof value==='object'&&!Array.isArray(value))return value;}catch{}
  throw invalidJSON();
}
function invalidJSON(){return new AIOutputError('format','模型返回的内容不是唯一完整的 JSON 对象，已保留分析进度','返回一个完整 JSON 对象，不要 Markdown、前后说明或不完整代码。');}
export function modelText(data:any):string {
  const content=data?.choices?.[0]?.message?.content;
  if(typeof content==='string')return content;
  if(Array.isArray(content)&&content.length&&content.every(p=>p&&['text','output_text'].includes(p.type)&&typeof p.text==='string'))return content.map(p=>p.text).join('');
  return '';
}
function canonicalDate(value:unknown):unknown {
  if(typeof value!=='string')return value;
  const text=value.trim();
  const match=text.match(/^(\d{4})(?:年|[-/.])(\d{1,2})(?:月|[-/.])(\d{1,2})日?$/);
  if(!match)return text;
  const date=`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`;
  return dateSchema.safeParse(date).success?date:text;
}
function canonicalTime(value:unknown):unknown {
  if(typeof value!=='string')return value;
  const text=value.trim(),match=text.match(/^(\d{1,2})[:：](\d{2})$/);
  return match?`${match[1].padStart(2,'0')}:${match[2]}`:text;
}
function normalizeGroups(groups:any){
  if(!Array.isArray(groups))return;
  for(const group of groups)if(Array.isArray(group?.criteria))for(const criterion of group.criteria){
    if(!criterion||typeof criterion!=='object')continue;
    for(const key of ['from','to','asOf'])if(key in criterion)criterion[key]=canonicalDate(criterion[key]);
    for(const key of ['minMonths','minCount'])if(typeof criterion[key]==='string'&&/^\d+$/.test(criterion[key].trim()))criterion[key]=Number(criterion[key]);
  }
}
function normalizeApplications(items:any){
  if(Array.isArray(items))for(const item of items)if(item&&typeof item==='object'&&'deadline' in item)item.deadline=canonicalDate(item.deadline);
}
export function parseAnalysis(text:string) {
  const value=modelObject(text);
  // Normalize only equivalent, explicit formats. Invalid or incomplete dates
  // remain validation failures: never erase a condition to make a job match.
  if(Array.isArray(value.dates))for(const stage of value.dates){
    if(!stage||typeof stage!=='object')continue;
    stage.date=canonicalDate(stage.date);stage.time=canonicalTime(stage.time);
    if(stage.time==='24:00'&&dateSchema.safeParse(stage.date).success){stage.date=nextDate(stage.date,1);stage.time='00:00';}
  }
  normalizeGroups(value.commonEligibility);normalizeApplications(value.applicationItems);
  if(Array.isArray(value.jobs))for(const job of value.jobs){
    normalizeGroups(job?.eligibilityRequirements);normalizeApplications(job?.applicationItems);
    if(Array.isArray(job?.majorRequirements))for(const requirement of job.majorRequirements)if(requirement&&typeof requirement==='object')requirement.levels=degrees(requirement.levels);
    if(Array.isArray(job?.catalogChecks))for(const check of job.catalogChecks)if(check&&typeof check==='object')check.level=degreeNames[check.level]||check.level;
  }
  const parsed=analysisSchema.safeParse(value);
  if(parsed.success)return parsed.data;
  const hints=parsed.error.issues.slice(0,8).map(issue=>`${issue.path.join('.')||'根对象'}: ${issue.message}`).join('\n').slice(0,1800);
  const paths=parsed.error.issues.slice(0,4).map(issue=>issue.path.join('.')||'根对象').join('、');
  throw new AIOutputError('format',`模型结果字段不完整（${paths}），已保留分析进度`,hints);
}

export function normalizeAnalysisEvidence<T>(value:T,source:string):T {
  // Some providers prepend a table-row citation to a shortened quotation. Strip
  // only that prefix and only when the remaining quotation really is verbatim.
  // Canonical row identity is supplied by the workbook parser, never this label.
  const visit=(node:any)=>{
    if(!node||typeof node!=='object')return;
    for(const [key,entry] of Object.entries(node)){
      if(/evidence$/i.test(key)&&typeof entry==='string'&&!hasEvidence(source,entry)){
        const quote=entry.replace(/^\[[^\]\r\n]{1,120}\]\s*(?=【)/,'');
        if(quote!==entry&&hasEvidence(source,quote))node[key]=quote;
      }else if(typeof entry==='object')visit(entry);
    }
  };
  visit(value);return value;
}
