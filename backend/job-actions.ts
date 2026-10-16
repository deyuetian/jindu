import {z} from 'zod';
import type {Store} from './db.ts';
import {AppError,schemas} from './model.ts';
import {announcementTitle} from '../shared/announcement-presentation.ts';
import {jobStatuses,regionName} from '../shared/job-display.ts';
import {jobPresentation} from '../shared/recruitment-report.ts';
import {recruitmentReader} from './recruitment-reader.ts';
import {isLaterExamStage,normalizeCalendarStages,announcementCalendars,calendarExamView} from '../shared/calendar-policy.ts';

function requireJob(store:Store,id:string){const job=store.get(id);if(!job||job.kind!=='job'||job.archived)throw new AppError(404,'岗位不存在或已归档');return job;}
export function jobDetail(store:Store,id:string){
  const job=requireJob(store,id),reader=recruitmentReader(store);
  return {...job,...reader.job(reader.get(id)||job)};
}
export function updateJobProgress(store:Store,id:string,input:unknown){
  const value=z.object({version:z.number().int().positive(),status:z.enum([...jobStatuses,'拟投递']),notes:z.string().max(8000).optional()}).parse(input);
  return store.transaction(()=>{
    const job=requireJob(store,id);
    // Patch only the user's fields so source facts and analysis metadata cannot be lost.
    store.put(id,'job',{...job,status:value.status,...(value.notes===undefined?{}:{notes:value.notes})},value.version);
    return jobDetail(store,id);
  });
}
export function calendarCandidates(ann:any){
  return normalizeCalendarStages<any>((ann.candidates||[]).flatMap((stage:any,index:number)=>{
    if(!stage.date||isLaterExamStage(stage))return [];
    const valid=schemas.exam.shape.stages.element.safeParse({...stage,id:stage.id||'candidate:'+index});
    if(!valid.success)return [];
    return [{...valid.data,id:'candidate:'+index}];
  }));
}
function calendarContext(store:Store,jobId:string){
  const job=requireJob(store,jobId),ann=store.get(job.announcementId);
  if(!ann||ann.kind!=='announcement')throw new AppError(404,'该岗位尚未关联公告，请在日历中手动安排');
  const existing=announcementCalendars(store.list('exam')).get(ann.id);
  return {ann,existing};
}
export function jobCalendar(store:Store,jobId:string){
  const {ann,existing}=calendarContext(store,jobId);
  return {announcementId:ann.id,version:ann.version,title:announcementTitle(ann),stages:calendarCandidates(ann),existing:existing?calendarExamView(existing):null};
}
export function addJobCalendar(store:Store,jobId:string,input:unknown){
  const value=z.object({version:z.number().int().positive(),stageIds:z.array(z.string().max(120)).min(1).max(60),follow:z.boolean().default(true)}).parse(input);
  return store.transaction(()=>{
    const {ann,existing}=calendarContext(store,jobId);
    // Repeated clicks or selecting another job never overwrite dates, even after manual edits.
    if(existing)return {id:existing.id,alreadyAdded:true,archived:!!existing.archived};
    if(ann.version!==value.version)throw new AppError(409,'公告已有更新，请重新打开时间节点');
    const available=calendarCandidates(ann),wanted=new Set(value.stageIds),chosen=available.filter((s:any)=>wanted.has(s.id));
    if(!chosen.length||chosen.length!==wanted.size)throw new AppError(400,'选择的日期已变化，请重新打开时间节点');
    const title=announcementTitle(ann),sources=ann.url?[ann.url]:[];
    const exam=schemas.exam.parse({title,calendarKind:'exam',type:ann.type||'其他',province:regionName(ann.province),url:ann.url||'',announcementId:ann.id,
      stages:chosen.map((s:any)=>({...s,origin:'ai',sourceUrl:ann.url||''})),
      tracking:{enabled:value.follow,passed:false,query:title,sources,suppressed:available.filter((s:any)=>!wanted.has(s.id)&&s.milestone).map((s:any)=>s.milestone)},
    });
    const id='exam:'+ann.id;store.put(id,'exam',exam);
    store.put(ann.id,'announcement',{...ann,status:'accepted',needsReview:false},ann.version);
    return {id,alreadyAdded:false,archived:false};
  });
}
