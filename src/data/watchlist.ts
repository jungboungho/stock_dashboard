import type { Currency } from '../types';
import type { SyncResult } from './holdings';

// ─────────────────────────────────────────────────────────────
// 관심 종목 (엑셀 '관심종목' 시트 ↔ 화면 편집 ↔ 동기화 때 시세)
//  - 종목은 그룹 하나에 들어간다 (같은 종목을 다른 그룹에 또 넣을 수는 있음)
//  - 그룹이 없는 종목은 '미분류'
// ─────────────────────────────────────────────────────────────

export const WATCH_UNGROUPED = '미분류';

export interface WatchItem {
  code: string;
  name: string;
  currency: Currency;
  group: string;
  price?: number | null;
  change?: number | null;
  close?: number | null;
  closeChange?: number | null;
}

export interface Watchlist {
  groups: string[];
  items: WatchItem[];
  /** 시세를 마지막으로 받은 시각 (ISO) */
  quotedAt?: string | null;
}

export const emptyWatchlist = (): Watchlist => ({ groups: [], items: [], quotedAt: null });

function cleanGroup(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) throw new Error('그룹 이름을 입력하세요');
  if (n.length > 20) throw new Error('그룹 이름은 20자 이하로 입력하세요');
  if (n === WATCH_UNGROUPED) throw new Error(`'${WATCH_UNGROUPED}'는 그룹 이름으로 쓸 수 없습니다`);
  return n;
}

export function addWatchGroup(w: Watchlist, name: string): Watchlist {
  const n = cleanGroup(name);
  if (w.groups.includes(n)) throw new Error(`'${n}' 그룹이 이미 있습니다`);
  return { ...w, groups: [...w.groups, n] };
}

export function renameWatchGroup(w: Watchlist, from: string, to: string): Watchlist {
  const n = cleanGroup(to);
  if (!w.groups.includes(from)) throw new Error('없는 그룹입니다');
  if (n !== from && w.groups.includes(n)) throw new Error(`'${n}' 그룹이 이미 있습니다`);
  return { ...w, groups: w.groups.map((g) => (g === from ? n : g)), items: w.items.map((i) => (i.group === from ? { ...i, group: n } : i)) };
}

/** 그룹을 지우면 그 종목은 미분류로 (같은 종목이 미분류에 이미 있으면 하나로) */
export function deleteWatchGroup(w: Watchlist, name: string): Watchlist {
  const moved = w.items.map((i) => (i.group === name ? { ...i, group: '' } : i));
  const seen = new Set<string>();
  const items = moved.filter((i) => {
    const k = `${i.group}|${i.code}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { ...w, groups: w.groups.filter((g) => g !== name), items };
}

export function addWatchItem(w: Watchlist, item: Omit<WatchItem, 'group'>, group: string): Watchlist {
  const g = group === WATCH_UNGROUPED ? '' : group;
  if (g && !w.groups.includes(g)) throw new Error('없는 그룹입니다');
  if (!item.code.trim()) throw new Error('종목을 고르세요');
  if (w.items.some((i) => i.code === item.code && i.group === g)) throw new Error(`'${item.name}'은(는) 이미 ${g || WATCH_UNGROUPED}에 있습니다`);
  return { ...w, items: [...w.items, { ...item, group: g }] };
}

export function removeWatchItem(w: Watchlist, code: string, group: string): Watchlist {
  return { ...w, items: w.items.filter((i) => !(i.code === code && i.group === group)) };
}

export function moveWatchItem(w: Watchlist, code: string, from: string, to: string): Watchlist {
  const t = to === WATCH_UNGROUPED ? '' : to;
  if (t === from) return w;
  if (t && !w.groups.includes(t)) throw new Error('없는 그룹입니다');
  if (w.items.some((i) => i.code === code && i.group === t)) return removeWatchItem(w, code, from); // 이미 그 그룹에 있음
  return { ...w, items: w.items.map((i) => (i.code === code && i.group === from ? { ...i, group: t } : i)) };
}

/** 동기화 때 물어볼 종목 */
export function watchQuoteTargets(w: Watchlist): { code: string; currency: Currency }[] {
  const m = new Map<string, Currency>();
  for (const i of w.items) m.set(i.code, i.currency);
  return [...m].map(([code, currency]) => ({ code, currency }));
}

/** 받은 시세를 관심 종목에 */
export function applyWatchQuotes(w: Watchlist, res: Pick<SyncResult, 'asOf' | 'prices' | 'changes' | 'closes'>): Watchlist {
  const items = w.items.map((i) => {
    const c = res.closes?.[i.code];
    return {
      ...i,
      price: res.prices[i.code] ?? i.price ?? null,
      change: res.changes?.[i.code] ?? i.change ?? null,
      close: c?.close ?? i.close ?? null,
      closeChange: c ? c.change : (i.closeChange ?? null),
    };
  });
  return { ...w, items, quotedAt: res.asOf };
}

/** 고른 그룹들(비어 있으면 전체)의 종목. 미분류는 WATCH_UNGROUPED 로 고른다 */
export function watchItemsIn(w: Watchlist, groups: string[]): WatchItem[] {
  if (!groups.length) return w.items;
  return w.items.filter((i) => groups.includes(i.group || WATCH_UNGROUPED));
}
