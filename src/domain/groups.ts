import type { Position } from '../data/model';
import type { Currency } from '../types';

// ─────────────────────────────────────────────────────────────
// 사용자 정의 그룹 ("배당주", "채권" ...) 과 그룹 안의 종목 관리
//  - 종목 하나는 그룹 하나에만 속한다 (그래야 비중 합계가 100%)
//  - 원본에 없는 종목은 직접 추가(manual)할 수 있고, 현재가를 직접 입력할 수 있다
//  - 이 브라우저(localStorage)에만 저장된다
// ─────────────────────────────────────────────────────────────

export interface Group {
  id: string;
  name: string;
}

export interface ManualStock {
  key: string;
  name: string;
  currency: Currency;
  quantity: number;
  avgPrice: number;
  price: number | null;
}

export interface GroupStore {
  version: 1;
  groups: Group[];
  /** 종목 키 → 그룹 id */
  members: Record<string, string>;
  manual: ManualStock[];
  /** 종목 키 → 직접 입력한 현재가 (종목 통화) */
  prices: Record<string, number>;
}

export const UNGROUPED = '미분류';
export const UNGROUPED_ID = '__none__';
export const CASH_ID = '__cash__';

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function emptyStore(): GroupStore {
  return { version: 1, groups: [], members: {}, manual: [], prices: {} };
}

export function seedStore(positions: Position[], defaults: { name: string; match: (p: Position) => boolean }[] = []): GroupStore {
  const store = emptyStore();
  for (const d of defaults) {
    const hits = positions.filter((p) => d.match(p) && !store.members[p.key]);
    if (!hits.length) continue;
    const id = newId('g');
    store.groups.push({ id, name: d.name });
    for (const p of hits) store.members[p.key] = id;
  }
  return store;
}

// ─── 저장 ─────────────────────────────────────────────────────

const storageKey = (source: string) => `stock-dashboard:groups:v1:${source}`;

export function loadStore(source: string): GroupStore | null {
  try {
    const raw = localStorage.getItem(storageKey(source));
    if (!raw) return null;
    const s = JSON.parse(raw) as GroupStore;
    return s && s.version === 1 && Array.isArray(s.groups) ? { ...emptyStore(), ...s } : null;
  } catch {
    return null;
  }
}

export function saveStore(source: string, store: GroupStore): void {
  try {
    localStorage.setItem(storageKey(source), JSON.stringify(store));
  } catch {
    /* 저장할 수 없는 환경(비공개 창 등)에서는 이번 화면에서만 유지 */
  }
}

// ─── 그룹 CRUD ────────────────────────────────────────────────

function cleanName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) throw new Error('그룹 이름을 입력하세요');
  if (n.length > 20) throw new Error('그룹 이름은 20자 이하로 입력하세요');
  if (n === UNGROUPED) throw new Error(`'${UNGROUPED}'는 그룹 이름으로 쓸 수 없습니다`);
  return n;
}

export function createGroup(store: GroupStore, name: string): { store: GroupStore; id: string } {
  const n = cleanName(name);
  if (store.groups.some((g) => g.name === n)) throw new Error(`'${n}' 그룹이 이미 있습니다`);
  const id = newId('g');
  return { store: { ...store, groups: [...store.groups, { id, name: n }] }, id };
}

export function renameGroup(store: GroupStore, id: string, name: string): GroupStore {
  const n = cleanName(name);
  if (!store.groups.some((g) => g.id === id)) throw new Error('없는 그룹입니다');
  if (store.groups.some((g) => g.name === n && g.id !== id)) throw new Error(`'${n}' 그룹이 이미 있습니다`);
  return { ...store, groups: store.groups.map((g) => (g.id === id ? { ...g, name: n } : g)) };
}

/** 그룹을 지우면 소속 종목은 미분류로 돌아간다 (종목 자체는 지우지 않음) */
export function deleteGroup(store: GroupStore, id: string): GroupStore {
  const members = Object.fromEntries(Object.entries(store.members).filter(([, g]) => g !== id));
  return { ...store, groups: store.groups.filter((g) => g.id !== id), members };
}

