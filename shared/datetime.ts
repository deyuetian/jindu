const dateTimeCNFormatter=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});

export function formatDateTime(value?:string) {
  if(!value)return '尚无记录';
  const date=new Date(value);if(Number.isNaN(date.getTime()))return '时间待核对';
  const parts=dateTimeCNFormatter.formatToParts(date);
  const get=(type:string)=>parts.find(p=>p.type===type)?.value||'';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}
