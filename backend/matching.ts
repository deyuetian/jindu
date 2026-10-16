import { evaluateEligibility, hasEvidence } from '../shared/eligibility.ts';
import { matchMajor } from '../shared/majors.ts';
import {isProcessItem,isProcessGroup} from '../shared/recruitment-report.ts';
import {publicApplicationItems} from '../shared/application-presentation.ts';

// An Agent's reading of a notice-specific catalogue stays with that job. It
// never edits the profile or standard catalogue and requires both source quotes.
function jobMajor(job:any,profiles:any[],source:string) {
  const normal=matchMajor(job.majorRequirements||[],profiles,source);
  // A workbook cell can say "不限" under an explicit profession heading.
  // Its parser-verified degree scope still applies. Visibility is not eligibility.
  const unrestricted=(job.majorRequirements||[]).filter((r:any)=>r.unrestricted&&r.levels?.length&&/^【专业(?:要求)?】不限$/.test(r.evidence.replace(/\s/g,''))&&hasEvidence(source,r.evidence));
  if(normal.status==='unknown'&&unrestricted.length){
    for(const profile of profiles)for(const e of [...(profile.education||[])].sort((a,b)=>['硕士','本科','博士','专科'].indexOf(a.level)-['硕士','本科','博士','专科'].indexOf(b.level))){
      if(unrestricted.some((r:any)=>r.levels.includes(e.level)))return {status:'unrestricted',profileId:profile.id,level:e.level,reason:'专业符合：岗位不限专业'};
    }
    if(unrestricted.length===(job.majorRequirements||[]).length)return {status:'excluded',profileId:'',level:'',reason:'岗位要求的学历范围与你的学历不符'};
  }
  if(!job.catalogContext||normal.status==='unrestricted')return normal;
  const compact=(text:string)=>text.replace(/\s/g,'');
  const entries=profiles.flatMap(p=>(p.education||[]).map((e:any)=>({profile:p,education:e}))).sort((a,b)=>['硕士','本科','博士','专科'].indexOf(a.education.level)-['硕士','本科','博士','专科'].indexOf(b.education.level));
  const checked=entries.map(({profile,education:e})=>({profile,education:e,check:(job.catalogChecks||[]).find((c:any)=>c.level===e.level&&c.major===e.major&&hasEvidence(source,c.requirementEvidence)&&hasEvidence(source,c.catalogEvidence)&&compact(c.catalogEvidence).includes(compact(e.major))&&(job.majorRequirements||[]).some((r:any)=>hasEvidence(c.requirementEvidence,r.evidence)||hasEvidence(r.evidence,c.requirementEvidence)))}));
  const found=checked.find(v=>v.check?.decision==='matched');
  if(found)return {status:'matched',profileId:found.profile.id,level:found.education.level,reason:`${found.education.level} ${found.education.major}：${found.check.reason}（本次招录专业目录）`};
  if(checked.length&&checked.every(v=>v.check?.decision==='excluded'))return {status:'excluded',profileId:'',level:'',reason:'按本次招录专业目录，你的学历专业不在该岗位范围内'};
  return {status:'unknown',profileId:'',level:'',reason:'需按本次招录专业目录确认你的专业是否在范围内'};
}

/** Calculate the same major verdict without off-screen qualification reports. */
export function matchJobMajor(job:any,profiles:any[],source:string) {
  const active=profiles.filter(p=>!p.archived);
  const requirements=(job.majorRequirements||[]).map((r:any)=>({levels:[],names:[],codes:[],unrestricted:false,evidence:'',...r}));
  const ranking=['专科','本科','硕士','博士'];
  const policy=hasEvidence(source,job.degreePolicy?.evidence||'')?job.degreePolicy?.policy:'unknown';
  const highestRule=policy==='highest'&&/最高学历|最高学位/.test(job.degreePolicy?.evidence||'')&&!/(?:不要求|不强制|无需|非最高)/.test(job.degreePolicy?.evidence||'');
  const candidates=highestRule?active.map(p=>{const top=Math.max(...(p.education||[]).map((e:any)=>ranking.indexOf(e.level)));return {...p,education:(p.education||[]).filter((e:any)=>ranking.indexOf(e.level)===top)};}):active;
  let major=jobMajor({...job,majorRequirements:requirements},candidates,source);
  if(job.analysisQuality?.issues?.some((s:string)=>/专业|学历|匹配分析|重复结果/.test(s))){
    const profile=active.find(p=>p.id===major.profileId)||active.find(p=>p.id===job.profileId)||(active.length===1?active[0]:undefined);
    major={status:'unknown',reason:job.analysisQuality.issues.find((s:string)=>/专业|学历|匹配分析|重复结果/.test(s)),profileId:profile?.id||'',level:''};
  }
  return major;
}

