import {z} from 'zod';
import type {Store} from './db.ts';

// A removed calendar's history stays readable, but no longer requires attention.
export const unreadNoticeWhere=`t.kind='agent_turn' AND json_extract(t.data,'$.notice')=1 AND COALESCE(json_extract(t.data,'$.seen'),0)=0
 AND EXISTS (SELECT 1 FROM records e WHERE e.id=json_extract(t.data,'$.examId') AND e.kind='exam' AND COALESCE(json_extract(e.data,'$.archived'),0)=0 AND COALESCE(json_extract(e.data,'$.calendarKind'),'exam')!='personal')`;
export function unreadNoticeIds(store:Store):string[] {
  return (store.prepare(`SELECT t.id FROM records t WHERE ${unreadNoticeWhere}`).all() as {id:string}[]).map(t=>t.id);
}
export function markNoticesSeen(store:Store,input:unknown) {
  const {ids}=z.object({ids:z.array(z.string().min(1).max(160)).max(1000).optional()}).parse(input);
  return store.transaction(()=>{
    const unread=new Set(unreadNoticeIds(store));let changed=0;
    for(const id of new Set(ids??unread)) {
      if(!unread.has(id))continue;
      const t=store.get(id);store.put(id,'agent_turn',{...t,seen:true},t.version);changed++;
    }
    return {ok:true,changed};
  });
}
