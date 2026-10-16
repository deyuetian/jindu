import { z } from 'zod';
import { AppError } from './model.ts';
import type { Store } from './db.ts';
import {calendarExamView} from '../shared/calendar-policy.ts';

type Request = { focus:boolean; calendar:boolean; subject:string; subjects:string[]; partial:boolean };
type Target = { key:string; announcementId:string; title:string; aliases:string[]; examIds:string[] };
type Result = { reply:string; examId?:string; before?:string; actionVersion?:number };
const focusWords=/(?:关注|收藏|拟投递)/;
const calendarWords=/(?:日历|日程)/;
const removeWords=/(?:取消|撤销|删掉|删除|移除|去掉|清除|取关|不再关注)/;
const normalize=(text:string)=>text.replace(/[\s\p{P}]/gu,'').replace(/([省市])(?=20\d{2}|定向|选调|招聘|考试|公务员)/g,'').replace(/年度?/g,'');

function normalizeCalendarLocation(text:string) {
  // These are two views of the same calendar, not two announcements. Only
  // normalize an explicit removal from these views, never chat-history edits.
  const calendar='(?:日历|日程)(?:里面|里|中|内)?',assistant='AI\\s*助手(?:里面|里|中|内)?';
  const join='\\s*(?:和|以及|及|、)\\s*';
  const end='(?=\\s*(?:(?:也|都|一并|一起|同时)\\s*)*(?:删掉|删除|移除|去掉|清除)\\s*(?:[，,。；;！!\\n]|$))';
  return text.replace(new RegExp(`(?:${calendar}${join}${assistant}|${assistant}${join}${calendar})${end}`,'gi'),'日历');
}

// Only the current, explicit user message can authorize these changes. A model
// plan, a previous message or text inside a source document is not authorization.
function request(text:string):Request|null {
  if(/^(?:请|帮我)?撤销(?:刚才|刚刚|上次|上一次|之前|这次|本次)?(?:的)?(?:修改|操作|取消|删除|移除|取关)/.test(text.trim()))return null;
  if(!removeWords.test(text)||(!focusWords.test(text)&&!calendarWords.test(text)))return null;
  if(/(?:不要执行|不要操作|先别动|先不执行|先不操作|暂不操作|只(?:想)?(?:询问|咨询|解释)|只问|先解释|先说明)/.test(text))return {focus:false,calendar:false,subject:'',subjects:[],partial:false};
  const clauses=text.split(/[，,。；;！!\n]|但是|不过|但/).map(s=>s.trim()).filter(Boolean);
  let focus=false,calendar=false,subject='',partial=false;const subjects:string[]=[];
  for(const clause of clauses) {
    if(!removeWords.test(clause))continue;
    // Negated clauses are ignored individually so “取消关注，但不要删除日历”
    // cancels only attention. Questions, quotations and hypothetical requests do
    // not authorize changes; a separate explicit clause may still do so.
    if(/(?:不要|别|暂不|先不|不必|不用|不能|不想|并非|不是要).{0,12}(?:取消|撤销|删|移除|去掉|清除|取关)|不(?:取消|撤销|删除|删掉|移除)/.test(clause))continue;
    if(/(?:如何|怎么|怎样|如果|假如|假设|要是|是否|能否|会不会|会怎样|什么意思|说过|说了|写着|例如|比如|示例|测试|演示)/.test(clause)||/(?:网页|附件|原文|文档|公告中|公告上|他|她).{0,8}(?:说|要求|写|提示)/.test(clause)||/(?:会|能).*[吗么]$/.test(clause)||/[？?]$/.test(clause)||/[“「『]\s*(?:取消|撤销|删掉|删除|移除|不再关注)/.test(clause))continue;
    const f=focusWords.test(clause);
    const c=calendarWords.test(clause);
    const both=/(?:及其|以及|连同|和对应|及对应|和它的|和他的|及它的|及他的).*(?:日历|日程)/.test(clause);
    focus ||= f||both;
    calendar ||= c;
    partial ||= c&&/(?:笔试|面试|报名|准考证|成绩|节点|进程|事项)/.test(clause)&&!/(?:所有|全部|整个|对应|及其)/.test(clause);
    {
      let candidate=clause.replace(/^(?:请|麻烦|帮我|请帮我|把|将|我想|我要|我希望|现在|同时|再|也|还要|只|仅|并且|并|顺便)+/g,'');
      candidate=candidate.replace(/^(?:不再关注|取消(?:收藏)?关注|撤销(?:收藏)?关注|取消收藏|取消拟投递|取关|取消|撤销|删掉|删除|移除|去掉|清除)\s*/,'');
      candidate=candidate.split(/(?:及其|以及|连同|和对应|及对应|和它的|和他的|及它的|及他的)/)[0];
      candidate=candidate.replace(/从\s*(?:日历|日程)(?:里面|里|中|内)?\s*(?:(?:也|都|一并|一起|同时)\s*)*(?:删掉|删除|移除|去掉|清除)\s*$/,'');
      candidate=candidate.replace(/(?:的)?(?:收藏关注|关注|收藏|拟投递|日历|日程).*/, '').replace(/(?:都|也|一并|同时|的|及其|对应的|对应|里面|内的)+$/g,'').replace(/^(?:把|将)/,'').trim();
      if(candidate&&!/^(?:它|他|她|其|该|这个|那个|对应|关联)$/.test(candidate)){subjects.push(candidate);subject ||= candidate;}
    }
  }
  return {focus,calendar,subject,subjects,partial};
}

