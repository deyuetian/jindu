import {createContext,useContext,useEffect,useState,type ReactNode} from 'react';
import type {ReadCache} from './read-cache';

export const ReadCacheContext=createContext<ReadCache|null>(null);
export function useReadResource<T>(path:string|null,interval=0){
  const cache=useContext(ReadCacheContext);
  if(!cache)throw new Error('Read cache provider missing');
  const [result,setResult]=useState<{path:string|null;data?:T;error:string;loading:boolean}>(()=>({path,data:path?cache.peek<T>(path):undefined,error:'',loading:!!path&&!cache.fresh(path)}));
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!path)return;
    let alive=true,request=0;
    const load=async(force=false)=>{
      const seq=++request,cached=cache.peek<T>(path);
      setResult(current=>({path,data:cached??(current.path===path?current.data:undefined),error:'',loading:force||!cache.fresh(path)}));
      try{const data=await cache.load<T>(path,force);if(alive&&seq===request)setResult({path,data,error:'',loading:false});}
      catch(e){if(alive&&seq===request&&(e as Error).name!=='AbortError')setResult(current=>({...current,error:(e as Error).message,loading:false}));}
    };
    void load(retry>0);
    const unsubscribe=cache.subscribe(()=>void load(true));
    const reload=()=>{if(document.visibilityState==='visible')void load(true);};
    const timer=interval?setInterval(reload,interval):undefined;
    if(interval){window.addEventListener('focus',reload);window.addEventListener('online',reload);document.addEventListener('visibilitychange',reload);}
    return()=>{alive=false;request++;unsubscribe();if(timer)clearInterval(timer);if(interval){window.removeEventListener('focus',reload);window.removeEventListener('online',reload);document.removeEventListener('visibilitychange',reload);}};
  },[cache,path,interval,retry]);
  const current=result.path===path?result:{path,data:path?cache.peek<T>(path):undefined,error:'',loading:!!path};
  return {...current,retry:()=>setRetry(n=>n+1)};
}
export function DetailResource({path,children}:{path:string;children:(data:any)=>ReactNode}){
  const {data,error,loading,retry}=useReadResource<any>(path,15000);
  return <>{error&&<div className="form-error" role="alert">{error} <button className="text-btn" onClick={retry}>重试</button></div>}{data?children(data):!error&&<p className="list-placeholder" role="status">正在读取详情…</p>}{data&&loading&&<span className="read-refresh-note" role="status">正在更新…</span>}</>;
}
