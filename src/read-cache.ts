type Entry={data?:any;expires:number;pending?:Promise<any>;controller?:AbortController};

/** Bounded memory in one signed-in app, never localStorage or a shared HTTP cache. */
export function createReadCache(load:(path:string,signal:AbortSignal)=>Promise<any>,ttl=15000,capacity=24){
  const entries=new Map<string,Entry>(),listeners=new Set<()=>void>();let generation=0;
  const trim=()=>{for(const [key,e] of entries){if(entries.size<=capacity)break;if(!e.pending)entries.delete(key);}};
  return {
    peek<T=any>(path:string):T|undefined{return entries.get(path)?.data;},
    fresh(path:string){return (entries.get(path)?.expires||0)>Date.now();},
    load<T=any>(path:string,force=false):Promise<T>{
      let entry=entries.get(path);
      if(entry?.pending)return entry.pending;
      if(!force&&entry?.data!==undefined&&entry.expires>Date.now())return Promise.resolve(entry.data);
      entry??={expires:0};entries.delete(path);entries.set(path,entry);
      const current=entry,epoch=generation,controller=new AbortController();entry.controller=controller;
      const pending=load(path,controller.signal).then(data=>{
        if(epoch!==generation||controller.signal.aborted)throw new DOMException('Superseded read','AbortError');
        current.data=data;current.expires=Date.now()+ttl;return data;
      }).finally(()=>{if(current.pending===pending){current.pending=undefined;current.controller=undefined;}trim();});
      entry.pending=pending;return pending;
    },
    clear(notify=true){generation++;for(const entry of entries.values())entry.controller?.abort();entries.clear();if(notify)for(const listener of listeners)listener();},
    subscribe(notify:()=>void){listeners.add(notify);return()=>{listeners.delete(notify);};},
  };
}
export type ReadCache=ReturnType<typeof createReadCache>;
