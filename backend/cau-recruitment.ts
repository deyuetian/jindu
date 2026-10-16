import {hash} from './config.ts';
import {htmlText} from './school-crawler.ts';
import {prefilterRow,type PositionRow,type AnalysisSegment} from './job-tables.ts';

export type WebPosition={id:string;title:string;organization:string;education:string;major:string;count:string;location:string;description:string;text:string};
const clean=(v:unknown)=>typeof v==='string'?htmlText(v):typeof v==='number'?String(v):'';
const escape=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export const POSITION_SECTION='网页岗位明细';
export function cauRecruitmentContent(notice:any){
  const positions:WebPosition[]=(Array.isArray(notice.recruitmentPositionList)?notice.recruitmentPositionList:[]).map((p:any,index:number)=>{
    const v={id:clean(p.id)||String(index+1),title:clean(p.positionName),organization:clean(notice.corporationName),education:clean(p.studentType),major:clean(p.majorName),count:clean(p.demandNumber),location:clean(p.cityName),description:clean(p.positionDescription)};
    const text=`[网页岗位 ${index+1}] `+[['岗位名称',v.title],['招聘单位',v.organization],['学历',v.education],['专业',v.major],['招聘人数',v.count],['工作地点',v.location],['岗位描述与任职要求',v.description]].map(([k,value])=>`【${k}】${value||'未说明'}`).join(' | ');
    return {...v,text};
  });
  const declared=Number(notice.positionNum||positions.length);
  const errors=declared>positions.length?[`网页标注 ${declared} 个岗位，当前只读取 ${positions.length} 个，需补齐岗位明细`]:[];
  const appendix=positions.length?`<section><h2>${POSITION_SECTION}</h2>${positions.map(p=>'<p>'+escape(p.text)+'</p>').join('')}</section>`:'';
  return {html:String(notice.content||'')+appendix,positions,errors,declaredPositions:declared};
}
export function webPositionSegments(announcement:any,profiles:any[]){
  const segments:AnalysisSegment[]=[];const positions:WebPosition[]=announcement.sourcePositions||[];
  const stats={rows:positions.length,candidates:0,excluded:0,review:0};
  let rows:PositionRow[]=[],length=0;
  const flush=()=>{if(rows.length)segments.push({text:rows.map(r=>`岗位行ID：${r.rowId}\n${r.text}`).join('\n\n'),depth:0,imageId:'',table:true,rows});rows=[];length=0;};
  for(let i=0;i<positions.length;i++){
    const p=positions[i],verdict=prefilterRow([{column:0,header:'专业',value:p.major}],profiles);
    // A closed headline list must not hide a wider or narrower requirement in the description.
    if(verdict==='excluded'&&!p.description){stats.excluded++;continue;}
    stats.candidates++;if(verdict!=='candidate')stats.review++;
    if(rows.length&&(rows.length>=3||length+p.text.length>5500))flush();
    rows.push({fileId:announcement.sourceFileIds?.[0]||'',fileName:'网页岗位明细',sheet:'网页岗位',row:i+1,rowId:hash(announcement.id+'\0web-position\0'+p.id).slice(0,32),positionCode:'',title:p.title,organization:p.organization,text:p.text,sourcePosition:{education:p.education,major:p.major,count:p.count,location:p.location,description:p.description}});
    length+=p.text.length;
  }
  flush();return {segments,stats};
}
