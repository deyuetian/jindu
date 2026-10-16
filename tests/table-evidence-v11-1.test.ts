import {describe,expect,it} from 'vitest';
import {normalizeTableEvidence} from '../backend/table-evidence.ts';
import {matchJob} from '../backend/matching.ts';
import {hasEvidence} from '../shared/eligibility.ts';
import {majorHierarchy} from '../shared/majors.ts';

const profile={id:'profile',education:[{level:'硕士',major:'土壤学',code:'090301'},{level:'本科',major:'土地资源管理',code:'120404'}]};
const row='[岗位表 第 44 行] 【职位】A | 【学历】本科及以上 | 【学位】学士及以上 | 【专业】本  科：公共管理类\n研究生：农业资源与环境 | 【政治面貌】中共党员';
const req=(evidence:string,levels=['硕士','博士'],names=['农业资源与环境'])=>({evidence,levels,names,codes:[],unrestricted:false,catalog:''});
const job=(requirements:any[])=>({sourceRowId:'parser-owned-row',majorRequirements:requirements,eligibilityRequirements:[],eligibilityCoverage:'complete',analysisIncomplete:false});

describe('same-row table evidence',()=>{
 it('restores split degree and profession columns using the exact complete degree clause',()=>{
  const raw=job([req('【学历】本科及以上 | 【专业】研究生：农业资源与环境'),req('【学历】本科及以上 | 【专业】本  科：公共管理类',['本科'],['公共管理类'])]);
  const fixed=normalizeTableEvidence(raw,row);
  expect(fixed.majorRequirements.map(r=>r.evidence)).toEqual(['研究生：农业资源与环境','本  科：公共管理类']);
  expect(fixed.majorRequirements.every(r=>hasEvidence(row,r.evidence))).toBe(true);
  expect(matchJob(fixed,[profile],row)).toMatchObject({majorStatus:'matched',matchedLevel:'硕士'});
  expect(raw.majorRequirements[0].evidence).toContain('【学历】');
 });
 it('retains the separate undergraduate path when the graduate major is not eligible',()=>{
  const text=row.replace('研究生：农业资源与环境','研究生：公共管理（学）');
  const fixed=normalizeTableEvidence(job([req('【学历】本科及以上 | 【专业】研究生：公共管理（学）',['硕士','博士'],['公共管理（学）']),req('【学历】本科及以上 | 【专业】本  科：公共管理类',['本科'],['公共管理类'])]),text);
  expect(matchJob(fixed,[profile],text)).toMatchObject({majorStatus:'matched',matchedLevel:'本科',match:'待核对'});
 });
 it('checks the actual degree and degree-award cells before removing their copied labels',()=>{
  const text='[岗位 第 8 行] 【学历】研究生 | 【学位】硕士及以上 | 【专业要求】农学（门类）、工学（门类）';
  const raw=job([req('【学历】研究生 | 【学位】硕士及以上 | 【专业要求】农学（门类）、工学（门类）',['硕士','博士'],['农学','工学'])]);
  const fixed=normalizeTableEvidence(raw,text);
  expect(fixed.majorRequirements[0].evidence).toBe('农学（门类）、工学（门类）');
  expect(matchJob(fixed,[profile],text)).toMatchObject({majorStatus:'matched',matchedLevel:'硕士'});
  const incorrect=job([req(raw.majorRequirements[0].evidence,['本科'],['农学','工学'])]);
  expect(normalizeTableEvidence(incorrect,text).majorRequirements).toEqual(incorrect.majorRequirements);
 });
 it('does not invent a profession, use a neighbouring row, or accept a shortened exception',()=>{
  const unrelated=job([req('【学历】本科及以上 | 【专业】研究生：土壤学',['硕士'],['土壤学'])]);
  expect(normalizeTableEvidence(unrelated,row).majorRequirements).toEqual(unrelated.majorRequirements);
  const excludedRow='[岗位 第 3 行] 【学历】本科 | 【专业】公共管理类（不含土地资源管理）';
  const truncated=job([req('【学历】本科 | 【专业】公共管理类',['本科'],['公共管理类'])]);
  expect(normalizeTableEvidence(truncated,excludedRow).majorRequirements).toEqual(truncated.majorRequirements);
  const full=normalizeTableEvidence(job([req('【学历】本科 | 【专业】公共管理类（不含土地资源管理）',['本科'],['公共管理类'])]),excludedRow);
  expect(full.majorRequirements[0].evidence).toContain('不含土地资源管理');
  expect(matchJob(full,[profile],excludedRow).majorStatus).toBe('excluded');
 });
 it('does not drop a shared prefix or reinterpret a non-table source',()=>{
  const text='[岗位 第 7 行] 【学历】本科及以上 | 【专业】本科和研究生专业均须符合以下要求；本科：公共管理类；研究生：农业资源与环境';
  const raw=job([req('【学历】本科及以上 | 【专业】研究生：农业资源与环境')]);
  expect(normalizeTableEvidence(raw,text).majorRequirements).toEqual(raw.majorRequirements);
  expect(normalizeTableEvidence({...raw,sourceRowId:''},row).majorRequirements).toEqual(raw.majorRequirements);
  expect(normalizeTableEvidence(raw)).toBe(raw);
 });
 it('handles a corresponding-degree column without treating it as an unknown degree range',()=>{
  const text='[岗位 第 7 行] 【学历\n要求】硕士研究生及以上 | 【学位要求】与最高学历相对应的学位 | 【专业要求】农业资源与环境（0903）';
  const fixed=normalizeTableEvidence(job([req('【学历要求】硕士研究生及以上 | 【专业要求】农业资源与环境（0903）')]),text);
  expect(fixed.majorRequirements[0].evidence).toBe('农业资源与环境（0903）');
  expect(matchJob(fixed,[profile],text)).toMatchObject({majorStatus:'matched',matchedLevel:'硕士'});
 });
 it('retains other-column restrictions and joint-degree conditions for a full assessment',()=>{
  const text='[岗位 第 5 行] 【学历】硕士及以上 | 【专业】农业资源与环境 | 【其他条件】土壤学专业除外';
  const raw=job([req('【学历】硕士及以上 | 【专业】农业资源与环境 | 【其他条件】土壤学专业除外')]);
  expect(normalizeTableEvidence(raw,text).majorRequirements).toEqual(raw.majorRequirements);
  const joint=row.replace('【学历】本科及以上','【学历】本科及硕士均须符合');
  expect(normalizeTableEvidence(job([req('【专业】研究生：农业资源与环境')]),joint).majorRequirements[0].evidence).toBe('【专业】研究生：农业资源与环境');
 });
 it('updates only the same job catalogue requirement quote and leaves the standard catalogue intact',()=>{
  const before=majorHierarchy(profile.education[0]);
  const text='[岗位 第 5 行] 【学历】硕士及以上 | 【人数】2 | 【专业要求】植物保护与农业资源利用类';
  const evidence='【学历】硕士及以上 | 【专业要求】植物保护与农业资源利用类';
  const fixed=normalizeTableEvidence({...job([req(evidence,['硕士','博士'],['植物保护与农业资源利用类'])]),catalogChecks:[{level:'硕士',major:'土壤学',requirementEvidence:evidence,catalogEvidence:'研究生 土壤学 植物保护与农业资源利用类',decision:'matched',reason:'本公告目录原文'}]},text);
  expect(fixed.catalogChecks[0].requirementEvidence).toBe('植物保护与农业资源利用类');
  expect(fixed.catalogChecks[0].catalogEvidence).toBe('研究生 土壤学 植物保护与农业资源利用类');
  expect(majorHierarchy(profile.education[0])).toEqual(before);
 });
 it('retains short profession cells and separates unrestricted matching from preferences',()=>{
  const text='[岗位 第 8 行] 【学历】硕士及以上 | 【学位】与最高学历相对应的学位 | 【专业要求】不限';
  const fixed=normalizeTableEvidence(job([{...req('【学历】硕士及以上 | 【专业要求】不限',['硕士','博士'],[]),unrestricted:true}]),text);
  expect(fixed.majorRequirements[0].evidence).toBe('【专业要求】不限');
  expect(matchJob(fixed,[{...profile,includeUnrestricted:true}],text).majorStatus).toBe('unrestricted');
  expect(matchJob(fixed,[{...profile,includeUnrestricted:false}],text).majorStatus).toBe('unrestricted');
  expect(matchJob(fixed,[{...profile,includeUnrestricted:true,education:[profile.education[1]]}],text).majorStatus).toBe('excluded');
  const qualified=text.replace('不限','不限（土壤学除外）');
  expect(normalizeTableEvidence(job([{...req('【学历】硕士及以上 | 【专业要求】不限',['硕士','博士'],[]),unrestricted:true}]),qualified).majorRequirements[0].evidence).toContain('【学历】');
 });
 it('keeps catalogue quotations bound to the corresponding degree when the model quoted both clauses',()=>{
  const evidence='【专业】本  科：公共管理类\n研究生：农业资源与环境';
  const raw={...job([req(evidence),req(evidence,['本科'],['公共管理类'])]),catalogChecks:[{level:'硕士',requirementEvidence:evidence},{level:'本科',requirementEvidence:evidence}]};
  const fixed=normalizeTableEvidence(raw,row);
  expect(fixed.catalogChecks.map(c=>c.requirementEvidence)).toEqual(['研究生：农业资源与环境','本  科：公共管理类']);
 });
 it('uses the highest-degree catalogue check when lower degrees cannot be used for this notice',()=>{
  const requirement='硕士机械类',catalog='研究生 土壤学 植物保护与农业资源利用类',rule='须以最高学历专业报考';
  const candidate={...job([req(requirement,['硕士'],['机械类'])]),catalogContext:true,catalogChecks:[{level:'硕士',major:'土壤学',decision:'excluded',requirementEvidence:requirement,catalogEvidence:catalog,reason:'本公告目录类别不符'}],degreePolicy:{policy:'highest',evidence:rule}};
  expect(matchJob(candidate,[profile],[requirement,catalog,rule].join('\n'))).toMatchObject({majorStatus:'excluded',match:'不符合'});
  expect(matchJob({...candidate,degreePolicy:{policy:'unknown',evidence:''}},[profile],[requirement,catalog].join('\n')).majorStatus).toBe('unknown');
 });
});
