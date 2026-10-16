import {join} from 'node:path';
import type {Store} from './db.ts';
import type {Config} from './config.ts';
import {AppError} from './model.ts';
import {fileTool} from './files.ts';

// The same CAU campus registration/stamping guide is reused across notices.
// Match content, not its URL: replacing that URL with an official notice must
// not silently hide the new image. Original files remain available to view.
const campusImageHashes=new Set(['41d362352bbe3f63f8f770686363d2ea695e43b838fd87bc8509b52ec503cb9a']);
export function isCampusGuidanceImage(file:any):boolean {
  if(!String(file.mime||'').startsWith('image/'))return false;
  return campusImageHashes.has(file.sha256)||/校内(?:报考|报名|办事|盖章|登记)?(?:提示|指南|流程|说明|须知|注意事项)/.test(String(file.name||''));
}
export function campusImageIds(files:any[]){return new Set<string>(files.filter(isCampusGuidanceImage).map(f=>f.id));}
export function campusImageWarning(message:string,files:any[]):boolean {
  // Several unrelated images can share the generic name “正文图片”. In that
  // case retain the warning instead of hiding an official image's failure.
  const named=files.filter(f=>message.startsWith(f.name+'：'));
  return named.length>0&&named.every(isCampusGuidanceImage);
}
export function omitCampusImageWork(work:any,files:any[]) {
  const ignored=campusImageIds(files);
  let omitted=false;
  for(const [i,segment] of (work.segments||[]).entries())if(ignored.has(segment.imageId)){
    const result=work.results?.[segment.resultIndex??i];
    if(result&&(result._imageId===segment.imageId||!result._imageId&&!result._source))result._retired=true;
    segment.outcome='omitted';segment.issues=[];delete segment.failure;omitted=true;
  }
  for(const result of work.results||[])if(ignored.has(result._imageId))result._retired=true;
  work.baseIssues=(work.baseIssues||work.issues||[]).filter((e:string)=>!campusImageWarning(e,files));
  // An exhausted image-only repair budget cannot hold up completed official
  // material. Keep the stop if any real section remains failed or unfinished.
  if(omitted&&(work.segments||[]).every((s:any)=>['complete','omitted'].includes(s.outcome)))work.stopped=false;
  return work;
}

const documentParserVersion=1;
/** Re-read failed Word extraction once per explicit analysis run/parser version.
 * No downloads or model requests. A failed attempt is cached until a manual
 * continuation resets it; normal segment ticks never loop over damaged files.
 */
export async function refreshUnreadDocuments(store:Store,config:Config,files:any[],readOnly=false){
  const resolvedWarnings:string[]=[];let changed=false;
  for(const file of files.filter(f=>/\.docx?$/i.test(f.name))){
    const key='document-read:'+file.id;
    const cached=store.getSetting<any>(key,null);
    const current=cached?.sha256===file.sha256&&cached?.name===file.name&&cached?.parserVersion===documentParserVersion;
    if(current&&cached.previousError&&file.text&&!file.error)resolvedWarnings.push(file.name+'：'+cached.previousError);
    if(readOnly||file.text?.trim()&&!file.error||current)continue;
    const previousError=file.error||'';
    let parsed:any;
    try{parsed=await fileTool(config,['parse',join(config.dataDir,'files',file.id),file.name]);}
    catch(error){parsed={error:error instanceof AppError?error.message:'文档暂时无法读取，原件已保存'};}
    const text=typeof parsed?.text==='string'?parsed.text:'';
    const error=parsed?.error||(text.trim()?'':'文档未读到文字，原件已保存，请核对是否为扫描件或受保护文件');
    // A parser failure must not discard previously recovered text.
    const nextText=text.trim()?text:file.text||'';
    store.db.prepare('UPDATE files SET text=?,error=? WHERE id=? AND sha256=?').run(nextText,error,file.id,file.sha256);
    store.setSetting(key,{sha256:file.sha256,name:file.name,parserVersion:documentParserVersion,previousError,readable:!error&&!!nextText,attemptedAt:new Date().toISOString()});
    if(!error&&nextText&&previousError)resolvedWarnings.push(file.name+'：'+previousError);
    changed||=file.text!==nextText||file.error!==error;
    file.text=nextText;file.error=error;
  }
  return {resolvedWarnings,changed};
}
