// These are presentation rules for saved facts, not new eligibility decisions.
const text = (value:unknown) => typeof value === 'string' ? value.trim() : '';
const compact = (value:unknown) => text(value).replace(/[\s，。；：、“”‘’《》【】（）()]/g, '');

export function isCampusService(item:any) {
  if (item.scope === 'campus') return true;
  const label = text(item.label), content = [label,item.detail,item.method].join(' ');
  // A required recommendation form remains a material. An office's stamp service
  // (location, opening hours or self-service machine) is not an application step.
  if (/推荐表|登记表|报名表/.test(label) && item.kind === 'material') return false;
  return /(?:就业创业办公室|就业指导(?:中心|部门)|学校党委(?:组织部)?|校党委组织部).*(?:公章|盖章|用印)/.test(label)
    || /(?:盖章|用印|公章)/.test(content) && /自助机|智能印章|一站式服务大厅|校内(?:办事|办理|盖章)|每周[一二三四五六日天].*(?:楼|办公室)/.test(content);
}

// Explicit labels take precedence over mentions of later stages in a description.
export function processRank(item:any):number {
  const rank=(s:string):number|undefined=>{
    if (/录用|聘用|签约|入职/.test(s)) return 130;
    if (/公示/.test(s)) return 120;
    if (/考察|政审/.test(s)) return 110;
    if (/体检/.test(s)) return 100;
    if (/资格复审|资格复核/.test(s)) return 80;
    if (/面试/.test(s)) return 90;
    if (/查.*成绩|成绩.*(?:查询|公布)|笔试成绩/.test(s)) return 70;
    if (/准考证/.test(s)) return 50;
    if (/笔试|在线测评|线上测评|能力测评/.test(s)) return 60;
    if (/缴费|报名确认/.test(s)) return 40;
    if (/资格初审|资格审核|报名审核|初选|简历筛选/.test(s)) return 30;
    if (/推荐表|推荐登记|学校推荐|报名准备|申请准备/.test(s)) return 10;
    if (/报名|投递|网申|内推|内部推荐|职位申请|简历提交/.test(s)) return 20;
    return undefined;
  };
  return rank(text(item.label)) ?? rank(text(item.phase)) ?? rank(text(item.detail)) ?? 500;
}

export function publicApplicationItems(items:any[] = []) {
  const identity=(item:any)=>item.kind==='procedure'&&/^(?:网上报名|在线报名|在线申请|网申投递)$/.test(text(item.label))?'网上报名':compact(item.label);
  const result:any[]=[];
  for (const item of items.filter(i=>!isCampusService(i))) {
    const same=result.findIndex(old=>old.kind===item.kind && (old.required!==false)===(item.required!==false)
      && text(old.phase)===text(item.phase) && text(old.deadline)===text(item.deadline)
      && compact(old.method)===compact(item.method)
      && identity(old)===identity(item)
      && compact(old.evidence)===compact(item.evidence));
    if (same<0) result.push(item);
    // Keep the complete description, never accumulate segment summaries.
    else if (text(item.detail).length>text(result[same].detail).length) result[same]=item;
  }
  return result;
}

/** Dated steps retain chronological order; undated steps follow the process. */
export function orderedApplicationItems(items:any[] = []) {
  const unique=publicApplicationItems(items);
  const dated=unique.filter(i=>/^\d{4}-\d{2}-\d{2}$/.test(i.deadline||''))
    .sort((a,b)=>a.deadline.localeCompare(b.deadline)||processRank(a)-processRank(b));
  const undated=unique.filter(i=>!/^\d{4}-\d{2}-\d{2}$/.test(i.deadline||''))
    .sort((a,b)=>processRank(a)-processRank(b));
  for (const item of undated) {
    const index=dated.findIndex(other=>processRank(other)>processRank(item));
    if (index<0) dated.push(item); else dated.splice(index,0,item);
  }
  return dated;
}
