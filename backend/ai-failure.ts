import {createHash} from 'node:crypto';
import {AppError} from './model.ts';
import type {Store} from './db.ts';

export type FailureCode='rate_limit'|'unavailable'|'timeout'|'dns'|'connection'|'tls'|'auth'|'quota'|'request';
const messages:Record<FailureCode,string>={rate_limit:'AI 接口暂时限制请求',unavailable:'AI 服务暂时不可用',timeout:'AI 接口连接超时',dns:'AI 接口域名暂时无法解析',connection:'AI 接口连接中断或无法建立',tls:'AI 接口的安全证书或加密连接异常',auth:'AI 接口认证失败，请检查 Key 和访问权限',quota:'AI 接口额度或余额不足，请检查服务商账户',request:'AI 接口拒绝了请求，请检查接口地址和模型设置'};
export class AIServiceError extends AppError {
  code:FailureCode;retryable:boolean;httpStatus?:number;retryAfterMs:number;transportCode?:string;
  constructor(code:FailureCode,retryable:boolean,httpStatus?:number,retryAfterMs=0,transportCode?:string){super(code==='auth'?428:502,messages[code]+(httpStatus?`（HTTP ${httpStatus}）`:''));this.code=code;this.retryable=retryable;this.httpStatus=httpStatus;this.retryAfterMs=retryAfterMs;this.transportCode=transportCode;}
}
export class AIServicePaused extends AppError {
  until:number;
  constructor(until:number){super(503,'AI 接口正在等待恢复，已保存请求，稍后自动继续');this.until=until;}
}
export function networkFailure(error:unknown):AIServiceError|undefined {
  if(!(error instanceof Error))return;
  const cause=(error as Error&{cause?:{code?:string}}).cause;
  const code=String((error as Error&{code?:string}).code||cause?.code||'');
  if(['EAI_AGAIN','ENOTFOUND','EAI_FAIL'].includes(code))return new AIServiceError('dns',true,undefined,0,code);
  if(['ETIMEDOUT','ESOCKETTIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code)||/timeout|连接超时/i.test(error.message))return new AIServiceError('timeout',true,undefined,0,code||'TIMEOUT');
  if(['ECONNRESET','ECONNREFUSED','EPIPE','ENETUNREACH','EHOSTUNREACH','UND_ERR_SOCKET'].includes(code))return new AIServiceError('connection',true,undefined,0,code);
  if(/^(?:CERT_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$|SELF_SIGNED_CERT_IN_CHAIN$)/.test(code))return new AIServiceError('tls',false,undefined,0,code);
}
export function httpFailure(status:number,data:unknown,retryAfter?:string,at=Date.now()) {
  // Inspect only structured provider codes. Never retain response bodies, URLs or keys.
  const e=(data as {error?:{code?:string;type?:string}}|null)?.error;
  const quota=[e?.code,e?.type].some(v=>typeof v==='string'&&/^(insufficient_quota|quota_exceeded|insufficient_balance|balance_not_enough)$/.test(v));
  const code:FailureCode=quota?'quota':status===429?'rate_limit':[401,403].includes(status)?'auth':status===408?'timeout':status>=500?'unavailable':'request';
  const seconds=retryAfter?.trim(),delay=seconds&&/^\d+$/.test(seconds)?Number(seconds)*1000:seconds?Date.parse(seconds)-at:0;
  return new AIServiceError(code,['rate_limit','unavailable','timeout'].includes(code),status,Number.isFinite(delay)?Math.max(0,Math.min(delay,86400000)):0);
}
type Cooldown={fingerprint:string;failures:number;until:number;code:FailureCode};
const serviceDelays=[60000,120000,300000];
const rateLimitDelays=[60000,120000,300000,600000,900000];
export const transientAttemptLimit=6;
function fingerprint(store:Store) {
  const ai=store.getSetting<{baseUrl?:string;model?:string}>('ai',{});
  return createHash('sha256').update(JSON.stringify([ai.baseUrl,ai.model,store.getSetting('ai-secret','')])).digest('hex');
}
export function aiCooldown(store:Store):Cooldown|null {
  const value=store.getSetting<Cooldown|null>('ai-retry-cooldown',null);
  return value?.fingerprint===fingerprint(store)?value:null;
}
export function postponeAI(store:Store,error:AIServiceError,at=Date.now()) {
  const previous=aiCooldown(store),failures=(previous?.failures||0)+1;
  const delays=error.code==='rate_limit'?rateLimitDelays:serviceDelays;
  const until=at+Math.max(error.retryAfterMs,delays[Math.min(failures-1,delays.length-1)]);
  store.setSetting('ai-retry-cooldown',{fingerprint:fingerprint(store),failures,until,code:error.code});
  return until;
}
export function markAIWait(store:Store,jobId:string,until:number){
  const cooldown=aiCooldown(store);if(!cooldown||cooldown.until!==until)return;
  store.setSetting('ai-wait:'+jobId,{fingerprint:cooldown.fingerprint,until});
}
export function clearAICooldown(store:Store,expected:Cooldown|null=aiCooldown(store)) {
  const current=aiCooldown(store);
  // A request started before a newer failure must not erase that new backoff.
  if(!expected||!current||JSON.stringify(current)!==JSON.stringify(expected))return;
  store.transaction(()=>{
    const waiting=store.prepare("SELECT j.id,j.available_at,s.value FROM jobs j JOIN settings s ON s.key='ai-wait:'||j.id WHERE j.state='retry' AND j.type IN ('analyze','agent','follow')").all() as any[];
    for(const row of waiting){
      const marker=JSON.parse(row.value);
      if(marker.fingerprint!==current.fingerprint||row.available_at!==marker.until)continue;
      // Only this provider's explicit waits are released. Preserve attempt
      // counts, terminal errors, local quotas and unrelated scheduled work.
      store.prepare("UPDATE jobs SET available_at=0 WHERE id=? AND state='retry' AND available_at=?").run(row.id,marker.until);
      store.prepare('DELETE FROM settings WHERE key=?').run('ai-wait:'+row.id);
    }
    store.prepare("DELETE FROM settings WHERE key='ai-retry-cooldown'").run();
  });
}
