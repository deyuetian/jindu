import type {Store} from './db.ts';
import {uniquePlaces,placeOptions,type Place,type LocationOption} from '../shared/location-filter.ts';
import {announcementPlaces,jobPlaces} from '../shared/job-location.ts';
import {recruitmentReader} from './recruitment-reader.ts';

type Index={job:Map<string,Place[]>;announcement:Map<string,Place[]>;options:{job:LocationOption[];announcement:LocationOption[]}};
type Cache={stamp:string;input:string;index:Index;sequence:number};
const caches=new WeakMap<Store,Cache>();

/** Reuse parser facts, never eligibility analysis. Also used by card presentation. */
export function listingLocations(store:Store):Index{
  const old=caches.get(store),db=store.db,sequence=(old?.sequence||0)+1;
  const stamp=JSON.stringify([db.prepare('PRAGMA data_version').get(),db.prepare('SELECT total_changes() n').get(),db.isTransaction===false?false:sequence]);
  if(old?.stamp===stamp)return old.index;
  const reader=recruitmentReader(store);
  const announcements=reader.list('announcement').filter(a=>!a.archived);
  const jobs=reader.list('job').filter(j=>!j.archived&&j.analysisCurrent!==false).map(j=>reader.facts(j));
  const parent=new Map(announcements.map(a=>[a.id,a]));
  const job=new Map<string,Place[]>(jobs.map(j=>[j.id,jobPlaces(j,parent.get(j.announcementId))]));
  const announcement=new Map<string,Place[]>(announcements.map(a=>[a.id,announcementPlaces(a)]));
  for(const j of jobs)if(announcement.has(j.announcementId))announcement.set(j.announcementId,uniquePlaces([...announcement.get(j.announcementId)!,...job.get(j.id)!]));
  const input=JSON.stringify([[...job],[...announcement]]);
  if(old?.input===input){old.stamp=stamp;old.sequence=sequence;return old.index;}
  const index={job,announcement,options:{job:placeOptions(job.values()),announcement:placeOptions(announcement.values())}};
  caches.set(store,{stamp,input,index,sequence});return index;
}
