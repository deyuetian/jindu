import { requestPublic } from './net.ts';
import { AppError } from './model.ts';
import { htmlText } from './school-crawler.ts';
import type { SourceDoc } from './agent-sources.ts';

const origin = 'https://scc.cau.edu.cn';
export function cauCalendarURL(value:string) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.hostname !== 'scc.cau.edu.cn' || u.port || u.username || u.password) return '';
    const news = u.pathname === '/frontpage/cau/html/newsDetail.html';
    const recruitment = u.pathname === '/frontpage/cau/html/recruitmentinfoForm.html';
    if (!news && !recruitment) return '';
    const key = news ? 'id' : 'positionDetailId', id = u.searchParams.get(key);
    if (!id || !/^[a-f0-9]{32}$/.test(id) || u.searchParams.getAll(key).length !== 1) return '';
    return `${origin}${u.pathname}?${key}=${id}`;
  } catch { return ''; }
}

// Calendar checks read only the selected announcement body. No persistence,
// linked pages, attachments, position lists, or search engines are involved.
export async function readCauCalendarNotice(value:string):Promise<SourceDoc> {
  const url = cauCalendarURL(value);
  if (!url) throw new AppError(400, '日历跟进只支持农大公告正文，请提供农大的公告详情链接');
  const u = new URL(url), news = u.searchParams.has('id');
  const id = u.searchParams.get(news ? 'id' : 'positionDetailId')!;
  const endpoint = news ? `${origin}/f/newsCenter/ajax_view?id=${id}` : `${origin}/f/recruitmentinfo/ajax_show`;
  const response = await requestPublic(endpoint, {
    method: news ? 'GET' : 'POST', redirects: 0, timeout: 20000, maxBytes: 8000000,
    headers: {Accept: 'application/json', ...(!news ? {'Content-Type': 'application/x-www-form-urlencoded'} : {})},
    ...(!news ? {body: new URLSearchParams({recruitmentId: id}).toString()} : {}),
  });
  if (response.status !== 200) throw new AppError(502, `农大公告正文暂时无法读取（HTTP ${response.status}），已保留原日历`);
  let data:any;
  try { data = JSON.parse(response.body.toString('utf8')); }
  catch { throw new AppError(502, '农大公告返回格式发生变化，已保留原日历'); }
  if (data?.state !== 1) throw new AppError(502, '农大公告暂不可用，可能已撤回或尚未通过审核，已保留原日历');
  const article = news ? data.object?.article : data.object?.recruitmentinfo;
  const content = news ? article?.articleData?.content : article?.content;
  if (typeof article?.title !== 'string' || typeof content !== 'string' || (article.id && article.id !== id)) {
    throw new AppError(502, '农大公告正文结构发生变化，已保留原日历');
  }
  const title = htmlText(article.title), text = htmlText(content);
  if (!title || !text) throw new AppError(422, '农大公告正文为空，已有日历保持不变');
  return {id: 'cau:' + id, url, title, text, published: String(article.createDate || article.releaseDate || article.startTime || '').slice(0, 10)};
}
