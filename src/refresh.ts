// Focus, timer and manual refreshes share one request. Mutations request a newer
// snapshot after any read already in progress; logout invalidates late results.
export function createRefreshCoordinator<T>(load:(signal:AbortSignal)=>Promise<T>,onValue:(data:T)=>void,onStart:()=>void,onError:(error:unknown)=>void) {
  let pending:Promise<void>|null=null,controller:AbortController|null=null,epoch=0;
  function refresh(afterWrite=false):Promise<void> {
    if(pending){const version=epoch;return afterWrite?pending.catch(()=>{}).then(()=>{if(version===epoch)return refresh();}):pending;}
    const version=epoch;controller=new AbortController();const signal=controller.signal;onStart();
    const request=Promise.resolve().then(()=>load(signal)).then(data=>{if(version===epoch)onValue(data);}).catch(error=>{if(version===epoch){onError(error);throw error;}}).finally(()=>{if(version===epoch){pending=null;controller=null;}});
    pending=request;return request;
  }
  return {refresh,reset(){epoch++;controller?.abort();controller=null;pending=null;}};
}
