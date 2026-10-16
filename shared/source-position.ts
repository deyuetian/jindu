/** Parser-owned facts. A missing model answer must never erase these cells. */
export type SourceCell={column?:number;header:string;value:string};
export type SourcePosition={education:string;major:string;count:string;location:string;description:string;fields?:SourceCell[]};
const compact=(s:string)=>s.replace(/\s/g,'');
export function sourceCells(text:string):SourceCell[]{
  return [...text.matchAll(/【([^】]+)】([\s\S]*?)(?= \| 【|$)/g)].map(m=>({header:m[1],value:m[2].trim()}));
}
export function positionFacts(fields:SourceCell[]):SourcePosition{
  const select=(test:(header:string)=>boolean)=>fields.filter(f=>test(compact(f.header))&&f.value.trim());
  const text=(items:SourceCell[])=>items.length>1?items.map(f=>compact(f.header)+'：'+f.value).join('；'):items[0]?.value||'';
  const majors=select(h=>/专业|学科/.test(h)&&!/院校|学校|经验|年限|职称|资格/.test(h));
  return {
    education:text(select(h=>/学历|学位/.test(h)&&!/学校|院校/.test(h))),major:text(majors),
    count:text(select(h=>/人数|名额|计划数/.test(h))),
    location:select(h=>/^(?:工作地点|工作地区|工作地|岗位所在地|职位所在地|招录地区|招考地区|地区|地域|省份|城市|市州|(?:选调|招录|招考)?市[（(]州[）)]|地市|工作省份|工作城市)$/.test(h)).map(f=>f.value).join('、'),
    description:text(select(h=>/任职|资格|条件|要求|备注|职责|描述/.test(h)&&!/学历|学位|专业|学科/.test(h))),
    fields:fields.map(f=>({...f})),
  };
}
/** Index complete rows, including newlines inside headers and cells. File scope is mandatory. */
export function sourceRows(text:string):Map<string,SourceCell[]>{
  const out=new Map<string,SourceCell[]>(),markers=[...text.matchAll(/^\[([^\]\r\n]+) 第 (\d+) 行\] /gm)];
  for(let i=0;i<markers.length;i++){
    const m=markers[i],key=m[1]+'\0'+m[2];
    const cells=sourceCells(text.slice(m.index!+m[0].length,markers[i+1]?.index??text.length).trim());
    // Duplicate addresses are ambiguous; do not borrow one occurrence's data.
    out.set(key,out.has(key)?[]:cells);
  }
  return out;
}
