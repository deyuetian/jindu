import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from './model.ts';
import {networkFailure} from './ai-failure.ts';

export function publicIP(ip:string):boolean {
  if(ip.includes(':')) {
    const a=ip.toLowerCase();
    if(a.startsWith('::ffff:'))return publicIP(a.slice(7));
    return /^[23][0-9a-f]{3}:/.test(a)&&!a.startsWith('2001:db8:');
  }
  const p=ip.split('.').map(Number);if(p.length!==4||p.some(x=>!Number.isInteger(x)||x<0||x>255))return false;
  return !(p[0]===0||p[0]===10||p[0]===127||p[0]>=224||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&p[1]===168||p[0]===100&&p[1]>=64&&p[1]<=127||p[0]===198&&(p[1]===18||p[1]===19)||p[0]===192&&p[1]===0);
}
export async function requestPublic(address:string, options:{method?:string;headers?:Record<string,string>;body?:string;maxBytes?:number;timeout?:number;redirects?:number}={}):Promise<{status:number;headers:http.IncomingHttpHeaders;body:Buffer;url:string}> {
  const u=new URL(address);
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.hash)throw new AppError(400,'只允许不含账号密码的 HTTP/HTTPS 地址');
  const host=u.hostname.replace(/^\[|\]$/g,'');
  const started=Date.now(),timeout=options.timeout||25000;
  const resolved=isIP(host)?[{address:host,family:isIP(host)}]:await new Promise<{address:string;family:number}[]>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('连接超时')),timeout);
    lookup(host,{all:true}).then(resolve,reject).finally(()=>clearTimeout(timer));
  });
  if(!resolved.length||resolved.some(r=>!publicIP(r.address)))throw new AppError(400,'不能连接内网、回环或保留地址');
  const ip=resolved.find(r=>r.family===4)||resolved[0];
  const result=await new Promise<{status:number;headers:http.IncomingHttpHeaders;body:Buffer;url:string}>((resolve,reject)=>{
    const req=(u.protocol==='https:'?https:http).request(u,{method:options.method||'GET',headers:{'User-Agent':'JinduPersonalPlanner/1.0',...options.headers},lookup:((_hostname:any,_opts:any,cb:any)=>_opts?.all?cb(null,[ip]):cb(null,ip.address,ip.family)) as any},res=>{
      const chunks:Buffer[]=[];let size=0;
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>(options.maxBytes||16000000)){res.destroy(new AppError(413,'响应超过允许大小'));return;}chunks.push(chunk);});
      res.on('end',()=>resolve({status:res.statusCode||500,headers:res.headers,body:Buffer.concat(chunks),url:u.href}));res.on('error',reject);
    });
    const deadline=setTimeout(()=>req.destroy(new Error('连接超时')),Math.max(1,timeout-(Date.now()-started)));
    req.on('close',()=>clearTimeout(deadline));req.on('error',reject);if(options.body)req.write(options.body);req.end();
  });
  if([301,302,303,307,308].includes(result.status)) {
    const n=options.redirects??3;
    if(n<=0||!result.headers.location)throw new AppError(502,'接口返回重定向，请填写最终地址');
    // Never forward API credentials to a redirected endpoint.
    if(options.headers?.Authorization)throw new AppError(502,'模型接口不能重定向，请填写最终地址');
    return requestPublic(new URL(result.headers.location,u).href,{...options,redirects:n-1});
  }
  return result;
}
export function safeError(e:unknown):string {
  if(e instanceof AppError)return e.message;
  const network=networkFailure(e);if(network)return network.message.replace(/^AI 接口/,'远端服务');
  if(e instanceof Error&&/timeout|超时|ETIMEDOUT/i.test(e.message))return '连接超时，稍后重试';
  return '请求未完成，请检查连接或稍后重试';
}