function targets(store:Store):Target[] {
  // Do not load announcement bodies, attachments or complete job analyses into
  // the planner just to resolve a name.
  const announcements=store.prepare("SELECT id,json_extract(data,'$.title') title,json_extract(data,'$.displayTitle') displayTitle FROM records WHERE kind='announcement'").all() as any[];
  const result=new Map<string,Target>();
  for(const a of announcements)result.set(a.id,{key:a.id,announcementId:a.id,title:a.displayTitle||a.title,aliases:[a.title,a.displayTitle].filter(Boolean),examIds:[]});
  for(const e of store.list('exam').filter(e=>e.calendarKind!=='personal')) {
    const linked=e.announcementId&&result.get(e.announcementId);
    const key=linked?.key||e.id;
    const t=linked||result.get(key)||{key,announcementId:'',title:e.title,aliases:[],examIds:[]};
    t.aliases.push(e.title);t.examIds.push(e.id);result.set(key,t);
  }
  return [...result.values()];
}
function matches(target:Target,subject:string) {
  const query=normalize(subject);
  if(query.length<2)return false;
  // Ordered, complete keywords allow 湖南定向 / 北京优培 without guessing a
  // different year, region or similarly named announcement.
  const words=query.split(/(20\d{2}|定向|选调|优培|招聘|校招|校园|计划|公告|考试|公务员)/).filter(Boolean);
  return target.aliases.some(name=>{
    let remaining=normalize(name);
    return words.every(word=>{const index=remaining.indexOf(word);if(index<0)return false;remaining=remaining.slice(index+word.length);return true;});
  });
}

const patchSchema=z.object({id:z.string().max(120),kind:z.enum(['job','exam']),version:z.number().int().positive(),
  status:z.enum(['关注','拟投递']).optional(),archived:z.boolean().optional(),trackingEnabled:z.boolean().optional()});
const undoSchema=z.object({type:z.literal('recruitment-management'),records:z.array(patchSchema).min(1).max(500)});

/** Returns false for other assistant capabilities. finish runs in the SAME
 * transaction as all mutations, so interruption never leaves half a request. */
