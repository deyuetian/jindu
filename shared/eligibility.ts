import { z } from 'zod';
import { dateSchema, todayCN } from './model.ts';
import {evidenceContains} from './evidence.ts';

const date = dateSchema.or(z.literal(''));
export const politicalOptions = ['中共党员', '中共预备党员', '共青团员', '群众', '其他'] as const;
export const genderOptions = ['男', '女'] as const;
export const awardLevels = ['院级', '校级', '市级', '省部级', '国家级', '其他'] as const;
export const roleScopes = ['班级', '院系', '学校', '党团支部', '其他'] as const;
const recordStatus = z.enum(['unknown', 'partial', 'complete', 'none']).default('unknown');
export const eligibilityFactsSchema = z.object({
  gender: z.enum(genderOptions).or(z.literal('')).default(''),
  birthday: date.default(''), politicalStatus: z.enum(politicalOptions).or(z.literal('')).default(''),
  politicalSince: date.default(''), freshGraduate: z.enum(['yes', 'no', 'unknown']).default('unknown'),
  freshGraduateYear: z.string().regex(/^$|^\d{4}$/).default(''),
  awardsStatus: recordStatus, rolesStatus: recordStatus,
  experiencesStatus: recordStatus, certificatesStatus: recordStatus,
  experiences:z.array(z.object({name:z.string().trim().min(1).max(150),type:z.enum(['工作','实习','科研','项目']),organization:z.string().max(150).default(''),start:date.default(''),end:date.default('')}).refine(r=>!r.start||!r.end||r.start<=r.end,'经历结束日期不能早于开始日期')).max(50).default([]),
  certificates:z.array(z.object({name:z.string().trim().min(1).max(150),date:date.default(''),expires:date.default('')}).refine(r=>!r.date||!r.expires||r.date<=r.expires,'证书到期日不能早于取得日期')).max(50).default([]),
  awards: z.array(z.object({ name: z.string().trim().min(1).max(150), level: z.enum(awardLevels).or(z.literal('')).default(''), date: date.default(''), issuer: z.string().max(150).default('') })).max(50).default([]),
  roles: z.array(z.object({ name: z.string().trim().min(1).max(150), scope: z.enum(roleScopes).or(z.literal('')).default(''), organization: z.string().max(150).default(''), start: date.default(''), end: date.default('') }).refine(r => !r.start || !r.end || r.start <= r.end, '任职结束日期不能早于开始日期')).max(50).default([]),
}).refine(v => v.awardsStatus !== 'none' || !v.awards.length, '已有奖励记录时不能选择无奖励')
  .refine(v => v.rolesStatus !== 'none' || !v.roles.length, '已有任职记录时不能选择无任职经历')
  .refine(v=>v.experiencesStatus!=='none'||!v.experiences.length,'已有经历时不能选择无经历')
  .refine(v=>v.certificatesStatus!=='none'||!v.certificates.length,'已有证书时不能选择无证书');

