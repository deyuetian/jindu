import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';

export const sha256=(s:string)=>createHash('sha256').update(s).digest('hex');
export function equal(a:string,b:string):boolean { return timingSafeEqual(Buffer.from(sha256(a),'hex'),Buffer.from(sha256(b),'hex')); }
export async function passwordMatches(password:string, stored:string):Promise<boolean> {
  const parts=stored.split('$');
  // This format is exclusively for 192-bit CSPRNG-generated secrets, never human passwords.
  // The provisioning utility cannot accept a user-chosen password.
  if(parts.length!==4||parts[0]!=='random-v1'||parts[1]!=='192'||!/^[0-9a-f]{32}$/.test(parts[2])||!/^[0-9a-f]{64}$/.test(parts[3])||!/^[A-Za-z0-9_-]{32}$/.test(password))return false;
  const hash=sha256('jindu-login-v1\0'+parts[2]+'\0'+password);
  return timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(parts[3],'hex'));
}
export const newToken=()=>randomBytes(32).toString('hex');
export function localPreview(request:Request, flag:string):boolean { const u=new URL(request.url); return flag==='true'&&u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname); }
export function validOrigin(request:Request,appOrigin:string,local:boolean):boolean {
  const origin=request.headers.get('Origin');const expected=local?new URL(request.url).origin:appOrigin;
  return origin===expected && request.headers.get('Sec-Fetch-Site')!=='cross-site';
}
export function cookieName(local:boolean):string {return local?'jindu-local':'__Host-jindu';}
export function readCookie(request:Request,name:string):string { const values=(request.headers.get('Cookie')||'').split(';').map(x=>x.trim());const value=values.find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';return /^[a-f0-9]{64}$/.test(value)?value:''; }
export const cookie=(token:string,local:boolean,age=604800)=>`${cookieName(local)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${local?'':'; Secure'}`;
