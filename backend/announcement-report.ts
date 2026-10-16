import {campusImageIds,campusImageWarning} from './analysis-materials.ts';
import {analysisRecovery,analysisWorkIssues} from './analysis-recovery.ts';
import type {Store} from './db.ts';
import {announcementMetadata} from '../shared/announcement-metadata.ts';
import {coverageSummary} from './position-quality.ts';
import {recruitmentReader} from './recruitment-reader.ts';
import {regionName} from '../shared/job-display.ts';
import {normalizeCalendarStages,announcementCalendars,calendarExamView} from '../shared/calendar-policy.ts';
import {introductionFields,mergeIntroduction,mergedSummary,announcementIntroduction} from '../shared/announcement-presentation.ts';
import {publicApplicationItems,orderedApplicationItems} from '../shared/application-presentation.ts';
import {matchJob} from './matching.ts';
import {evaluateEligibility,hasEvidence,validGroups} from '../shared/eligibility.ts';
import {applicationKey,applicationCoveredBy,compactText,consolidatedNotes,eligibilityKey,isProcessGroup,isProcessItem,jobPresentation,uniqueBy} from '../shared/recruitment-report.ts';

/** Read-only projection. Reuses saved evidence and never calls a model or writes records. */
export function announcementReport(store:Store,ann:any){
  ann=announcementMetadata(ann);
  const calendar=announcementCalendars(store.list('exam')).get(ann.id);
  const reader=recruitmentReader(store),source=reader.source(ann.id).text,profiles=reader.profiles().filter(p=>!p.archived);
  const files=(store.db.prepare('SELECT id,name,text,error,mime,sha256 FROM files WHERE announcement_id=?').all(ann.id) as any[]).filter(f=>!ann.fileIds||ann.fileIds.includes(f.id));
  const ignoredImages=campusImageIds(files),activeFiles=files.filter(f=>!ignoredImages.has(f.id));
  const work=store.getSetting<any>('analysis:'+ann.id,{});
  // Only completed analyses can replace the report. A reanalysis keeps the last saved report.
  const complete=!!work.results?.length&&work.index===work.segments?.length&&['done','partial'].includes(ann.analysisStatus);
  const results=complete?work.results.map((r:any,i:number)=>({...r,_imageId:r._imageId??work.segments?.find((s:any)=>s.resultIndex===i)?.imageId??work.segments?.[i]?.imageId??'',_partName:r._partName||work.segments?.[i]?.partName||''})).filter((r:any)=>!r._retired&&!ignoredImages.has(r._imageId)):[],general=results.filter((r:any)=>!r._table);
  const groups=uniqueBy(general.flatMap((r:any)=>(r.commonEligibility||[]).filter((g:any)=>validGroups([g],source))),eligibilityKey);
  const shared=publicApplicationItems(uniqueBy(general.flatMap((r:any)=>(r.applicationItems||[]).filter((i:any)=>hasEvidence(source,i.evidence))),applicationKey));
  const imageProcess=results.flatMap((r:any)=>{
    const imageId=r._imageId;
    return imageId&&files.some(f=>f.id===imageId&&f.mime.startsWith('image/')&&!f.error)?(r.applicationItems||[]).filter(isProcessItem).map((i:any)=>({...i,sourceFileId:imageId,sourceIsImage:true})):[];
  });
  const qualifications=groups.filter(g=>!isProcessGroup(g));
  const commonKeys=new Set(qualifications.map(g=>g.mode+compactText(g.evidence)));
  const sharedKeys=new Set(shared.map(applicationKey));
  const savedJobs=reader.list('job').filter(j=>j.announcementId===ann.id&&!j.archived&&j.analysisCurrent!==false);
  const jobs=savedJobs.map(j=>{
    const job=reader.job(j);
    return {...job,specificEligibilityChecks:{...job.eligibilityChecks,groups:job.eligibilityChecks.groups.filter((g:any)=>!commonKeys.has(g.mode+compactText(g.evidence)))},
      specificApplicationItems:uniqueBy(job.applicationItems.filter((i:any)=>!sharedKeys.has(applicationKey(i))&&!applicationCoveredBy(i,shared)),applicationKey)};
  });
  const analysisCoverage=coverageSummary(jobs,ann.tableScreening?.candidates||0);
  const profile=profiles.find(p=>p.id===jobs[0]?.profileId)||profiles[0];
  const commonEligibilityChecks=evaluateEligibility(qualifications as any,profile?.eligibility,source);
  const commonProcess=shared.filter(isProcessItem);
  const declared=groups.filter(isProcessGroup).map((g:any)=>({kind:'procedure',label:g.label,detail:g.evidence,evidence:g.evidence,phase:'报名',required:true}));
  const applicationProcess=orderedApplicationItems(uniqueBy([...commonProcess,...imageProcess,...declared],applicationKey));
  const uncertainties=complete?consolidatedNotes({values:results.flatMap((r:any)=>r.uncertainties||[]),files:activeFiles,results,jobs,dates:ann.candidates||[],issues:[...(ann.materialErrors||[]),...analysisWorkIssues(work)].filter(e=>!campusImageWarning(e,files))}):ann.uncertainties||[];
  const sourceNeedsRefresh=ann.id.startsWith('cau:')&&/recruitmentinfoForm/.test(ann.url||'')&&(ann.sourceMeta?.parserVersion||0)<2;
  const introduction={...introductionFields(ann,false),...mergeIntroduction(results)};
  const summary=announcementIntroduction({...ann,introduction,summary:mergedSummary(results)||ann.summary});
  return {...ann,analysisRecovery:work.sourceHash&&work.sourceHash!==ann.contentHash?null:analysisRecovery(work),calendarStatus:calendar?(calendar.archived?'archived':'added'):'',calendar:calendar?calendarExamView(calendar):null,analysisCoverage,analysisStatus:ann.analysisStatus==='done'&&analysisCoverage.incomplete?'partial':ann.analysisStatus,candidates:normalizeCalendarStages(ann.candidates||[]),introduction,summary,province:regionName(ann.province),jobs,commonEligibilityChecks,commonEligibilityProfile:profile?.title||'',commonApplicationItems:shared.filter(i=>!isProcessItem(i)),applicationProcess,
    commonCoverage:general.length&&general.every((r:any)=>r.commonCoverage==='complete')?'complete':'partial',
    uncertainties,sourceNeedsRefresh,reportReady:complete||!!ann.analyzedAt};
}
