export type DocumentLink={url:string;name:string;image?:boolean};
const fileExtension=/\.(?:pdf|xlsx?|xlsm|docx?|zip)(?:$|[?#&])/i;
const imageExtension=/\.(?:png|jpe?g|webp|gif)(?:$|[?#&])/i;
const decoration=/(?:logo|favicon|icon|avatar|banner|footer|header)|二维码|公众号|扫码/i;

// A recruitment/registration/navigation link is not itself an attachment.
// Extensionless download endpoints are accepted only with an attachment label.
export function isAttachmentLink(link:DocumentLink) {
  let address:string;try{const u=new URL(link.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return false;address=decodeURIComponent(u.href);}catch{return false;}
  if(fileExtension.test(address))return true;
  if(link.image||imageExtension.test(address))return !decoration.test(address+' '+link.name);
  return /附件|岗位表|职位表|报名表|推荐表|材料模板/.test(link.name);
}

export function documentLinks(html:string,base:string):DocumentLink[] {
  const links:DocumentLink[]=[];
  for(const m of html.matchAll(/<(a|img)\b([^>]+)>/gi)) {
    const image=m[1].toLowerCase()==='img',attr=m[2];
    const href=attr.match(image?/\bsrc\s*=\s*["']([^"']+)["']/i:/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if(!href)continue;
    try {
      const url=new URL(href.replace(/&amp;/g,'&'),base);url.hash='';
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password)continue;
      const tail=html.slice((m.index||0)+m[0].length),end=tail.search(/<\/a>/i);
      const name=image?attr.match(/alt\s*=\s*["']([^"']*)["']/i)?.[1]||'正文图片':tail.slice(0,end<0?0:end).replace(/<[^>]*>/g,'').trim();
      links.push({url:url.href,name:name.slice(0,150)||'附件',image});
    }catch{}
  }
  return links.filter((l,i,a)=>a.findIndex(x=>x.url===l.url)===i);
}