// Re-evaluate saved evidence locally when a profile changes. This deliberately
// does not enqueue an AI request or reinterpret unseen historical announcements.
export function matchJob(job: any, profiles: any[], source: string) {
  const active = profiles.filter(p => !p.archived);
  const requirements=(job.majorRequirements || []).map((r:any)=>({levels:[],names:[],codes:[],unrestricted:false,evidence:'',...r}));
  const ranking=['专科','本科','硕士','博士'];
  const policy=hasEvidence(source,job.degreePolicy?.evidence||'')?job.degreePolicy?.policy:'unknown';
  const ruleText=job.degreePolicy?.evidence||'';
  const highestRule=policy==='highest'&&/最高学历|最高学位/.test(ruleText)&&!/(?:不要求|不强制|无需|非最高)/.test(ruleText);
  const lowerAllowed=policy==='any'&&!/(?:不允许|不得|不能|禁止).{0,20}(?:本科|非最高|较低)/.test(ruleText)&&/非最高学历|非最高学位|任一学历|任一学位|可.{0,15}本科.{0,8}报考|允许.{0,15}本科.{0,8}报考/.test(ruleText);
  let major = matchJobMajor(job,active,source);
  const profile = active.find(p=>p.id===major.profileId)||active.find(p=>p.id===job.profileId)||(active.length===1?active[0]:undefined);
  const profileId = profile?.id || '';
  const profileState = !active.length?'missing':!profile?'selection_required':!profile.education?.length?'education_missing':'ready';
  const quality=job.analysisQuality;
  if(quality?.issues?.some((s:string)=>/专业|学历|匹配分析|重复结果/.test(s)))major={status:'unknown',reason:quality.issues.find((s:string)=>/专业|学历|匹配分析|重复结果/.test(s)),profileId,level:''};
  const applicationItems=publicApplicationItems((job.applicationItems||[]).filter((i:any)=>hasEvidence(source,i.evidence)));
  const groups=[...(job.eligibilityRequirements||[])].filter(g=>!isProcessGroup(g));
  const compact=(text:string)=>text.replace(/\s/g,'');
  for(const item of applicationItems.filter((i:any)=>i.required!==false&&!isProcessItem(i)&&['experience','certificate','other'].includes(i.kind))){
    if(!groups.some(g=>compact(g.evidence).includes(compact(item.evidence))))groups.push({label:item.label,mode:'all',evidence:item.evidence,criteria:[{kind:'other',label:item.label,evidence:item.evidence,accepted:[],levels:[],from:'',to:'',asOf:'',minMonths:0,minCount:1}]});
  }
  const eligibility = evaluateEligibility(groups, profile?.eligibility, source);
  const highest=profile?.education?.reduce((n:number,e:any)=>Math.max(n,ranking.indexOf(e.level)),-1)??-1;
  const lower=!!major.level&&ranking.indexOf(major.level)<highest;
  const lowerUnclear=lower&&!lowerAllowed&&!highestRule;
  const incomplete = !!quality?.issues?.length || !profile || job.analysisIncomplete !== false || job.analysisCurrent===false || job.eligibilityCoverage !== 'complete'||lowerUnclear;
  const negative = major.status === 'excluded' || eligibility.status === 'unmet'||(lower&&highestRule);
  const checked = (!groups.length || eligibility.status === 'met') && !incomplete && ['matched', 'unrestricted'].includes(major.status);
  return {
    profileId, profileState, majorStatus: major.status, majorReason: major.reason,
    matchedLevel:major.level,
    degreeCheck:lower?(highestRule?'公告要求以最高学历报考，此学历路径不适用':lowerAllowed?'公告允许按此学历报考':'本科等较低学历专业匹配；需核对是否允许按该学历报考'):'',
    majorPaths:profile?.education?.map((e:any)=>({...jobMajor({...job,majorRequirements:requirements},[{...profile,education:[e]}],source),level:e.level,major:e.major})).sort((a:any,b:any)=>['硕士','本科','博士','专科'].indexOf(a.level)-['硕士','本科','博士','专科'].indexOf(b.level))||[],
    applicationItems,
    eligibilityChecks: eligibility, eligibilityProfile: profile?.title || '',
    match: negative ? '不符合' : checked ? '符合' : '待核对',
  };
}