export function moveGroup(store: GroupStore, id: string, delta: -1 | 1): GroupStore {
  const i = store.groups.findIndex((g) => g.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= store.groups.length) return store;
  const groups = [...store.groups];
  [groups[i], groups[j]] = [groups[j], groups[i]];
  return { ...store, groups };
}

// ─── 그룹 안의 종목 CRUD ──────────────────────────────────────

/** groupId 가 null 이면 미분류로 */
export function assignStock(store: GroupStore, key: string, groupId: string | null): GroupStore {
  const members = { ...store.members };
  if (groupId === null || groupId === UNGROUPED_ID) delete members[key];
  else {
    if (!store.groups.some((g) => g.id === groupId)) throw new Error('없는 그룹입니다');
    members[key] = groupId;
  }
  return { ...store, members };
}

function validateStock(s: Omit<ManualStock, 'key'>) {
  if (!s.name.trim()) throw new Error('종목 이름을 입력하세요');
  if (!(s.quantity > 0)) throw new Error('수량은 0보다 커야 합니다');
  if (!(s.avgPrice > 0)) throw new Error('평균단가는 0보다 커야 합니다');
  if (s.price !== null && !(s.price > 0)) throw new Error('현재가는 0보다 커야 합니다');
}

export function addManualStock(store: GroupStore, stock: Omit<ManualStock, 'key'>, groupId: string | null, existingKeys: string[] = []): { store: GroupStore; key: string } {
  validateStock(stock);
  const name = stock.name.trim();
  const key = `manual:${name}`;
  if (existingKeys.includes(name) || store.manual.some((m) => m.key === key)) throw new Error(`'${name}' 종목이 이미 있습니다. 기존 종목을 그룹에 추가하세요`);
  const next = { ...store, manual: [...store.manual, { ...stock, name, key }] };
  return { store: groupId ? assignStock(next, key, groupId) : next, key };
}

export function updateManualStock(store: GroupStore, key: string, patch: Partial<Omit<ManualStock, 'key'>>): GroupStore {
  const cur = store.manual.find((m) => m.key === key);
  if (!cur) throw new Error('직접 추가한 종목만 수량 · 단가를 고칠 수 있습니다');
  const next = { ...cur, ...patch, name: (patch.name ?? cur.name).trim() };
  validateStock(next);
  return { ...store, manual: store.manual.map((m) => (m.key === key ? next : m)) };
}

export function deleteManualStock(store: GroupStore, key: string): GroupStore {
  const members = { ...store.members };
  delete members[key];
  const prices = { ...store.prices };
  delete prices[key];
  return { ...store, manual: store.manual.filter((m) => m.key !== key), members, prices };
}

/** 원본 종목의 현재가 직접 입력 (null 이면 지움) */
export function setPrice(store: GroupStore, key: string, price: number | null): GroupStore {
  const prices = { ...store.prices };
  if (price === null) delete prices[key];
  else {
    if (!(price > 0)) throw new Error('현재가는 0보다 커야 합니다');
    prices[key] = price;
  }
  return { ...store, prices };
}

// ─── 계산 ─────────────────────────────────────────────────────

/** 원본 보유 종목 + 직접 추가한 종목, 현재가 직접 입력 반영 */
export function applyStore(positions: Position[], store: GroupStore, usdKrw: number): Position[] {
  const fx = (c: Currency) => (c === 'USD' ? usdKrw : 1);
  const out = positions.map((p) => {
    const override = store.prices[p.key];
    if (override === undefined) return p;
    const rate = p.currency === 'USD' ? (p.price ? p.valueKRW / (p.price * p.quantity) : usdKrw) : 1;
    return { ...p, price: override, valueKRW: override * p.quantity * rate, priceOverridden: true };
  });
  for (const m of store.manual) {
    const price = store.prices[m.key] ?? m.price;
    out.push({
      key: m.key,
      name: m.name,
      currency: m.currency,
      quantity: m.quantity,
      avgPrice: m.avgPrice,
      price,
      costKRW: m.quantity * m.avgPrice * fx(m.currency),
      valueKRW: m.quantity * (price ?? m.avgPrice) * fx(m.currency),
      attrs: { currency: m.currency === 'USD' ? '달러 자산' : '원화 자산' },
      manual: true,
    });
  }
  return out;
}

