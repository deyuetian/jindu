// Recover a literal major quotation from the same parser-owned position row.
// The model may combine non-adjacent cells. Never accept a neighbouring row,
// a shortened exception, or a model-provided profession not present in the cell.
type Cell={header:string;value:string};
const compact=(s:string)=>s.replace(/\s/g,'');
const order=['专科','本科','硕士','博士'];
const degreePattern=/(博士研究生|硕士研究生|大学本科|大学专科|博士|硕士|本科|专科|学士|研究生)(及以上)?/g;

function levels(text:string):string[] {
  const found=[...compact(text).matchAll(degreePattern)];
  if(!found.length||/不含|不包括|不接受|不接收|不招收|除外|非全日制/.test(text))return [];
  return [...new Set(found.flatMap(m=>{
    if(m[1]==='研究生')return ['硕士','博士'];
    const level=m[1].replace(/大学|研究生/g,'').replace('学士','本科');
    return m[2]?order.slice(order.indexOf(level)):[level];
  }))];
}

function cells(text:string):Cell[] {
  return [...text.matchAll(/【([^】]+)】([\s\S]*?)(?= \| 【|$)/g)].map(m=>({header:m[1],value:m[2].trim()}));
}

function clauses(cell:Cell) {
  const markers=[...cell.value.matchAll(/(?:^|[\r\n；;])\s*((?:大\s*学\s*)?(?:专\s*科|本\s*科)|硕\s*士(?:\s*研\s*究\s*生)?|博\s*士(?:\s*研\s*究\s*生)?|研\s*究\s*生)\s*[:：]/g)];
  if(!markers.length)return [{text:cell.value,levels:levels(cell.header)}];
  // A shared prefix may contain an exception or a joint-degree condition.
  if(cell.value.slice(0,markers[0].index).trim())return [];
  return markers.map((m,i)=>({text:cell.value.slice(m.index,markers[i+1]?.index??cell.value.length).replace(/^[\r\n；;]+/,'').trim(),levels:levels(m[1])}));
}

export function normalizeTableEvidence<T extends Record<string,any>>(job:T,rowText?:string):T {
  if(!rowText||!job.sourceRowId)return job;
  const row=cells(rowText);
  const majors=row.filter(c=>/专业|学科/.test(c.header)&&!/院校|学校|经验|年限|职称|资格/.test(c.header));
  if(!majors.length)return job;
  const degreeCells=row.filter(c=>/学历|学位/.test(c.header));
  if(degreeCells.some(c=>/且|同时|均须|均需|均应|均为|均符合|均要求/.test(c.value)))return job;
  const degreeRanges=degreeCells.map(c=>levels(c.value)).filter(l=>l.length);
  const understood=degreeCells.every(c=>levels(c.value).length||/^(?:与最高学历相对应的学位|与学历相对应的学位|与学历相应的学位|相应学位|不限|无)$/.test(compact(c.value)));
  const allowed=understood&&degreeRanges.length?order.filter(l=>degreeRanges.every(r=>r.includes(l))):[];
  const replacements=new Map<string,{quote:string;levels:string[]}[]>();
  const requirements=(job.majorRequirements||[]).map((r:any)=>{
    if(typeof r.evidence!=='string'||!r.levels?.length)return r;
    const original=r.evidence.replace(/^\[[^\]\r\n]{1,120}\]\s*(?=【)/,'');
    const quoted=cells(original);
    // Every quoted column must be complete, or one complete degree clause.
    // This also verifies the degree cells the model used in its combined quote.
    if(quoted.length){
      if(!original.startsWith('【')||!quoted.every(q=>/学历|学位|专业|学科/.test(q.header)&&!/院校|学校|经验|年限|职称|资格/.test(q.header)&&row.some(c=>compact(c.header)===compact(q.header)&&(compact(c.value)===compact(q.value)||clauses(c).some(v=>compact(v.text)===compact(q.value))))))return r;
    }else if(!compact(rowText).includes(compact(original)))return r;
    const candidates=majors.flatMap(c=>clauses(c).map(v=>({...v,cell:c})));
    const matching=candidates.filter(v=>{
      const range=v.levels.length?(allowed.length?v.levels.filter(l=>allowed.includes(l)):v.levels):allowed;
      if(!range.length||!r.levels.every((l:string)=>range.includes(l)))return false;
      const text=compact(v.text);
      const quotedMajor=quoted.filter(q=>compact(q.header)===compact(v.cell.header));
      if(quoted.length&&!quotedMajor.some(q=>compact(q.value)===text||compact(q.value)===compact(v.cell.value)))return false;
      if(!quoted.length&&!compact(original).includes(text)&&!text.includes(compact(original)))return false;
      if(!(r.names?.length||r.codes?.length||r.unrestricted))return false;
      return (r.names||[]).every((n:string)=>text.includes(compact(n)))&&(r.codes||[]).every((code:string)=>new RegExp(`(^|[^0-9A-Za-z])${code.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}([^0-9A-Za-z]|$)`).test(v.text))&&(!r.unrestricted||/不限|不限制|不作限制/.test(v.text));
    });
    if(matching.length!==1)return r;
    const clause=matching[0];
    const quote=compact(clause.text).length<4&&compact(clause.text)===compact(clause.cell.value)?`【${clause.cell.header}】${clause.cell.value}`:clause.text;
    if(compact(quote).length<4)return r;
    replacements.set(r.evidence,[...(replacements.get(r.evidence)||[]),{quote,levels:r.levels}]);
    return {...r,evidence:quote};
  });
  return {...job,majorRequirements:requirements,catalogChecks:(job.catalogChecks||[]).map((c:any)=>{
    const quotes=[...new Set((replacements.get(c.requirementEvidence)||[]).filter(v=>v.levels.includes(c.level)).map(v=>v.quote))];
    return {...c,requirementEvidence:quotes.length===1?quotes[0]:c.requirementEvidence};
  })};
}