// Only explicit, evidenced requirements are mechanically compared. Unsupported
// clauses remain reviewable, rather than becoming an AI-generated positive verdict.
export const criterionSchema = z.object({
  kind: z.enum(['gender', 'political', 'award', 'leadership', 'birthDate', 'freshGraduate', 'experience', 'certificate', 'other']),
  label: z.string().min(1).max(350), evidence: z.string().max(1600),
  accepted: z.array(z.string().max(150)).max(20).default([]),
  levels: z.array(z.string().max(40)).max(10).default([]),
  from: date.default(''), to: date.default(''), asOf: date.default(''),
  minMonths: z.number().int().min(0).max(600).default(0),
  minCount: z.number().int().min(1).max(50).default(1),
});
export const eligibilityGroupSchema = z.object({
  label: z.string().min(1).max(350), mode: z.enum(['all', 'any']),
  evidence: z.string().max(2400), criteria: z.array(criterionSchema).min(1).max(15),
});
export const eligibilityGroupsSchema = z.array(eligibilityGroupSchema).max(30).default([]);
export type Criterion = z.infer<typeof criterionSchema>;
export type EligibilityGroup = z.infer<typeof eligibilityGroupSchema>;
export type Verdict = 'met' | 'unmet' | 'missing' | 'review';
export type Check = { label: string; evidence: string; status: Verdict; actual: string; reason: string };
export const verdictLabels: Record<Verdict, string> = { met: '满足', unmet: '不满足', missing: '待补充', review: '待核对' };
const compact = (v: string) => v.replace(/\s/g, '');
export function hasEvidence(source: string, quote: string) { const normalized=compact(quote);return normalized.length >= 4 && evidenceContains(source,normalized); }
export function validGroups(groups: EligibilityGroup[], source: string) {
  return groups.every(g => hasEvidence(source, g.evidence) && g.criteria.every(c => hasEvidence(g.evidence, c.evidence)));
}
const matches = (value: string, names: string[]) => names.includes(value.trim());
function combine(statuses: Verdict[], mode: 'all' | 'any'): Verdict {
  if (!statuses.length) return 'review';
  if (mode === 'any' && statuses.includes('met')) return 'met';
  if (mode === 'all' && statuses.includes('unmet')) return 'unmet';
  if (statuses.includes('review')) return 'review';
  if (statuses.includes('missing')) return 'missing';
  return mode === 'all' ? 'met' : 'unmet';
}
function monthsBetween(start: string, end: string) {
  const s = new Date(start + 'T00:00:00Z'), e = new Date(end + 'T00:00:00Z');
  return (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + e.getUTCMonth() - s.getUTCMonth() - (e.getUTCDate() < s.getUTCDate() ? 1 : 0);
}
/** Recognize only a self-contained hard requirement, never a preference or a
 * combined clause with exceptions. Also handles previously saved `other` facts. */
export function genderRequirement(evidence: string): readonly string[] | null {
  const text = evidence.replace(/\s/g, '').replace(/[。；;，,]$/, '');
  if (/^(?:(?:【性别(?:要求)?】|性别(?:要求)?[:：]?)(?:不限|男女不限|男女均可)|男女不限|男女均可|不限性别|性别不限)$/.test(text)) return genderOptions;
  const match = text.match(/^(?:(?:【性别(?:要求)?】|性别(?:要求)?[:：]?|(?:只|仅)?限|限招|仅招|要求|须为|必须为))*(男|女)(?:性|生)?(?:报考|报名|应聘)?$/);
  return match ? [match[1]] : null;
}
function checkCriterion(c: Criterion, facts: any, today: string): Check {
  const result = (status: Verdict, actual: string, reason = ''): Check => ({ label: c.label, evidence: c.evidence, status, actual, reason });
  const genders = c.kind === 'gender' || c.kind === 'other' ? genderRequirement(c.evidence) : null;
  if (c.kind === 'gender' || c.kind === 'other' && genders) {
    if (!genders || c.kind === 'gender' && (c.accepted.length !== genders.length || new Set(c.accepted).size !== c.accepted.length || c.accepted.some(v => !genders.includes(v)))) return result('review', facts?.gender || '未填写', '性别要求与原文需核对');
    if (genders.length === 2) return result('met', facts?.gender || '未填写', '公告未限制性别');
    if (!facts?.gender) return result('missing', '未填写性别');
    if (!genderOptions.includes(facts.gender)) return result('review', '性别待核对');
    return result(genders.includes(facts.gender) ? 'met' : 'unmet', facts.gender);
  }
  if (!facts) return result('missing', '尚未填写个人条件');
  if (c.kind === 'political') {
    if (!c.accepted.length || c.accepted.some(v => !politicalOptions.includes(v as any))) return result('review', facts.politicalStatus || '未填写', '政治身份范围需核对');
    if (!facts.politicalStatus) return result('missing', '未填写政治面貌');
    if (facts.politicalSince > today) return result('review', facts.politicalStatus, '取得身份的日期尚未到达');
    if (!matches(facts.politicalStatus, c.accepted)) return result('unmet', facts.politicalStatus);
    if (c.asOf && !facts.politicalSince) return result('missing', facts.politicalStatus, '补充取得当前政治身份的日期');
    if (c.asOf && facts.politicalSince > c.asOf) return result('unmet', `${facts.politicalStatus} · ${facts.politicalSince}`);
    return result('met', `${facts.politicalStatus}${facts.politicalSince ? ' · ' + facts.politicalSince : ''}`);
  }
  if (c.kind === 'birthDate') {
    if (!c.from && !c.to) return result('review', facts.birthday || '未填写', '年龄边界未明确');
    if (!facts.birthday) return result('missing', '未填写出生日期');
    return result((c.from && facts.birthday < c.from) || (c.to && facts.birthday > c.to) ? 'unmet' : 'met', facts.birthday);
  }
  if (c.kind === 'freshGraduate') {
    if (facts.freshGraduate === 'unknown' || !facts.freshGraduate) return result('missing', '未填写应届身份');
    if (c.accepted.length !== 1 || !/^\d{4}$/.test(c.accepted[0])) return result('review', facts.freshGraduate === 'yes' ? '应届' : '非应届', '应届认定口径需核对');
    if (facts.freshGraduate === 'no') return result('unmet', '非应届');
    if (!facts.freshGraduateYear) return result('missing', '应届年份未填写');
    return result(c.accepted[0] === facts.freshGraduateYear ? 'met' : 'unmet', facts.freshGraduateYear + ' 届应届');
  }
  if(c.kind==='experience'||c.kind==='certificate') {
    const exp=c.kind==='experience',records=facts[exp?'experiences':'certificates']||[],status=facts[exp?'experiencesStatus':'certificatesStatus'];
    const actual=records.map((r:any)=>r.name+(exp?' · '+r.type:'')+(r.start?' · '+r.start+' 至 '+(r.end||'至今'):'')).join('；');
    if(!c.accepted.length)return result('review',actual,'名称或认定口径需核对');
    if(status==='none')return result('unmet',exp?'无相关经历':'无证书');
    if(!records.length)return result('missing',exp?'未填写工作或实习经历':'未填写证书');
    if(exp&&c.levels.some(v=>!['工作','实习','科研','项目'].includes(v)))return result('review',actual,'经历类别需核对');
    if(exp&&c.minMonths&&!c.asOf)return result('review',actual,'经历年限缺少核算截止日');
    if(!exp&&c.levels.length)return result('review',actual,'证书等级需要进一步核对');
    let count=0,incomplete=false;
    for(const r of records){
      if(!c.accepted.includes(r.name)||exp&&c.levels.length&&!c.levels.includes(r.type))continue;
      if(exp){
        if(!r.start){incomplete=true;continue;}
        if(r.start>today){incomplete=true;continue;}
        const start=[r.start,c.from||r.start].sort().at(-1)!,end=[r.end||today,c.asOf||today,c.to||today,today].sort()[0];
        if(end<start)continue;
        if(c.minMonths&&monthsBetween(start,end)<c.minMonths){if(c.asOf>today&&(!r.end||r.end>today))incomplete=true;continue;}
      }else{
        if(!r.date){incomplete=true;continue;}
        const cutoff=c.asOf||today;
        if(r.date>today){incomplete=true;continue;}
        if(r.date>cutoff||c.from&&r.date<c.from||c.to&&r.date>c.to||r.expires&&r.expires<cutoff)continue;
      }
      count++;
    }
    if(count>=c.minCount)return result('met',actual);
    if(incomplete||status!=='complete')return result('missing',actual,'补全记录及日期');
    if(records.some((r:any)=>!c.accepted.includes(r.name)))return result('review',actual,'名称或经历认定范围需核对');
    return result('unmet',actual);
  }
  if (c.kind === 'award' || c.kind === 'leadership') {
    const award = c.kind === 'award', records = (award ? facts.awards : facts.roles) || [], status = facts[award ? 'awardsStatus' : 'rolesStatus'];
    const noun = award ? '奖项' : '任职经历';
    if (!c.accepted.length && !c.levels.length) return result('review', records.map((r: any) => r.name).join('、') || '未填写', '需明确可接受的名称或范围');
    const vocabulary: readonly string[] = award ? awardLevels : roleScopes;
    if (c.levels.some(v => !vocabulary.includes(v))) return result('review', '范围待核对');
    if (status === 'none') return result('unmet', '无' + noun);
    if (!records.length) return result('missing', '未填写' + noun);
    let matched = 0, incomplete = false;
    for (const r of records) {
      if (c.accepted.length && !matches(r.name, c.accepted)) continue;
      const level = award ? r.level : r.scope;
      if (c.levels.length && !level) { incomplete = true; continue; }
      if (c.levels.length && !c.levels.includes(level)) continue;
      if (award) {
        if (r.date > today) { incomplete = true; continue; }
        if ((c.from || c.to || c.asOf) && !r.date) { incomplete = true; continue; }
        const until = c.to || c.asOf;
        if (c.from && r.date < c.from || until && r.date > until) continue;
      } else {
        if (r.start > today) { incomplete = true; continue; }
        if (c.minMonths && !c.asOf) return result('review', records.map((r: any) => r.name).join('、'), '任职时长缺少核算截止日');
        if ((c.asOf || c.from || c.to || c.minMonths) && !r.start) { incomplete = true; continue; }
        if (c.asOf && r.start > c.asOf) continue;
        // Do not credit a future appointment period or combine unrelated posts.
        let end = [r.end || today, c.asOf || today, today].sort()[0];
        const start = c.from && c.from > r.start ? c.from : r.start;
        if (c.to && end > c.to) end = c.to;
        if (start && end < start) continue;
        if (c.minMonths && monthsBetween(start, end) < c.minMonths) { if (c.asOf > today && (!r.end || r.end > today)) incomplete = true; continue; }
      }
      matched++;
    }
    const actual = records.map((r: any) => `${r.name}${(award ? r.level : r.scope) ? ' · ' + (award ? r.level : r.scope) : ''}${award ? r.date ? ' · ' + r.date : '' : r.start ? ' · ' + r.start + ' 至 ' + (r.end || '至今') : ''}`).join('；');
    if (matched >= c.minCount) return result('met', actual);
    if (incomplete || status !== 'complete') return result('missing', actual, '补全相关记录、级别和日期');
    // Exact names can be compared, but a different label may be an official equivalent.
    if (c.accepted.length && records.some((r: any) => !matches(r.name, c.accepted))) return result('review', actual, '名称不同，需核对公告认定范围');
    return result('unmet', actual);
  }
  return result('review', '这项条件需要你确认');
}
export function evaluateEligibility(groups: EligibilityGroup[], facts: any, source: string, today = todayCN()) {
  const checks = groups.map(group => {
    const verified = validGroups([group], source);
    const items = group.criteria.map(c => verified ? checkCriterion(c, facts, today) : { label: c.label, evidence: c.evidence, status: 'review' as Verdict, actual: '', reason: '原文依据尚未验证' });
    return { label: group.label, mode: group.mode, evidence: group.evidence, status: combine(items.map(c => c.status), group.mode), items };
  });
  return { status: combine(checks.map(c => c.status), 'all'), groups: checks };
}
