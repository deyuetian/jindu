import {positionFacts,type SourcePosition} from '../shared/source-position.ts';
import { join } from 'node:path';
import { fileTool } from './files.ts';
import { hash, type Config } from './config.ts';
import type { Store } from './db.ts';
import { majorHierarchy } from '../shared/majors.ts';
import { isMajorCatalog,tableCatalogReference,archiveDocuments,isCatalogDocument,documentCatalogReference,type ReferenceDocument } from './major-catalog.ts';

type Field={column:number;header:string;value:string};
type TableRow={row:number;fields:Field[];text:string};
type Table={sheet:string;headers:string[];rows:TableRow[];notes:[number,string[]][];complete:boolean;kind?:string;sourceName?:string};
type Parsed={text:string;error:string;tables:Table[];complete:boolean;extraText?:string;documents?:ReferenceDocument[];parserVersion?:number};
export type PositionRow={fileId:string;fileName:string;sheet:string;row:number;rowId:string;positionCode:string;text:string;title:string;organization:string;sourcePosition?:SourcePosition};
export type AnalysisSegment={text:string;depth:number;imageId:string;rows?:PositionRow[];table?:boolean;partName?:string};

export function prefilterRow(fields:Field[],profiles:any[],hasCatalog=false):'candidate'|'review'|'excluded' {
  const majorFields=fields.filter(f=>/专业|学科/.test(f.header)&&!/院校|学校|经验|年限|职称|资格/.test(f.header));
  const education=profiles.filter(p=>!p.archived).flatMap(p=>p.education||[]).map(majorHierarchy);
  if(!education.length||!majorFields.length)return 'review';
  const terms=education.flatMap(e=>[e.major,...(e.verified?[e.category,e.discipline,e.code,e.categoryCode,e.disciplineCode]:[])]).filter(Boolean);
  const text=majorFields.map(f=>f.value).join('；');
  if(terms.some(t=>/^[0-9A-Za-z]+$/.test(t)?new RegExp(`(^|[^0-9A-Za-z])${t}([^0-9A-Za-z]|$)`).test(text):text.includes(t)))return 'candidate';
  // This is a recall-oriented first pass. Ambiguous references must reach the AI.
  if(!text.trim()||/不限|不限制|不作限制|不设|所有专业|全部专业|任意专业|相关|相近|参照|参考|目录|详见|附件|见表|其他|同等|等专业|类专业|自设|交叉/.test(text))return 'review';
  if(education.some(e=>!e.verified))return 'review';
  if(hasCatalog)return 'review';
  // Only explicit closed lists can be rejected without semantic interpretation.
  const explicit=majorFields.every(f=>/^[\u4e00-\u9fffA-Za-z0-9\s、，,；;：:（）()\[\]【】.\/·-]+$/.test(f.value)&&f.value.length<1000);
  return explicit?'excluded':'review';
}

