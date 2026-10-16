import {useEffect,useState} from 'react';

/** Keep remote reads live without replacing unfinished edits. Conflicting saves
 * retain the original version so the server can reject an outdated submission. */
export function useSyncedDraft<T>(value:T,revision:number){
  const key=JSON.stringify(value);
  const [draft,setDraft]=useState<{value:T;key:string;revision:number}|null>(null);
  useEffect(()=>{if(draft&&JSON.stringify(draft.value)===key)setDraft(null);},[key,draft]);
  const changed=!!draft&&draft.key!==key;
  return {
    value:draft?.value??value,
    edit:(next:T)=>setDraft(current=>({value:next,key:current?.key??key,revision:current?.revision??revision})),
    revision:changed?draft!.revision:revision,
    changed,
    reset:()=>setDraft(null),
  };
}
