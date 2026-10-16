/** User decisions are independent of matching results. Legacy 收藏 was assigned automatically. */
export const jobStatuses = ['未选择','关注','准备材料','已报名','笔试','面试','结束'] as const;
export function applicationStatus(job:any):typeof jobStatuses[number] {
  if(job.status==='拟投递')return '关注'; // Preserve the user's selections from previous versions.
  return jobStatuses.includes(job.status) ? job.status : '未选择';
}
export function hasApplicationIntent(job:any){return applicationStatus(job)!=='未选择';}

const provinceNames = [
  ['北京','北京市'],['天津','天津市'],['上海','上海市'],['重庆','重庆市'],
  ...'河北 山西 辽宁 吉林 黑龙江 江苏 浙江 安徽 福建 江西 山东 河南 湖北 湖南 广东 海南 四川 贵州 云南 陕西 甘肃 青海 台湾'.split(' ').map(n=>[n,n+'省']),
  ['内蒙古','内蒙古自治区'],['广西','广西壮族自治区'],['西藏','西藏自治区'],['宁夏','宁夏回族自治区'],['新疆','新疆维吾尔自治区'],
  ['香港','香港特别行政区'],['澳门','澳门特别行政区'],
];
/** Only expand known prefixes; do not invent a city or infer a work location from an employer. */
export function regionName(value:unknown):string {
  const text=String(value||'').trim().replace(/\s*[·•]\s*/g,' · ');
  if(!text)return '';
  return text.split(/([、,，;；/\n])/).map(part=>{
    const s=part.trim();
    // 吉林市 is a city, not an abbreviated province. Do not rewrite its identity.
    if(/^吉林市|^海南(?:藏族|州|区)/.test(s))return s;
    const pair=provinceNames.find(([short])=>s.startsWith(short));
    if(!pair)return s;
    const [short,full]=pair;
    let rest=s.slice(short.length).replace(/^(?:壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市)/,'').trim();
    rest=rest.replace(/^[·•\s]+/,'');
    return full+(rest?(/^[内外及等（(]/.test(rest)?rest:' · '+rest):'');
  }).join('').replace(/[，,;；/\n]/g,'、');
}
export function regionSearch(value:unknown){
  return regionName(value).replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市|[·\s]/g,'').toLowerCase();
}
/** Full requirement text for details. Length limits belong only to list previews. */
export function majorRequirementText(job:any):string {
  const sourceMajor=String(job.sourcePosition?.major||'').trim();
  if(sourceMajor&&job.analysisQuality?.issues?.some((s:string)=>/专业|学历|匹配分析/.test(s)))return /^(?:不限|不限专业|专业不限)$/.test(sourceMajor)?'不限专业':sourceMajor;
  const requirements=job.majorRequirements||[];
  // Mixed degree-specific requirements must not become an unqualified “不限专业”.
  if(requirements.length){
    if(requirements.every((r:any)=>r.unrestricted))return '不限专业';
    const entries=[...new Set<string>(requirements.map((r:any)=>{
      const names=(r.names||[]).filter(Boolean);
      const text=r.unrestricted?'不限专业':names.length?'招收'+names.join('、'):(r.codes||[]).length?'专业代码 '+r.codes.join('、'):'专业范围待核对';
      return requirements.length>1&&r.levels?.length?r.levels.join('/')+'：'+text:text;
    }))];
    return entries.join('；');
  }
  const raw=String(job.sourcePosition?.major||'').trim();
  if(raw)return raw;
  return job.majorStatus==='unrestricted'?'不限专业':'专业要求待核对';
}
export function majorSummary(job:any):string {
  const text=majorRequirementText(job);
  return text.length>70?text.slice(0,68)+'…':text;
}
export function majorLabel(job:any){return !job.announcementId?'手动记录':({matched:'专业符合',unrestricted:'专业符合',unknown:'专业待核对',excluded:'专业不符'}[job.majorStatus as string]||'专业待核对');}
