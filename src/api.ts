export class ApiError extends Error {
  status:number;
  constructor(message:string,status=0){super(message);this.name='ApiError';this.status=status;}
}
export async function api<T=any>(path:string,options:RequestInit={},timeoutMs=30000):Promise<T> {
  const controller=new AbortController();let timedOut=false;
  const cancel=()=>controller.abort();
  if(options.signal?.aborted)cancel();else options.signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  try {
    const r=await fetch('/api'+path,{credentials:'same-origin',...options,signal:controller.signal,headers:{'Content-Type':'application/json',...options.headers}});
    const text=await r.text();let data:any;
    try{data=JSON.parse(text);}catch{throw new ApiError(path==='/settings/test'?`测试收到网页而非接口数据（HTTP ${r.status}），请稍后重试；已保存的配置保持不变。`:r.ok?'服务器返回了无法读取的数据，请稍后重试':`网站暂时无法连接（HTTP ${r.status}），请稍后重试`,r.status);}
    if(!r.ok)throw new ApiError(r.status===401&&path!=='/login'?'登录已过期，请重新登录':data.error||'操作未完成',r.status);
    return data;
  }catch(e){
    if(timedOut)throw new ApiError(path==='/settings/test'?'连接测试超时，请稍后重试；已保存的配置仍然保留。':path==='/settings/models'?'读取模型超时，请重试；已保存的接口和模型没有改变。':path.split('?')[0]==='/state'?'页面数据同步超时，正在等待重试。':'请求超时，请稍后重试；已保存的数据仍然保留。');
    if(e instanceof TypeError)throw new ApiError('网络连接暂时中断，请稍后重试');
    throw e;
  }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);}
}
