import {majorHierarchy} from '../shared/majors.ts';

type ReferenceTable={sheet:string;sourceName?:string;kind?:string;notes:[number,string[]][];headers:string[];rows:any[]};
export type ReferenceDocument={name:string;text:string;error?:string};
const compact=(text:string)=>text.replace(/\s/g,'');
const catalog=/专业.{0,8}目录|学科.{0,8}目录|(?:本科|研究生|硕士|博士|职业教育).{0,8}目录|自主设置.{0,8}学科名单/;
const recruitmentHeader=/^(?:招聘|招录|拟聘|报考)?(?:岗位|职位)(?:名称|代码|编号|类别|序号)?$|^(?:招聘人数|招录人数|招聘计划|招考人数|拟聘人数)$/;
export function isMajorCatalog(fileName:string,table:ReferenceTable) {
  // A mixed archive may contain genuine positions as well as academic reference sheets.
  if(table.headers.some(h=>recruitmentHeader.test(compact(h))))return false;
  const heading=fileName+' '+table.sheet+' '+table.notes.slice(0,4).map(([,cells])=>cells.join(' ')).join(' ');
  return table.kind==='reference'||catalog.test(heading);
}
export function isCatalogDocument(fileName:string,document:ReferenceDocument) {
  const leaf=document.name.split(/[\\/]/).at(-1)||document.name;
  if(/报名|招聘|报考|岗位|推荐表|说明材料/.test(leaf)&&!catalog.test(leaf))return false;
  return catalog.test(leaf+' '+document.text.slice(0,600))||catalog.test(fileName);
}
// Old ZIP caches have no per-member document metadata. Recover boundaries, not arbitrary chunks.
export function archiveDocuments(parsed:{extraText?:string;documents?:ReferenceDocument[]}):ReferenceDocument[] {
  if(parsed.documents)return parsed.documents;
  const text=parsed.extraText||'',matches=[...text.matchAll(/^\[压缩附件 ([^\r\n]+)\]\r?\n/gm)];
  if(!matches.length)return text?[{name:'说明材料',text}]:[];
  const documents=matches.map((m,i)=>({name:m[1],text:text.slice(m.index!+m[0].length,matches[i+1]?.index??text.length)}));
  if(text.slice(0,matches[0].index).trim())documents.unshift({name:'说明材料',text:text.slice(0,matches[0].index)});
  return documents;
}
function termsFor(profiles:any[],includeParents=true) {
  return [...new Set(profiles.filter(p=>!p.archived).flatMap(p=>p.education||[]).map(majorHierarchy)
    .flatMap(e=>[e.major,...(includeParents&&e.verified?[e.category]:[])]).filter(Boolean).map(compact))];
}
function excerpt(name:string,lines:string[],profiles:any[]) {
  const terms=termsFor(profiles,!/自主设置.{0,8}学科名单/.test(name)).map(t=>new RegExp('(^|[^\\u3400-\\u9fffA-Za-z])'+t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'($|[^\\u3400-\\u9fffA-Za-z])')),selected=new Set<number>(),parents=new Map<number,number>();
  let matched=false;
  for(let i=0;i<lines.length;i++) {
    if(i<8)selected.add(i);
    const plain=lines[i].replace(/\[[^\]]*\]/g,'').trim(),code=/^(\d{2}|\d{4})\s+[^0-9]/.exec(plain);
    if(code){const size=code[1].length;parents.set(size,i);if(size===2)parents.delete(4);}
    if(terms.some(t=>t.test(compact(lines[i])))){
      matched=true;for(const row of parents.values())selected.add(row);
      for(let n=Math.max(0,i-2);n<=Math.min(lines.length-1,i+2);n++)selected.add(n);
    }
  }
  const prefix=`${name}（专业参考资料，不是招聘岗位；保留原始学历、目录版本和所在行，仅用于本公告。摘录未出现某专业不表示该专业不符合。）\n`;
  const result:string[]=[];let size=prefix.length,limited=false;
  for(const i of [...selected].sort((a,b)=>a-b)){
    if(size+lines[i].length+1>12000){limited=true;break;}
    result.push(lines[i]);size+=lines[i].length+1;
  }
  return {text:prefix+result.join('\n')+(matched?'':'\n未在已提取文字中检索到个人专业或已核实的上级类别，不能据此作否定结论。')+(limited?'\n相关原文较多，摘录未覆盖全部命中内容，须核对原件。':''),limited};
}
export function tableCatalogReference(file:any,table:ReferenceTable,profiles:any[]) {
  const rows:[number,string[]][]=[...table.notes,...table.rows.map(r=>[r.row,r.fields.map((f:any)=>`【${f.header}】${f.value}`)] as [number,string[]])];
  rows.sort((a,b)=>a[0]-b[0]);
  const lines=rows.map(([row,cells])=>`[${table.sheet} 第 ${row} 行] ${[...new Set(cells.filter(Boolean))].join(' | ')}`);
  if(table.headers.length)lines.unshift(`[${table.sheet} 表头] ${table.headers.join(' | ')}`);
  return excerpt(`附件 ${file.name} / ${table.sheet}`,lines,profiles);
}
export function catalogExcerpt(file:any,table:ReferenceTable,profiles:any[]) {
  return tableCatalogReference(file,table,profiles).text;
}
export function documentCatalogReference(fileName:string,document:ReferenceDocument,profiles:any[]) {
  return excerpt(`附件 ${fileName} / ${document.name}`,document.text.split(/\r?\n/),profiles);
}
