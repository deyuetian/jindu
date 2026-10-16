import {chinaLocations} from './china-locations.ts';

const provinces=chinaLocations.flatMap(({province})=>[
  {name:province,province},
  {name:province.replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市$/g,''),province}
]).sort((a,b)=>b.name.length-a.name.length);

/** Basic source facts must remain searchable before an AI report is available.
 * Only an explicit recruitment title supplies fallback metadata. Do not infer a
 * workplace from a university/employer name, the page footer, or eligibility.
 * This is a read projection; it never changes the saved analysis or its status.
 */
export function announcementMetadata<T extends {title?:string;type?:string;province?:string}>(item:T):T{
  const title=String(item.title||'').replace(/\s+/g,'').replace(/^(?:【[^】]{1,20}】|\[[^\]]{1,20}\]){1,2}/,'').replace(/^关于(?:转发)?[《“「]?/,'');
  const selection=/选调/.test(title)&&/(?:公告|简章|招录|选调生|选调应届)/.test(title)&&!/(?:宣讲|讲座|培训|经验|就业指导|备考)/.test(title);
  const type=(!item.type||item.type==='其他')&&selection?'选调':item.type;
  let province=item.province;
  if(!province?.trim()&&selection){
    const regionTitle=title.replace(/^20\d{2}(?:年度|年|届)/,'');
    const place=provinces.find(p=>regionTitle.startsWith(p.name)&&/^(?:20\d{2}|面向|定向|选调|年度|党政机关)/.test(regionTitle.slice(p.name.length)));
    if(place)province=place.province;
  }
  return type===item.type&&province===item.province?item:{...item,type,province};
}

export function announcementAnalysisCounts(items:{archived?:boolean;analysisStatus?:string}[]){
  const counts={pending:0,error:0,partial:0};
  for(const item of items){
    if(item.archived)continue;
    if(item.analysisStatus==='error')counts.error++;
    else if(item.analysisStatus==='partial')counts.partial++;
    else if(item.analysisStatus!=='done')counts.pending++;
  }
  return counts;
}

export function announcementAnalysisLabel(item:{analysisStatus?:string;analysisPendingParts?:number}){
  if(item.analysisStatus==='partial'&&item.analysisPendingParts)return '部分完成 · 可继续';
  return ({pending:'等待分析',running:'正在分析',waiting_config:'等待配置接口',waiting_quota:'等待额度恢复',retry:'正在重试',error:'分析未完成',partial:'部分内容待核对',done:'已分析'} as Record<string,string>)[item.analysisStatus||'']||'待处理';
}
export function announcementAnalysisNotice(item:{analysisStatus?:string;analysisError?:string;analysisPendingParts?:number}){
  if(item.analysisStatus==='done')return '';
  if(item.analysisStatus==='partial')return item.analysisPendingParts?`已保存有效结果，${item.analysisPendingParts} 个部分仍待处理。可在详情中继续未完成部分。`:'';
  const reason=item.analysisError||({waiting_config:'请先配置可用的 AI 接口。',waiting_quota:'等待额度恢复后继续。',retry:'等待继续处理。'}[item.analysisStatus||'']||'');
  return `公告已收集，分析${item.analysisStatus==='error'?'未完成':'尚未完成'}。${reason}`;
}
