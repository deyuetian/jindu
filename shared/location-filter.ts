import {chinaLocations} from './china-locations.ts';
import {compareProvinces,compareCities} from './location-order.ts';

export type Place={province:string;city:string};
export type LocationOption={province:string;cities:string[]};
const shortProvince=(s:string)=>s.replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市/g,'');
const provinceAliases=new Map<string,string>();
const tokens=new Map<string,Place[]>();
function add(token:string,place:Place){
  if(!token)return;
  const values=tokens.get(token)||[];
  if(!values.some(v=>v.province===place.province&&v.city===place.city))values.push(place);
  tokens.set(token,values);
}
for(const row of chinaLocations){
  for(const name of [row.province,shortProvince(row.province)]){
    provinceAliases.set(name,row.province);
    add(name,{province:row.province,city:row.cities.length===1&&row.cities[0]===row.province?row.province:''});
  }
  for(const city of row.cities){
    const place={province:row.province,city};
    add(city,place);
    const short=city.replace(/市$|地区$|盟$/,'').replace(/(?:土家族|苗族|布依族|侗族|哈尼族|彝族|傣族|白族|藏族|傈僳族|景颇族|回族|壮族|朝鲜族|蒙古族|哈萨克|柯尔克孜|蒙古)+自治州$/,'');
    add(short,place);
    if(city.endsWith('自治州')&&short!==city)add(short+'州',place);
  }
}
provinceAliases.set('全国','全国');add('全国',{province:'全国',city:''});
const pattern=new RegExp([...tokens.keys()].sort((a,b)=>b.length-a.length).join('|'),'g');
export const canonicalProvince=(value:string)=>provinceAliases.get(value.trim())||value.trim();
export function canonicalCity(value:string,province:string){
  const choices=(tokens.get(value.trim())||[]).filter(p=>p.city&&(!province||p.province===canonicalProvince(province)));
  return choices.length===1?choices[0].city:value.trim();
}
export function uniquePlaces(values:Place[]):Place[]{
  const entries=new Map(values.map(p=>[p.province+'\0'+p.city,p]));
  return [...entries.values()].filter(p=>p.city||!values.some(v=>v.province===p.province&&v.city));
}

/** Read only location fields; employer names, school addresses and narrative text are not locations. */
export function parsePlaces(value:unknown):Place[]{
  if(typeof value!=='string'||!value.trim())return [];
  const text=value.trim(),found:Place[]=[];
  for(const match of text.matchAll(pattern)){
    const token=match[0],values=tokens.get(token)!;
    const isFull=values.some(p=>token===p.province||token===p.city);
    // Do not treat 南京路, 吉林大学 or 海南区 as the cities/provinces with similar names.
    if(!isFull&&/^(?:区|县|路|街|大道|镇|乡|村|大学|学院)/.test(text.slice(match.index!+token.length)))continue;
    const province=provinceAliases.get(token);
    const selected=province?values.filter(p=>p.province===province&&(!p.city||p.city===province)):values;
    if(selected.length===1)found.push(selected[0]);
  }
  return uniquePlaces(found);
}
export function matchesPlace(values:Place[],province:string,city:string){
  if(!province&&!city)return true;
  const p=canonicalProvince(province),c=canonicalCity(city,p);
  return values.some(v=>(!p||v.province===p)&&(!c||v.city===c));
}
export function placeOptions(groups:Iterable<Place[]>):LocationOption[]{
  const options=new Map<string,Set<string>>();
  for(const places of groups)for(const {province,city} of places){
    if(!options.has(province))options.set(province,new Set());
    if(city)options.get(province)!.add(city);
  }
  return [...options].sort(([a],[b])=>compareProvinces(a,b)).map(([province,cities])=>({province,cities:[...cities].sort((a,b)=>compareCities(province,a,b))}));
}
