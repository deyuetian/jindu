import {parsePlaces,uniquePlaces,type Place} from './location-filter.ts';
import {announcementMetadata} from './announcement-metadata.ts';

export const locationText=(values:Place[])=>values.map(p=>p.city&&p.city!==p.province?p.province+' · '+p.city:p.province).join('、');
export function announcementPlaces(announcement:any):Place[]{
  announcement=announcementMetadata(announcement||{});
  const locations=announcement?.introduction?.locations;
  return uniquePlaces([...parsePlaces(typeof locations==='object'?locations?.text:locations),...parsePlaces(announcement?.province)]);
}
/** Cards, detail, exports and filters must all use this result. No employer-name guessing. */
export function jobPlaces(job:any,announcement?:any):Place[]{
  let places=parsePlaces(job.sourcePosition?.location);
  if(!places.length)places=parsePlaces(job.province);
  const local=String(job.title||'').match(/^(.{2,8}?)市直岗位\s*\d+$/);
  if(local&&!places.some(p=>p.city)){
    const city=parsePlaces(local[1]+'市');
    if(city.length&&(!places.length||places.some(p=>city.some(c=>c.province===p.province))))places=city;
  }
  return places.length?places:announcementPlaces(announcement);
}
