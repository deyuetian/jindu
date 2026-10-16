/** Daily checklist occurrences stay out of both the calendar and its subscription. */
export function isCalendarTask(task:Record<string,unknown>&{repeat?:string;archived?:boolean}) {
  return !task.archived && task.repeat !== 'daily';
}

/** Initial exam imports stop at written results until the user confirms passing. */
export function isLaterExamStage(stage:{label?:string;milestone?:string}) {
  return /面试|体检|考察|政审|录用|拟聘|聘用|公示|入职/.test(stage.label||'')
    || ['interview','physical','review','offer'].includes(stage.milestone||'');
}

// Whole-label aliases only. Qualifiers such as 调剂、改报、地区 and 批次 carry meaning.
export function calendarStageLabel(label:string) {
  const text=label.trim(),key=text.replace(/\s/g,'');
  const edge='(?:日期|时间|日)?';
  const registration='(?:(?:网上|网络|在线|线上)?报名(?:申请)?|提交报名申请)';
  const ticket='(?:(?:笔试)?准考证(?:打印|下载)|(?:打印|下载)(?:笔试)?准考证)';
  for(const [pattern,name] of [[registration,'报名'],[ticket,'准考证打印'],['(?:网上)?资格初审','资格初审']] as const){
    if(new RegExp('^'+pattern+'(?:开始|启动|起始)'+edge+'$').test(key)||new RegExp('^(?:开始|启动)'+pattern+edge+'$').test(key))return name+'开始';
    if(new RegExp('^'+pattern+'(?:截止|结束)'+edge+'$').test(key))return name+'截止';
  }
  // Combined recommendation-form steps; standalone printing/audit remain separate.
  if(/^报名推荐表(?:打印(?:及)?(?:审核(?:鉴章)?|盖章)|审核(?:鉴章|盖章)|办理)(?:截止|结束)(?:日期|时间|日)?$/.test(key))return '报名推荐表办理截止';
  if(/^(?:六|6)项选调条件取得截止(?:日期|时间|日)?$/.test(key))return '选调条件取得截止';
  if(/^笔试(?:日期|时间)?$/.test(key))return '笔试';
  if(/^(?:笔试)?成绩(?:查询|公布)(?:日期|时间)?$/.test(key))return '成绩查询';
  const degree='(?:毕业证和学位证取得|取得毕业证和学位证)';
  if(new RegExp('^'+degree+'(?:起始|开始)'+edge+'$').test(key))return '毕业证和学位证取得起始日';
  if(new RegExp('^'+degree+'(?:截止|期限)'+edge+'$').test(key))return '毕业证和学位证取得截止日';
  return text;
}
const milestones:Record<string,string>={报名开始:'registration_start',报名截止:'registration_end',准考证打印开始:'ticket_start',准考证打印截止:'ticket_end',笔试:'written',成绩查询:'results'};
export function stageMilestone(stage:{label?:string;milestone?:string}) {
  if(!stage.label)return stage.milestone;
  // Old records may incorrectly assign 调剂报名 to registration_start/end.
  return milestones[calendarStageLabel(stage.label)]||(['interview','physical','review','offer'].includes(stage.milestone||'')?stage.milestone:undefined);
}

/** A read projection only: original records and personal/manual entries stay intact. */
export function calendarExamView<T extends {calendarKind?:string;stages:CalendarStageLike[]}>(exam:T):T {
  return exam.calendarKind==='personal'?exam:{...exam,stages:normalizeCalendarStages(exam.stages||[],true)};
}

/** Use the same association in lists, details and import guards. Active wins. */
export function announcementCalendars<T extends {id:string;announcementId?:string;calendarKind?:string;archived?:boolean}>(exams:readonly T[]){
  const result=new Map<string,T>();
  for(const exam of exams){
    if(exam.calendarKind==='personal')continue;
    const id=exam.announcementId||(exam.id.startsWith('exam:')?exam.id.slice(5):'');
    if(id&&(!result.has(id)||result.get(id)!.archived&&!exam.archived))result.set(id,exam);
  }
  return result;
}

type CalendarStageLike={label:string;date:string;time?:string;milestone?:string;origin?:string;manualEdited?:boolean;evidence?:string;inferredYear?:boolean};
/** Normalize saved analysis at read/import time too; never rewrite personal/manual entries. */
export function normalizeCalendarStages<T extends CalendarStageLike>(input:readonly T[],preserveUnowned=false):T[] {
  const protectedStage=(s:T)=>s.manualEdited||s.origin==='manual'||(preserveUnowned&&s.origin!=='ai');
  const prepared=input.map(s=>protectedStage(s)?{...s}:{...s,label:calendarStageLabel(s.label),milestone:stageMilestone(s)});
  const dayKey=(s:T)=>JSON.stringify([s.label.replace(/\s/g,''),s.date]);
  const times=new Map<string,Set<string>>();
  for(const s of prepared){
    if(protectedStage(s)||!s.date||!s.time)continue;
    const key=dayKey(s);if(!times.has(key))times.set(key,new Set());times.get(key)!.add(s.time);
  }
  const result:T[]=[],seen=new Map<string,T>();
  for(const s of prepared){
    if(protectedStage(s)||!s.date){result.push(s);continue;}
    const known=times.get(dayKey(s));
    // A date-only alias can inherit a unique explicit time, never choose between conflicts.
    const time=s.time||(known?.size===1?[...known][0]:'');
    const key=JSON.stringify([dayKey(s),time]),previous=seen.get(key);
    if(previous){
      if(!previous.time&&s.time){previous.time=s.time;previous.evidence=s.evidence;}
      else if(!previous.evidence&&s.evidence)previous.evidence=s.evidence;
      if(s.inferredYear===false)previous.inferredYear=false;
    }else{seen.set(key,s);result.push(s);}
  }
  return result.sort((a,b)=>(a.date||'9999-99-99').localeCompare(b.date||'9999-99-99')||(a.time||'').localeCompare(b.time||''));
}
