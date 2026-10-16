import type {Store} from './db.ts';
import {createHash} from 'node:crypto';
import {matchJob,matchJobMajor} from './matching.ts';
import {jobPresentation} from '../shared/recruitment-report.ts';
import {positionFacts,sourceRows,type SourceCell} from '../shared/source-position.ts';
import {positionQuality} from './position-quality.ts';
import {todayCN} from '../shared/model.ts';

type Row={id:string;kind:string;data:string;version:number;updated_at:string};
type Entry={row:Omit<Row,'data'>;raw:string|null;digest:string;value:any};
const fingerprint=(value:string)=>createHash('sha256').update(value).digest('hex');
type Source={text:string;input:string;files:Map<string,Map<string,SourceCell[]>>};
const readers=new WeakMap<Store,RecruitmentReader>();

/** Process-local read model. No persisted verdicts; time-sensitive checks expire at Beijing midnight.
 * SQLite data_version observes worker/other-connection commits; total_changes observes
 * our own writes (including raw SQL and restore). Compare exact inputs after a commit
 * so a worker heartbeat does not discard unchanged, expensive eligibility calculations.
 */
class RecruitmentReader{
  private stamp='';
  private sequence=0;
  private rows=new Map<string,Entry>();
  private profileList:any[]=[];
  private sourceCache=new Map<string,{stamp:string;value:Source}>();
  private factsCache=new WeakMap<object,{source:Source;value:any}>();
  private matched=new WeakMap<object,{profiles:any[];source:Source;day:string;value:any}>();
  private majors=new WeakMap<object,{profiles:any[];source:Source;value:ReturnType<typeof matchJobMajor>}>();
  private derived=new WeakMap<object,{profiles:any[];source:Source;ann:any;value:any}>();
  private store:Store;
  constructor(store:Store){this.store=store;}
  refresh(){
    const db=this.store.db;
    // Never reuse a transaction-local snapshot after rollback. Older runtimes
    // without isTransaction still compare inputs, but skip the stamp shortcut.
    const stamp=JSON.stringify([db.prepare('PRAGMA data_version').get(),db.prepare('SELECT total_changes() n').get(),db.isTransaction===false?false:++this.sequence]);
    if(this.stamp===stamp)return;
    const records=db.prepare("SELECT * FROM records WHERE kind IN ('job','profile','announcement')").all() as Row[];
    const next=new Map<string,Entry>();
    for(const row of records){
      const old=this.rows.get(row.id);
      const digest=fingerprint(row.data),{data,...metadata}=row;
      next.set(row.id,old&&old.row.kind===row.kind&&old.digest===digest&&old.row.version===row.version&&old.row.updated_at===row.updated_at?old:{row:metadata,raw:data,digest,value:null});
    }
    this.rows=next;this.stamp=stamp;
    const profiles=this.list('profile');
    if(profiles.length!==this.profileList.length||profiles.some((p,i)=>p!==this.profileList[i]))this.profileList=profiles;
    for(const id of this.sourceCache.keys())if(!next.has(id))this.sourceCache.delete(id);
  }
  get(id:string){
    const entry=this.rows.get(id);if(!entry)return null;
    if(entry.value===null){
      entry.value={...JSON.parse(entry.raw!),id,...(entry.row.kind==='announcement'?{kind:entry.row.kind}:{}),version:entry.row.version,updatedAt:entry.row.updated_at};
      // Keep the parsed record and a digest, not a second full JSON copy.
      entry.raw=null;
    }
    return entry.value;
  }
  list(kind:string){return [...this.rows.values()].filter(e=>e.row.kind===kind).sort((a,b)=>b.row.updated_at.localeCompare(a.row.updated_at)).map(e=>this.get(e.row.id));}
  profiles(){return this.profileList;}
  source(id:string):Source{
    const cached=this.sourceCache.get(id);if(cached?.stamp===this.stamp)return cached.value;
    const ann=this.get(id);
    const files=(this.store.db.prepare("SELECT f.id,f.text,f.error,s.value parsed FROM files f LEFT JOIN settings s ON s.key='workbook-v2:'||f.id WHERE f.announcement_id=?").all(id) as any[]).filter(f=>!ann?.fileIds||ann.fileIds.includes(f.id));
    const text=[ann?.body||'',...files.map(f=>f.text)].join('\n[附件分隔]\n');
    const input=fingerprint(JSON.stringify([ann?.body,files]));
    let value=cached?.value.input===input?cached.value:null;
    if(!value){
      const indexed=new Map<string,Map<string,SourceCell[]>>();
      for(const f of files){
        const rows=sourceRows(f.text);
        if(f.parsed){
          let parsed:any;try{parsed=JSON.parse(f.parsed);}catch{parsed=null;}
          for(const t of parsed?.tables||[])for(const r of t.rows||[])rows.set(t.sheet+'\0'+r.row,r.fields||[]);
        }
        indexed.set(f.id,rows);
      }
      value={text,input,files:indexed};
    }
    this.sourceCache.set(id,{stamp:this.stamp,value});return value;
  }
  facts(item:any){
    if(!item.announcementId)return item;
    const source=this.source(item.announcementId),old=this.factsCache.get(item);
    if(old?.source===source)return old.value;
    const row=item.sourceRow;
    const fields=row?source.files.get(row.fileId)?.get(row.sheet+'\0'+row.row):undefined;
    const facts=fields?.length?positionFacts(fields):item.sourcePosition;
    const rowText=fields?.map(f=>`【${f.header}】${f.value}`).join(' | ')||'';
    const quality=positionQuality(item,facts,rowText);
    if(row&&row.sheet!=='网页岗位'&&!fields?.length)quality.issues.push('岗位原表行尚未读取');
    const value={...item,...(facts?{sourcePosition:facts}:{}),analysisQuality:{...quality,status:quality.issues.includes('岗位原表行尚未读取')?'partial':quality.status}};
    this.factsCache.set(item,{source,value});this.factsCache.set(value,{source,value});return value;
  }
  major(item:any){
    item=this.facts(item);
    const source=this.source(item.announcementId),old=this.majors.get(item);
    if(old&&old.profiles===this.profileList&&old.source===source)return old.value;
    const value=matchJobMajor(item,this.profileList,source.text);
    this.majors.set(item,{profiles:this.profileList,source,value});return value;
  }
  match(item:any){
    if(!item.announcementId)return item;
    item=this.facts(item);
    const source=this.source(item.announcementId),old=this.matched.get(item),day=todayCN();
    if(old&&old.profiles===this.profileList&&old.source===source&&old.day===day)return old.value;
    const value={...item,...matchJob(item,this.profileList,source.text)};
    this.matched.set(item,{profiles:this.profileList,source,day,value});return value;
  }
  job(item:any){
    if(!item.announcementId)return {...item,...jobPresentation(item)};
    const ann=this.get(item.announcementId),source=this.source(item.announcementId),matched=this.match(item),old=this.derived.get(matched);
    if(old&&old.source===source&&old.ann===ann)return old.value;
    const value={...matched,...jobPresentation(matched,ann)};
    this.derived.set(matched,{profiles:this.profileList,source,ann,value});return value;
  }
}
export function recruitmentReader(store:Store){
  let reader=readers.get(store);if(!reader){reader=new RecruitmentReader(store);readers.set(store,reader);}
  reader.refresh();return reader;
}