export function manageRecruitmentRequest(store:Store,text:string,finish:(result:Result)=>void,guard?:()=>void):boolean {
  text=normalizeCalendarLocation(text);
  const action=request(text);if(!action)return false;
  if(!action.focus&&!action.calendar){finish({reply:'可以直接说明公告名称，以及要取消关注、暂停跟进或移除日历。本次未作修改。'});return true;}
  if(/(?:改到|改成|改为|改期|新建|新增|加入|添加|恢复|重新关注|设为)/.test(text)){finish({reply:'这条请求还包含新增或修改安排，请与取消关注、移除日历分开说明，避免只完成一部分。本次未作修改。'});return true;}
  if(!action.subject||action.partial){finish({reply:action.partial?'请说明要移除整个公告的日历，还是其中哪一个时间节点。本次未作修改。':'请告诉我要处理的公告完整名称，我会按你的要求取消关注或移除对应日历。本次未作修改。'});return true;}
  if(/(?:日历|日程|关注|收藏)(?:都)?\s*(?:和|以及|及|并|、)\s*(?!日历|日程|关注|收藏|拟投递|取消|删|移除|停止)[\u4e00-\u9fffA-Za-z0-9]/.test(text)) {
    finish({reply:'本次包含多个对象，请分别说明每份公告及要取消关注或移除的日历，避免改动范围不一致。本次未作修改。'});return true;
  }
  // A named job or a selected subset must never expand into all jobs in its
  // parent announcement. This route acts on an explicitly named announcement.
  const known=targets(store),exact=known.filter(t=>t.aliases.some(a=>normalize(a)===normalize(action.subject)));
  if(!exact.length&&/(?:岗位|职位|第\s*[一二三四五六七八九十\d]+\s*项)/.test(action.subject)){finish({reply:'请在对应岗位卡片取消关注；如果要处理整份公告，请说明公告名称及是否移除它的日历。本次未作修改。'});return true;}
  const found=exact.length?exact:known.filter(t=>matches(t,action.subject));
  const personal=store.list('exam').some(e=>e.calendarKind==='personal'&&!e.archived&&matches({key:e.id,announcementId:'',title:e.title,aliases:[e.title],examIds:[e.id]},action.subject));
  if(personal&&!action.focus) {
    if(!found.length)return false; // Preserve the existing personal-calendar flow.
    finish({reply:'这个名称同时对应个人日程和公告日历，请说明要处理哪一项。本次未作修改。'});return true;
  }
  if(found.length!==1){finish({reply:found.length?'找到多条对应公告，请补充完整名称或年份：\n'+found.slice(0,6).map(t=>'• '+t.title).join('\n'):'没有找到唯一对应的公告或考试日历，请补充已保存的完整名称。本次未作修改。'});return true;}
  const target=found[0];
  if(action.subjects.some(s=>!matches(target,s))){finish({reply:'这次请求涉及的公告名称不一致，请分别说明每份公告要做的操作。本次未作修改。'});return true;}
  store.transaction(()=>{
    guard?.();
    const changes:z.infer<typeof patchSchema>[]=[];
    let jobs=0,calendars=0,nodes=0,paused=0;
    if(action.focus&&target.announcementId) {
      const focused=store.prepare("SELECT id FROM records WHERE kind='job' AND json_extract(data,'$.announcementId')=? AND json_extract(data,'$.status') IN ('关注','拟投递') AND COALESCE(json_extract(data,'$.archived'),0)=0").all(target.announcementId) as {id:string}[];
      for(const ref of focused) {
        const old=store.get(ref.id),saved=store.put(old.id,'job',{...old,status:'未选择'},old.version);
        changes.push({id:old.id,kind:'job',version:saved.version,status:old.status});jobs++;
      }
    }
    for(const id of target.examIds) {
      const old=store.get(id);if(!old||old.archived)continue;
      const pause=!!old.tracking?.enabled;
      if(!action.calendar&&!pause)continue;
      const saved=store.put(id,'exam',{...old,archived:action.calendar?true:old.archived,tracking:old.tracking?{...old.tracking,enabled:false}:undefined},old.version);
      changes.push({id,kind:'exam',version:saved.version,...(action.calendar?{archived:!!old.archived}:{}),...(pause?{trackingEnabled:true}:{})});
      if(action.calendar){calendars++;nodes+=calendarExamView(old).stages.filter((s:any)=>s.date).length;}if(pause)paused++;
    }
    const before=changes.length?JSON.stringify(undoSchema.parse({type:'recruitment-management',records:changes})):'';
    if(before.length>100000)throw new AppError(400,'本次涉及的记录过多，请分次处理');
    const details=[target.title+'：',
      action.focus?(jobs?`已取消 ${jobs} 个岗位的关注。`:'该公告下没有仍在关注的岗位。'):'',
      action.calendar?(calendars?`已从日历移除 ${calendars} 项安排、${nodes} 个有日期的节点。`:'没有仍在日历中显示的关联安排，没有新增改动。'):'原有日历节点保留。',
      paused?'已停止自动跟进。':'',
      action.calendar&&calendars?'已从助手的“已选考试”列表移除。':'',
      action.calendar&&calendars?'日历订阅会在下次刷新时同步移除；公告和岗位资料保留。':'',
      /(?:指令|口令).*(?:什么|怎么)/.test(text)?'不需要专用指令，直接说明要处理的公告和操作即可。':''].filter(Boolean);
    finish({reply:details.join('\n'),examId:target.examIds[0]||'',before,actionVersion:changes[0]?.version||0});
  });
  return true;
}

/** Called inside the caller's transaction. Refuse the whole undo if any saved
 * record has changed, preserving subsequent manual edits and worker updates. */
export function undoRecruitmentManagement(store:Store,before:string):boolean {
  if(!before)return false;
  const value=JSON.parse(before);
  if(value.type!=='recruitment-management')return false;
  const undo=undoSchema.parse(value);
  const current=undo.records.map(p=>({patch:p,record:store.get(p.id)}));
  if(current.some(({patch,record})=>!record||record.kind!==patch.kind||record.version!==patch.version))throw new AppError(409,'关注或日历此后已有修改，为保留后续内容，本次未撤销，请在对应页面调整');
  for(const {patch,record} of current)store.put(record.id,record.kind,{...record,
    ...(patch.status===undefined?{}:{status:patch.status}),...(patch.archived===undefined?{}:{archived:patch.archived}),
    ...(patch.trackingEnabled===undefined?{}:{tracking:{...record.tracking,enabled:patch.trackingEnabled}})},record.version);
  return true;
}
