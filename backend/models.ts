import { z } from 'zod';
import { aiSettings, unseal, type Config } from './config.ts';
import type { Store } from './db.ts';
import { AppError } from './model.ts';
import { requestPublic } from './net.ts';

const inputSchema=z.object({baseUrl:z.string().trim().min(1).max(2000),key:z.string().trim().max(4000).optional()});
function baseAddress(value:string) {
  let u:URL;try{u=new URL(value);}catch{throw new AppError(400,'请填写有效的 HTTPS 接口地址');}
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new AppError(400,'API 地址须为 HTTPS，不能包含账号密码、查询参数或片段');
  return u.href.replace(/\/+$/,'').replace(/\/(chat\/completions|models)$/,'');
}

// Discovery uses the draft connection but never saves it or spends the chat quota.
export async function listModels(store:Store,config:Config,input:unknown) {
  const v=inputSchema.parse(input),base=baseAddress(v.baseUrl),saved=aiSettings(store);
  let key=v.key||'';
  if(!key) {
    if(!saved.baseUrl||base!==baseAddress(saved.baseUrl))throw new AppError(428,'接口地址已变更，请填写该接口的 API Key 后读取模型');
    const secret=store.getSetting('ai-secret','');
    if(!secret)throw new AppError(428,'请先填写 API Key，再读取模型');
    key=unseal(secret,config.masterKey);
  }
  const r=await requestPublic(base+'/models',{headers:{Authorization:'Bearer '+key,Accept:'application/json'},timeout:20000,maxBytes:2000000,redirects:0});
  if([404,405,501].includes(r.status))throw new AppError(422,'这个接口未提供模型列表，可手动填写服务商给出的模型 ID');
  if([401,403].includes(r.status))throw new AppError(422,'读取模型被拒绝，请检查 API Key 及其模型列表权限');
  if(r.status!==200)throw new AppError(502,`读取模型失败（HTTP ${r.status}），请稍后重试`);
  let data:any;try{data=JSON.parse(r.body.toString());}catch{throw new AppError(502,'接口没有返回有效的模型列表');}
  if(!Array.isArray(data.data))throw new AppError(502,'接口没有返回兼容的模型列表，可手动填写模型 ID');
  const ids:string[]=[...new Set<string>(data.data.map((m:any)=>m?.id).filter((id:unknown):id is string=>typeof id==='string'&&id.length>0&&id.length<=200&&!/[\u0000-\u0020\u007f]/.test(id)))].sort();
  if(!ids.length)throw new AppError(422,'接口返回的模型列表为空，请检查 Key 权限或手动填写模型 ID');
  return {models:ids.map(id=>({id}))};
}
