import {analysisRecovery} from './analysis-recovery.ts';
import type {Store} from './db.ts';
import {aiCooldown} from './ai-failure.ts';
const labels:Record<string,string>={running:'正在处理',pending:'等待处理',retry:'等待重试',waiting_quota:'等待额度恢复',waiting_config:'等待配置接口',error:'处理失败'};
export function queueStatus(store:Store){
  const cooldown=aiCooldown(store),cooling=!!cooldown&&cooldown.until>Date.now();
  const rows=store.db.prepare("SELECT id,type,state,attempts,error,payload,updated_at,available_at FROM jobs WHERE state!='done' ORDER BY CASE WHEN state='running' THEN 0 ELSE 1 END,updated_at LIMIT 100").all() as any[];
  return rows.map(row=>{
    let p:any={};try{p=JSON.parse(row.payload);}catch{}
    const record=p.id?store.get(p.id):null;
    let title=record?.displayTitle||record?.title||p.item?.title||p.sourceName||(row.type==='backup'?'每日数据备份':row.type==='agent'?'日历助手对话':'后台任务');
    const targetId=row.type==='agent'?store.getSetting<string>('recruitment-target:'+p.id,''):p.id;
    const cached=['analyze','agent'].includes(row.type)&&targetId?store.getSetting<any>('analysis:'+targetId,null):null;
    const work=cached&&(!cached.sourceHash||cached.sourceHash===store.get(targetId)?.contentHash)&&!(row.state==='pending'&&cached.index>=cached.segments?.length)?cached:null;
    const processed=work?.index||0,recovery=analysisRecovery(work),completed=recovery.saved,total=recovery.total,segment=work?.segments?.[processed];
    const target=row.type==='agent'&&targetId?store.get(targetId):record;
    if(row.type==='agent'&&target?.kind==='announcement')title=target.displayTitle||target.title;
    const phase=row.type==='analyze'||row.type==='agent'&&work?(segment?.imageId?'读取图片':segment?.table?'分析岗位要求':total&&completed>=total?'汇总岗位与日期':'分析公告与附件'):row.type==='detail'?'读取公告及岗位明细':row.type==='crawl'?`检查公告列表 · 第 ${p.page||1} 页`:row.type==='backup'?'保存数据备份':row.type==='follow'?'跟进考试时间':row.type==='agent'?'处理助手指令':'处理任务';
    const sourceName=record?.source||p.sourceName||'';
    const imageName=segment?.imageId?(store.db.prepare('SELECT name FROM files WHERE id=?').get(segment.imageId) as any)?.name:'';
    const partName=segment?.rows?.length?[...new Set(segment.rows.map((r:any)=>`${r.fileName} / ${r.sheet}`))].join('、'):imageName||segment?.partName||segment?.text?.match(/^附件 (.+?)(?:（文件|\n| 中的说明材料)/)?.[1]||(segment?.text?'公告正文':'');
    const serviceWait=cooling&&['analyze','agent','follow'].includes(row.type)&&['pending','retry'].includes(row.state);
    const nextAttempt=Math.max(row.available_at||0,serviceWait?cooldown!.until:0);
    return {id:row.id,type:row.type,state:row.state,stateLabel:serviceWait?'等待 AI 接口恢复':labels[row.state]||'待处理',title,phase,sourceName,partName,
      completed,total,unfinished:recovery.pending,parts:recovery.parts,attempts:row.attempts,error:row.error||(['pending','running'].includes(row.state)?target?.analysisError||'':''),updatedAt:row.updated_at,
      nextAttemptAt:(serviceWait||['retry','waiting_quota'].includes(row.state))&&nextAttempt?new Date(nextAttempt).toISOString():'',
      failure:['retry','error','waiting_config','waiting_quota'].includes(row.state)?store.getSetting('job-error:'+row.id,null):null,
      announcementId:target?.kind==='announcement'?target.id:'',
      description:serviceWait?'AI 接口暂时不可用，已保存进度，稍后自动继续':row.state==='running'?`${phase}${total?` · 第 ${Math.min(recovery.processed+1,total)} / ${total} 部分`:''}`:row.state==='pending'&&completed?`已保存 ${completed} / ${total} 部分，等待继续`:labels[row.state]||'等待处理'};
  });
}
