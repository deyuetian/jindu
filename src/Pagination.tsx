import {useViewState} from './ViewState';
import { useId,useState,type ReactNode } from 'react';
import { ChevronLeft,ChevronRight } from 'lucide-react';
import { pageSizes } from '../shared/recruitment';
import './recruitment.css';

export function Pagination({page,pages,total,pageSize,onPage,onSize,busy=false}:{page:number;pages:number;total:number;pageSize:number;onPage:(n:number)=>void;onSize:(n:number)=>void;busy?:boolean}) {
  const [jump,setJump]=useState('');
  return <nav className="pagination" aria-label="列表分页"><span className="pagination-total">共 {total.toLocaleString('zh-CN')} 条</span><label className="page-size">每页<select aria-label="每页条数" value={pageSize} disabled={busy} onChange={e=>onSize(Number(e.target.value))}>{pageSizes.map(n=><option value={n} key={n}>{n} 条</option>)}</select></label><div className="page-controls"><button className="icon-btn" aria-label="上一页" disabled={busy||page<=1} onClick={()=>onPage(page-1)}><ChevronLeft size={17}/></button><span aria-live="polite">{page} / {pages}</span><button className="icon-btn" aria-label="下一页" disabled={busy||page>=pages} onClick={()=>onPage(page+1)}><ChevronRight size={17}/></button></div><div className="page-jump"><input aria-label="跳转页码" inputMode="numeric" type="number" min={1} max={pages} value={jump} onChange={e=>setJump(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();const n=Number(jump);if(Number.isInteger(n)&&n>=1&&n<=pages){onPage(n);setJump('');}}}}/><button type="button" className="text-btn" disabled={busy||!jump||!Number.isInteger(Number(jump))||Number(jump)<1||Number(jump)>pages} onClick={()=>{onPage(Number(jump));setJump('');}}>跳转</button></div></nav>;
}
export function PagedItems<T>({items,children,resetKey='',cacheKey}:{items:T[];children:(item:T)=>ReactNode;resetKey?:string;cacheKey?:string}) {
  const instance=useId(),key='pagination:'+(cacheKey||instance);
  const [storedSize,setSize]=useViewState(key+':size',20),[position,setPosition]=useViewState(key+':position',{key:resetKey,page:1});
  const size=(pageSizes as readonly number[]).includes(storedSize)?storedSize:20;
  const pages=Math.max(1,Math.ceil(items.length/size)),page=Math.min(position.key===resetKey?position.page:1,pages);
  return <>{items.slice((page-1)*size,page*size).map(children)}{items.length>0&&<Pagination page={page} pages={pages} total={items.length} pageSize={size} onPage={p=>setPosition({key:resetKey,page:p})} onSize={n=>{setSize(n);setPosition({key:resetKey,page:1});}}/>}</>;
}