export interface MemberRow {
  key: string;
  name: string;
  currency: Currency;
  quantity: number;
  avgPrice: number;
  price: number | null;
  costKRW: number;
  valueKRW: number;
  profitKRW: number;
  returnRate: number;
  manual: boolean;
  priceOverridden: boolean;
  /** 그룹 안 비중 */
  groupWeight: number;
  /** 전체 비중 */
  weight: number;
}

export interface CustomGroupRow {
  id: string;
  name: string;
  value: number;
  cost: number;
  profit: number;
  returnRate: number;
  weight: number;
  members: MemberRow[];
}

/** 같은 종목(키)은 계좌가 달라도 합친다 */
export function aggregateByKey(positions: Position[]): Position[] {
  const map = new Map<string, Position>();
  for (const p of positions) {
    const cur = map.get(p.key);
    if (!cur) {
      map.set(p.key, { ...p, accountId: undefined });
      continue;
    }
    const quantity = cur.quantity + p.quantity;
    map.set(p.key, {
      ...cur,
      quantity,
      avgPrice: (cur.avgPrice * cur.quantity + p.avgPrice * p.quantity) / quantity,
      costKRW: cur.costKRW + p.costKRW,
      valueKRW: cur.valueKRW + p.valueKRW,
    });
  }
  return [...map.values()];
}

export function customGroupRows(positions: Position[], store: GroupStore, cash = 0): CustomGroupRow[] {
  const items = aggregateByKey(positions);
  const total = items.reduce((s, p) => s + p.valueKRW, 0) + cash || 1;
  const order = [...store.groups.map((g) => ({ id: g.id, name: g.name })), { id: UNGROUPED_ID, name: UNGROUPED }];
  const known = new Set(store.groups.map((g) => g.id));

  const rows: CustomGroupRow[] = order.map(({ id, name }) => {
    const ms = items.filter((p) => (known.has(store.members[p.key]) ? store.members[p.key] : UNGROUPED_ID) === id);
    const value = ms.reduce((s, p) => s + p.valueKRW, 0);
    const cost = ms.reduce((s, p) => s + p.costKRW, 0);
    return {
      id,
      name,
      value,
      cost,
      profit: value - cost,
      returnRate: cost > 0 ? (value - cost) / cost : 0,
      weight: value / total,
      members: ms
        .map((p) => ({
          key: p.key,
          name: p.name,
          currency: p.currency,
          quantity: p.quantity,
          avgPrice: p.avgPrice,
          price: p.price,
          costKRW: p.costKRW,
          valueKRW: p.valueKRW,
          profitKRW: p.valueKRW - p.costKRW,
          returnRate: p.costKRW > 0 ? (p.valueKRW - p.costKRW) / p.costKRW : 0,
          manual: !!p.manual,
          priceOverridden: !!p.priceOverridden,
          groupWeight: value > 0 ? p.valueKRW / value : 0,
          weight: p.valueKRW / total,
        }))
        .sort((a, b) => b.valueKRW - a.valueKRW),
    };
  });
  if (Math.round(cash) !== 0) rows.push({ id: CASH_ID, name: '현금', value: cash, cost: cash, profit: 0, returnRate: 0, weight: cash / total, members: [] });
  // 미분류가 비어 있으면 표에서 뺀다 (사용자 그룹은 비어 있어도 보여줌)
  return rows.filter((r) => r.id !== UNGROUPED_ID || r.members.length > 0);
}