/** Only card fields travel with a list. Full evidence remains in the detail API. */
export function jobCardView(job:any){
  const keys=['id','version','updatedAt','title','organization','province','type','employerType','industry','announcementId','status','majorStatus','match','applicationStatus','displayTitle','displayOrganization','displayRegion','displayPositionCode','sourceAnnouncementTitle','majorSummary'];
  return Object.fromEntries(keys.filter(k=>job[k]!==undefined).map(k=>[k,job[k]]));
}

/** Omit raw analysis inputs and duplicate common qualifications from the screen response. */
export function announcementScreenView(report:any):Record<string,any>&{jobs:any[]}{
  const keys=['id','version','title','type','published','source','url','province','status','analysisStatus','analysisError','analysisPendingParts','analysisRecovery','analysisCoverage','sourceNeedsRefresh','calendarStatus','calendar','introduction','summary','uncertainties','candidates','reportReady','body','commonEligibilityChecks','commonEligibilityProfile','commonApplicationItems','applicationProcess'];
  const jobKeys=['id','version','title','organization','province','displayTitle','displayOrganization','displayRegion','displayPositionCode','sourceSerial','sourceRow','sourcePosition','degreeCheck','profileState','analysisQuality','eligibilityProfile','eligibilityCoverage','analysisIncomplete','majorStatus','majorReason','majorPaths','majorRequirements','specificEligibilityChecks','specificApplicationItems'];
  return {...Object.fromEntries(keys.filter(k=>report[k]!==undefined).map(k=>[k,report[k]])),jobs:report.jobs.map((job:any)=>Object.fromEntries(jobKeys.filter(k=>job[k]!==undefined).map(k=>[k,job[k]])))};
}
