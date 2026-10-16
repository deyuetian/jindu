import {useRef, useState, type RefObject, type PointerEvent, type KeyboardEvent} from 'react';
import {GripVertical, type LucideIcon} from 'lucide-react';
import {navigationOrderKey, normalizeNavigationOrder, moveNavigationItem} from './navigation-order';
import './navigation-order.css';

type Props = {
  pages: readonly (readonly [string, string, LucideIcon])[];
  active: string;
  badges: Record<string, number>;
  navigationRef: RefObject<HTMLElement | null>;
  onNavigate: (id: string) => void;
};
export default function SortableNavigation({pages, active, badges, navigationRef, onNavigate}: Props) {
  const available = pages.map(([id]) => id);
  const [order, setOrder] = useState(() => {
    try { return normalizeNavigationOrder(JSON.parse(localStorage.getItem(navigationOrderKey) || 'null'), available); }
    catch { return [...available]; }
  });
  const [dragged, setDragged] = useState(''), [message, setMessage] = useState('');
  const drag = useRef<{id: string; pointer: number; initial: string[]; current: string[]; startX: number; startY: number; moved: boolean} | null>(null);
  const [storageError, setStorageError] = useState(false);
  function persist(next: string[], id: string) {
    setOrder(next);
    try { localStorage.setItem(navigationOrderKey, JSON.stringify(next)); setStorageError(false); }
    catch { setStorageError(true); }
    setMessage(`${pages.find(p => p[0] === id)?.[1]}已移到第 ${next.indexOf(id) + 1} 项`);
  }
  function start(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.currentTarget.focus();
    navigationRef.current?.setPointerCapture(event.pointerId);
    drag.current = {id, pointer: event.pointerId, initial: order, current: order, startX: event.clientX, startY: event.clientY, moved: false};
    setDragged(id);
  }
  function move(event: PointerEvent<HTMLElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return;
    current.moved = true;
    const nav = navigationRef.current;
    if (!nav) return;
    const bounds = nav.getBoundingClientRect(), horizontal = nav.scrollWidth > nav.clientWidth;
    if (horizontal) {
      if (event.clientX < bounds.left + 28) nav.scrollLeft -= 28;
      if (event.clientX > bounds.right - 28) nav.scrollLeft += 28;
    }
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-nav-id]');
    const targetId = target?.dataset.navId;
    if (!target || !nav.contains(target) || !targetId || targetId === current.id) return;
    // Move only past the target midpoint, preventing layout-induced oscillation.
    const rect = target.getBoundingClientRect(), after = current.current.indexOf(current.id) < current.current.indexOf(targetId);
    const pointer = horizontal ? event.clientX : event.clientY, middle = horizontal ? (rect.left + rect.right) / 2 : (rect.top + rect.bottom) / 2;
    if (after ? pointer < middle : pointer > middle) return;
    current.current = moveNavigationItem(current.current, current.id, targetId);
    setOrder(current.current);
  }
  function finish(event: PointerEvent<HTMLElement>, cancel = false) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointer) return;
    drag.current = null; setDragged('');
    if (cancel || !current.moved) setOrder(current.initial);
    else persist(current.current, current.id);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (event.key === 'Escape' && drag.current) {
      event.preventDefault(); setOrder(drag.current.initial); drag.current = null; setDragged(''); return;
    }
    const delta = ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : 0;
    if (!delta || drag.current) return;
    event.preventDefault(); const target = order[order.indexOf(id) + delta];
    if (target) persist(moveNavigationItem(order, id, target), id);
  }
  return <>
    <nav ref={navigationRef} className="sortable-navigation" aria-label="主导航" onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}>
      {order.map(id => {
        const entry = pages.find(p => p[0] === id); if (!entry) return null;
        const [, label, Icon] = entry, count = badges[id] || 0;
        return <div className={'navigation-item' + (dragged === id ? ' is-dragging' : '')} data-nav-id={id} key={id}>
          <button className={'navigation-link' + (active === id ? ' active' : '')} aria-label={label} aria-current={active === id ? 'page' : undefined} onClick={() => onNavigate(id)}>
            <Icon size={18}/><span>{label}</span>
            {id === 'jobs' ? <em className="intended-badge" title={`我关注的岗位：${count} 个`}><span className="intended-prefix">关注 </span>{count}</em> : count > 0 && <em title={id==='agent'?`${count} 条未读时间更新通知`:undefined}>{id==='agent'&&<span className="intended-prefix">未读 </span>}{count}</em>}
          </button>
          <button type="button" className="navigation-grip" aria-label={`调整${label}顺序`} aria-describedby="navigation-order-help" title="拖动排序，也可用方向键调整" onPointerDown={event => start(event, id)} onKeyDown={event => keyboard(event, id)}><GripVertical size={14}/></button>
        </div>;
      })}
    </nav>
    <span id="navigation-order-help" className="navigation-sr">拖动把手调整顺序，或聚焦把手后按方向键。顺序保存在当前浏览器。</span>
    <span className="navigation-sr" role="status">{message}{storageError ? '；浏览器无法保存，关闭页面后顺序可能重置。' : ''}</span>
  </>;
}