export async function tableSegments(store:Store,config:Config,files:any[],profiles:any[],options:{readOnly?:boolean}={}) {
  const segments:AnalysisSegment[]=[],issues:string[]=[],handled=new Set<string>();
  const stats={files:0,rows:0,candidates:0,excluded:0,review:0};
  const loaded:{file:any;parsed:Parsed}[]=[],references:string[]=[],resolvedWarnings:string[]=[];
  let hasCatalog=false;
  const catalogFileIds=new Set<string>();
  const addReference=(file:any,ref:{text:string;limited:boolean})=>{
    hasCatalog=true;catalogFileIds.add(file.id);
    if(references.reduce((n,s)=>n+s.length,0)+ref.text.length>36000){issues.push(file.name+'：专业目录相关摘录超过本次核对上限，未将未读内容当作已核对');return;}
    references.push(ref.text);if(ref.limited)issues.push(file.name+'：专业目录相关行较多，部分内容仍需核对原件');
  };
  for(const file of files.filter(f=>/\.(xlsx|xlsm|xls|zip)$/i.test(f.name))) {
    let parsed=store.getSetting<Parsed|null>('workbook-v2:'+file.id,null);
    const oldCatalog=parsed&&parsed.parserVersion!==3&&(parsed.tables?.some(t=>t.headers.length&&isMajorCatalog(file.name,t))||archiveDocuments(parsed).some(d=>isCatalogDocument(file.name,d)));
    if(!parsed||(oldCatalog&&!options.readOnly)) {
      if(options.readOnly)throw new Error('原表缓存缺失，不能进行只读补核检查');
      try{parsed=await fileTool(config,['parse',join(config.dataDir,'files',file.id),file.name]);}
      catch{
        issues.push(file.name+'：表格读取失败，岗位筛选未完成');
        if(!parsed){
          if(isCatalogDocument(file.name,{name:file.name,text:''})){handled.add(file.id);hasCatalog=true;catalogFileIds.add(file.id);}
          continue;
        }
      }
      if(parsed?.tables)store.setSetting('workbook-v2:'+file.id,parsed);
    }
    if(parsed&&!parsed.tables?.length&&!archiveDocuments(parsed).length&&isCatalogDocument(file.name,{name:file.name,text:''})){
      parsed={...parsed,documents:[{name:file.name,text:parsed.text||'',error:parsed.error}]};
    }
    if(!parsed||(!parsed.tables?.length&&!archiveDocuments(parsed).length))continue;
    parsed.tables||=[];
    loaded.push({file,parsed});
    for(const table of parsed.tables)if(isMajorCatalog(file.name,table)){
      addReference(file,tableCatalogReference(file,table,profiles));
    }
    for(const document of archiveDocuments(parsed))if(isCatalogDocument(file.name,document))addReference(file,documentCatalogReference(file.name,document,profiles));
  }
  for(const file of files.filter(f=>/\.(pdf|docx?|txt)$/i.test(f.name)&&f.text)) {
    const document={name:file.name,text:file.text,error:file.error};
    if(!isCatalogDocument(file.name,document))continue;
    loaded.push({file,parsed:{text:file.text,error:file.error||'',tables:[],documents:[document],complete:!file.error}});
    addReference(file,documentCatalogReference(file.name,document,profiles));
  }
  for(const {file,parsed} of loaded) {
    handled.add(file.id);stats.files++;
    // Upgrade only the derived text; retain the original file and digest unchanged.
    const referenceWarnings=new Set(parsed.tables.filter(t=>isMajorCatalog(file.name,t)).map(t=>t.sheet+'：未识别岗位表头，保留正文待分析'));
    resolvedWarnings.push(...[...referenceWarnings].map(w=>file.name+'：'+w));
    const errors=(parsed.error||'').split('；').filter(e=>e&&!referenceWarnings.has(e));
    if(file.error&&file.error!==errors.join('；'))resolvedWarnings.push(file.name+'：'+file.error);
    if(!options.readOnly)store.db.prepare('UPDATE files SET text=?,error=? WHERE id=?').run(parsed.text,errors.join('；'),file.id);
    file.text=parsed.text;file.error=errors.join('；');
    if(errors.length)issues.push(file.name+'：'+errors.join('；'));
    for(const document of archiveDocuments(parsed)){
      if(isCatalogDocument(file.name,document))continue;
      for(let i=0;i<document.text.length;i+=6000)segments.push({text:`附件 ${file.name} / ${document.name}\n${document.text.slice(i,i+6000)}`,depth:0,imageId:''});
    }
    for(const table of parsed.tables) {
      if(isMajorCatalog(file.name,table)){
        continue;
      }
      if(!table.complete){
        issues.push(`${file.name} / ${table.sheet}：表头未识别，无法确认岗位完整性`);
        const text=table.notes.map(([row,cells])=>`[${table.sheet} 第 ${row} 行] ${[...new Set(cells.filter(Boolean))].join(' | ')}`).join('\n');
        for(let i=0;i<text.length;i+=6000)segments.push({text:`未识别结构的附件 ${file.name}\n${text.slice(i,i+6000)}`,depth:0,imageId:''});
        continue;
      }
      const notes=table.notes.map(([row,cells])=>`[${table.sheet} 第 ${row} 行] ${cells.join(' | ')}`).join('\n');
      if(notes)for(let i=0;i<notes.length;i+=6000)segments.push({text:`附件 ${file.name} / ${table.sheet} 说明\n${notes.slice(i,i+6000)}`,depth:0,imageId:''});
      let batch:PositionRow[]=[];let size=0;
      const flush=()=>{if(batch.length)segments.push({text:batch.map(r=>`岗位行ID：${r.rowId}\n${r.text}`).join('\n\n'),depth:0,imageId:'',rows:batch,table:true});batch=[];size=0;};
      for(const row of table.rows) {
        stats.rows++;const verdict=prefilterRow(row.fields,profiles,hasCatalog);
        if(verdict==='excluded'){stats.excluded++;continue;}
        stats.candidates++;if(verdict==='review')stats.review++;
        const value=(pattern:RegExp)=>row.fields.find(f=>pattern.test(f.header.replace(/\s/g,'')))?.value||'';
        const record:PositionRow={fileId:file.id,fileName:file.name,sheet:table.sheet,row:row.row,rowId:hash(`${file.id}\0${table.sheet}\0${row.row}`).slice(0,32),positionCode:value(/(?:岗位|职位)(?:代码|编码|编号)/),title:value(/(?:岗位|职位)(?:名称)?$|职务名称/),organization:value(/单位名称|招录机关|招聘单位|用人单位|部门名称/),text:row.text,sourcePosition:positionFacts(row.fields)};
        if(row.text.length>16000)issues.push(`${file.name} ${table.sheet} 第 ${row.row} 行过长，待人工核对`);
        if(batch.length&&(size+row.text.length>5500||batch.length>=4))flush();
        batch.push(record);size+=row.text.length;
      }
      flush();
    }
  }
  // Document-wide instructions precede every table batch, regardless of sheet order.
  segments.sort((a,b)=>Number(!!a.table)-Number(!!b.table));
  return {segments,issues,handled,stats,referenceText:references.join('\n'),resolvedWarnings,catalogFileIds:[...catalogFileIds],catalogOnlyFiles:loaded.filter(({file,parsed})=>catalogFileIds.has(file.id)&&parsed.tables.every(t=>isMajorCatalog(file.name,t))&&archiveDocuments(parsed).every(d=>isCatalogDocument(file.name,d))).map(({file})=>({id:file.id,name:file.name}))};
}
