import {initializeSchema} from './schema.ts';
import {resumeAnalysisWork} from './analysis-recovery.ts';
import { DatabaseSync,type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { schemas, now, todayCN, nextDate, AppError, type Kind } from './model.ts';
import { matchJob } from './matching.ts';
import { majorHierarchy } from '../shared/majors.ts';
import {isLaterExamStage,stageMilestone,normalizeCalendarStages,calendarExamView} from '../shared/calendar-policy.ts';
import {announcementTitle} from '../shared/announcement-presentation.ts';
import {announcementMetadata} from '../shared/announcement-metadata.ts';
import {unreadNoticeWhere} from './agent-notices.ts';

export class Store {
  db: DatabaseSync;
  dir: string;
  constructor(dir: string) {
    this.dir = dir; mkdirSync(dir, {recursive:true});
    this.db = new DatabaseSync(join(dir, 'jindu.sqlite'));
    try {initializeSchema(this.db);} catch(error) {this.db.close();throw error;}
  }
  private statements?:Map<string,StatementSync>;
  prepare(sql:string):StatementSync {
    const cache=this.statements??=new Map<string,StatementSync>();
    const found=cache.get(sql);if(found)return found;
    const statement=this.db.prepare(sql);
    // A bounded set of reusable statements avoids native allocation on each idle tick.
    if(cache.size>=32)cache.delete(cache.keys().next().value!);
    cache.set(sql,statement);return statement;
  }
  transaction<T>(fn:()=>T):T { this.db.exec('BEGIN IMMEDIATE'); try { const r=fn(); this.db.exec('COMMIT'); return r; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  getSetting<T>(key:string, fallback:T):T { const r=this.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|undefined; return r?JSON.parse(r.value):fallback; }
  setSetting(key:string,value:unknown) { this.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)); }
  get(id:string):any { const r=this.prepare('SELECT * FROM records WHERE id=?').get(id) as any; return r?{...JSON.parse(r.data),id:r.id,kind:r.kind,version:r.version,updatedAt:r.updated_at}:null; }
  list(kind:string):any[] { return (this.prepare('SELECT * FROM records WHERE kind=? ORDER BY updated_at DESC').all(kind) as any[]).map(r=>({...JSON.parse(r.data),id:r.id,version:r.version,updatedAt:r.updated_at})); }
  put(id:string,kind:string,data:any,version?:number) {
    const clean={...data}; delete clean.id; delete clean.kind; delete clean.version; delete clean.updatedAt;
    if(version!==undefined) {
      const r=this.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=? AND kind=? AND version=?').run(JSON.stringify(clean),now(),id,kind,version);
      if(!r.changes)throw new AppError(409,'这条记录已被另一设备或后台更新，请刷新后重试');
    } else this.prepare('INSERT INTO records(id,kind,data,updated_at) VALUES(?,?,?,?)').run(id,kind,JSON.stringify(clean),now());
    return this.get(id);
  }
  save(kind:Kind,input:unknown,id?:string,version?:number) {
    const data:any=schemas[kind].parse(input); const recordId=id||randomUUID();
    if(id && (!Number.isInteger(version)||!version))throw new AppError(400,'缺少记录版本');
    return this.transaction(()=>{
      const old=id?this.get(id):null;
      if(id&&(!old||old.kind!==kind||old.version!==version))throw new AppError(409,'记录已变化，请刷新后重试');
      if(kind==='task') {
        if(data.parentId) {
          let p=this.get(data.parentId); const visited=new Set([recordId]);
          if(!p||p.kind!=='task')throw new AppError(400,'父任务不存在');
          while(p) {if(visited.has(p.id))throw new AppError(400,'任务不能循环关联');visited.add(p.id);p=p.parentId?this.get(p.parentId):null;}
        }
        if(data.goalId&&this.get(data.goalId)?.kind!=='goal')throw new AppError(400,'学习计划不存在');
        if(data.repeat!=='none'&&!data.due)throw new AppError(400,'重复任务需要设置首次日期');
        if(data.repeatUntil&&data.due>data.repeatUntil)throw new AppError(400,'重复结束日期不能早于本期日期');
        data.seriesId=old?.seriesId||((data.repeat!=='none')?recordId:'');
        if(data.seriesId) {
          const series=this.prepare('SELECT * FROM repeats WHERE id=?').get(data.seriesId) as any;
          const fields=['repeat','repeatUntil','archived','title','notes','due','time','priority','category','goalId','parentId'];
          const changes=fields.filter(k=>!old||old[k]!==data[k]);
          if(changes.length) {
            const template={...(series?JSON.parse(series.template):data),...Object.fromEntries(changes.map(k=>[k,data[k]])),done:false,archived:false,seriesId:data.seriesId};
            const reschedule=!series||changes.includes('repeat')||changes.includes('due');
            let next=reschedule?nextDate(data.due,template.repeat==='weekly'?7:1):series.next_date;
            // A changed rule only affects future occurrences, never recreates recorded history.
            if(reschedule&&series) {
              const dates=this.list('task').filter(t=>t.seriesId===data.seriesId&&t.id!==recordId).map(t=>t.due).filter(Boolean);
              const last=[data.due,...dates].sort().at(-1)!;
              while(next<=last)next=nextDate(next,template.repeat==='weekly'?7:1);
            }
            const active=template.repeat!=='none'&&(changes.includes('archived')?!data.archived:series?!!series.active:true);
            this.prepare('INSERT INTO repeats VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET template=excluded.template,period=excluded.period,next_date=excluded.next_date,until_date=excluded.until_date,active=excluded.active').run(data.seriesId,JSON.stringify(template),template.repeat,next,template.repeatUntil,active?1:0);
          }
        }
      }
      if(kind==='study'&&this.get(data.goalId)?.kind!=='goal')throw new AppError(400,'学习计划不存在');
      if(kind==='goal'&&old) data.completed=old.completed;
      if(kind==='exam') {
        const previousStages=old?calendarExamView(old).stages:[];
        // Only the assistant can open later stages. The editor may pause tracking.
        data.tracking=data.calendarKind==='personal'?undefined:old?.tracking?{...old.tracking,enabled:data.tracking?.enabled??old.tracking.enabled}:undefined;
        if(data.tracking) {
          const suppressed=new Set<string>(old.tracking.suppressed||[]);
          for(const stage of previousStages) {
            const replacement=data.stages.find((s:any)=>s.id===stage.id);
            if(!replacement&&stage.milestone)suppressed.add(stage.milestone);
          }
          data.tracking.suppressed=[...suppressed];
        }
        data.stages=data.stages.map((s:any)=>{
          const previous=previousStages.find((p:any)=>p.id===s.id);
          if(!previous)return {...s,origin:'manual',manualEdited:true};
          const changed=['label','date','time','evidence','sourceUrl'].some(k=>s[k]!==previous[k]);
          return {...s,milestone:previous.milestone,origin:previous.origin,manualEdited:previous.manualEdited||changed};
        });
      }
      if(kind==='profile')data.education=data.education.map((e:any)=>{
        const resolved=majorHierarchy(e);
        return schemas.profile.shape.education.element.parse(resolved.verified?{...resolved,hierarchyConfirmed:true}:e);
      });
      if(kind==='job'&&data.announcementId)Object.assign(data,matchJob(data,this.list('profile'),this.sourceText(data.announcementId)));
      const saved=this.put(recordId,kind,data,version);
      if(kind==='profile'&&['education','includeUnrestricted','archived','conditions','regions','eligibility'].some(k=>JSON.stringify(old?.[k])!==JSON.stringify(data[k]))) {
        const profiles=this.list('profile');
        const sources=new Map<string,string>();
        for(const job of this.list('job').filter(j=>j.announcementId)){
          if(!sources.has(job.announcementId))sources.set(job.announcementId,this.sourceText(job.announcementId));
          const evaluated=matchJob(job,profiles,sources.get(job.announcementId)!);
          this.put(job.id,'job',{...job,...evaluated},job.version);
        }
      }
      return saved;
    });
  }
  sourceText(id:string) {
    const ann=this.get(id);
    const files=this.prepare('SELECT id,text FROM files WHERE announcement_id=?').all(id) as any[];
    return [ann?.body||'',...files.filter(f=>!ann?.fileIds||ann.fileIds.includes(f.id)).map(f=>f.text)].join('\n[附件分隔]\n');
  }
  repeat(today=todayCN()) {
    this.transaction(()=>{
      for(const row of this.prepare('SELECT * FROM repeats WHERE active=1').all() as any[]) {
        let day=row.next_date; let count=0;
        while(day<=today&&(!row.until_date||day<=row.until_date)&&count++<400) {
          const data={...JSON.parse(row.template),due:day,done:false,archived:false,seriesId:row.id};
          const id=`repeat:${row.id}:${day}`;
          if(!this.get(id))this.put(id,'task',data);
          day=nextDate(day,row.period==='weekly'?7:1);
        }
        this.prepare('UPDATE repeats SET next_date=? WHERE id=?').run(day,row.id);
      }
    });
  }
  snapshot(compactLists=false) {
    const tasks=this.list('task'),goals=this.list('goal'),studies=this.list('study');
    for(const goal of goals) { goal.baseline=goal.completed; goal.completed+=studies.filter(s=>s.goalId===goal.id&&!s.archived).reduce((n,s)=>n+s.amount,0);goal.minutes=studies.filter(s=>s.goalId===goal.id&&!s.archived).reduce((n,s)=>n+s.minutes,0); }
    const queue=this.prepare('SELECT state,COUNT(*) count FROM jobs GROUP BY state').all();
    const announcements=compactLists?[]:this.list('announcement').map(announcementMetadata).map(a=>({id:a.id,version:a.version,title:a.title,type:a.type,province:a.province,published:a.published,source:a.source,status:a.status,needsReview:a.needsReview,analysisStatus:a.analysisStatus,analysisError:a.analysisError,relevant:a.relevant,summary:a.summary?.slice(0,130),updatedAt:a.updatedAt}));
    const announcementCounts=this.prepare("SELECT COUNT(*) total,SUM(CASE WHEN json_extract(data,'$.status')='pending' OR json_extract(data,'$.needsReview')=1 THEN 1 ELSE 0 END) pending FROM records WHERE kind='announcement'").get() as any;
    const jobCounts=this.prepare("SELECT COUNT(*) intended FROM records WHERE kind='job' AND json_extract(data,'$.status') IN ('关注','拟投递') AND COALESCE(json_extract(data,'$.archived'),0)=0 AND COALESCE(json_extract(data,'$.analysisCurrent'),1)!=0").get();
    const agentUnread=(this.prepare(`SELECT COUNT(*) n FROM records t WHERE ${unreadNoticeWhere}`).get() as {n:number}).n;
    return {tasks,goals,studies,exams:this.list('exam').map(calendarExamView),announcements,announcementCounts,jobCounts,profiles:this.list('profile'),jobs:compactLists?(this.prepare("SELECT * FROM records WHERE kind='job' AND json_extract(data,'$.archived')=1 ORDER BY updated_at DESC").all() as any[]).map(r=>({...JSON.parse(r.data),id:r.id,version:r.version,updatedAt:r.updated_at})):this.list('job'),agentUnread,source:this.getSetting('source-status',{}),queue,usage:this.prepare('SELECT * FROM usage WHERE day=?').get(todayCN())||{calls:0,input_tokens:0,output_tokens:0},preview:false};
  }
  enqueue(id:string,type:string,payload:unknown,force=false) {
    this.prepare(`INSERT INTO jobs(id,type,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO ${force?"UPDATE SET payload=excluded.payload,state=CASE WHEN jobs.state='running' THEN 'running' ELSE 'pending' END,attempts=0,error='',available_at=0,updated_at=excluded.updated_at":"NOTHING"}`).run(id,type,JSON.stringify(payload),now());
  }
  enqueueAnalysis(id:string,reset=false) {
    const ann=this.get(id);if(!ann||ann.kind!=='announcement')return;
    const jobs=this.prepare("SELECT id,state FROM jobs WHERE type='analyze' AND json_extract(payload,'$.id')=?").all(id) as any[];
    if(jobs.some(j=>j.state==='running')){const queued=this.getSetting<any>('analysis-requeue:'+id,null);this.setSetting('analysis-requeue:'+id,{reset:reset||queued===true||!!queued?.reset});return;}
    const key='analyze:'+id;
    // Preserve job history, but only one runnable analysis may exist per announcement.
    for(const j of jobs)if(j.id!==key&&j.state!=='done')this.prepare("UPDATE jobs SET state='done',error='已合并到当前公告分析任务',updated_at=? WHERE id=?").run(now(),j.id);
    if(reset) {
      for(const file of this.prepare('SELECT id FROM files WHERE announcement_id=?').all(id) as any[]){const key='document-read:'+file.id;if(this.getSetting<any>(key,null)?.readable===false)this.prepare('DELETE FROM settings WHERE key=?').run(key);}
      const work=this.getSetting<any>('analysis:'+id,null);
      if(work?.sourceHash!==undefined&&work.sourceHash!==ann.contentHash)this.prepare("DELETE FROM settings WHERE key=?").run('analysis:'+id);
      else if(resumeAnalysisWork(work))this.setSetting('analysis:'+id,work);
      else this.prepare("DELETE FROM settings WHERE key=?").run('analysis:'+id);
    }
    const progress=this.getSetting<any>('analysis:'+id,null);
    if(!progress||progress.index>=progress.segments?.length||progress.sourceHash&&progress.sourceHash!==ann.contentHash)this.setSetting('analysis-progress',{announcementId:id,part:0,total:0,updatedAt:now()});
    this.enqueue(key,'analyze',{id},true);
    if(ann.analysisStatus!=='pending')this.put(id,'announcement',{...ann,analysisStatus:'pending',analysisError:''},ann.version);
  }
  recoverAnalyses() {
    for(const a of this.list('announcement').filter(a=>a.source!=='指定考试官方检索'&&(!a.analysisStatus||['pending','running','retry','waiting_config','waiting_quota','error'].includes(a.analysisStatus))))this.enqueueAnalysis(a.id);
  }
  accept(id:string,version:number,input:unknown) {
    const exam=schemas.exam.parse(input);
    return this.transaction(()=>{
      const ann=this.get(id);if(!ann||ann.kind!=='announcement'||ann.version!==version)throw new AppError(409,'公告已更新，请重新核对');
      const eid='exam:'+id;if(this.get(eid)||this.list('exam').some(e=>e.announcementId===id&&e.calendarKind!=='personal'))throw new AppError(409,'已加入日历，请在日历中更新已有节点');
      const candidates=normalizeCalendarStages<any>(ann.candidates||[]);
      const stages=normalizeCalendarStages(exam.stages.filter(s=>!isLaterExamStage(s)).map(s=>{
        const source=candidates.find((c:any)=>c.id===s.id)||(ann.candidates||[]).find((c:any)=>c.id===s.id)||candidates.find((c:any)=>c.label===s.label&&c.date===s.date);
        const edited=!source||source.date!==s.date||(source.time||'')!==s.time;
        return {...s,milestone:stageMilestone(s),origin:edited?'manual':'ai',manualEdited:edited,sourceUrl:ann.url||''};
      }));
      if(!stages.some(s=>s.date))throw new AppError(400,'请至少填写一个报名、笔试或成绩阶段的日期');
      const selected=new Set(stages.map(stageMilestone));
      const suppressed=(ann.candidates||[]).filter((s:any)=>!isLaterExamStage(s)).map(stageMilestone).filter((m:string|undefined)=>m&&!selected.has(m));
      const title=announcementTitle(ann);
      const value=schemas.exam.parse({...exam,title,calendarKind:'exam',stages,announcementId:id,
        tracking:{enabled:exam.tracking?.enabled??true,passed:false,query:title,sources:ann.url?[ann.url]:[],suppressed:[...new Set(suppressed)]}});
      this.put(eid,'exam',value);this.put(id,'announcement',{...ann,status:'accepted',needsReview:false},version);return {id:eid};
    });
  }
}
