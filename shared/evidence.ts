// Bounded exact-text cache, never an eligibility-result cache. Multiple notices
// can be interleaved; a large worksheet must not be normalized per condition.
const maxCharacters=8_000_000;
const entries=new Map<string,{normalized:string;characters:number;quotes:Map<string,boolean>}>();
let characters=0;
export function normalizedEvidence(value:string):string {
  if(value.length<4096||value.length*2>maxCharacters)return value.replace(/\s/g,'');
  const cached=entries.get(value);
  if(cached){entries.delete(value);entries.set(value,cached);return cached.normalized;}
  const normalized=value.replace(/\s/g,'');
  const size=value.length+normalized.length;
  while(entries.size&&(characters+size>maxCharacters||entries.size>=8)){
    const key=entries.keys().next().value!;characters-=entries.get(key)!.characters;entries.delete(key);
  }
  entries.set(value,{normalized,characters:size,quotes:new Map()});characters+=size;
  return normalized;
}
export function evidenceContains(source:string,normalizedQuote:string):boolean {
  const normalized=normalizedEvidence(source),entry=entries.get(source);
  const previous=entry?.quotes.get(normalizedQuote);
  if(previous!==undefined)return previous;
  const found=normalized.includes(normalizedQuote);
  if(entry&&normalizedQuote.length<=4096){
    if(entry.quotes.size>=256)entry.quotes.delete(entry.quotes.keys().next().value!);
    entry.quotes.set(normalizedQuote,found);
  }
  return found;
}
