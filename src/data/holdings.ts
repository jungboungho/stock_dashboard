import type { Currency } from '../types';
import type { Position } from './model';

// ─────────────────────────────────────────────────────────────
// 계좌별 보유 종목 · 현금 (엑셀 '보유종목' 시트 ↔ 화면 편집 ↔ 동기화)
//  - NH 계좌(종합 · 금계좌)는 동기화가 통째로 바꾼다
//  - 연금 · ISA · IRP 는 직접 편집하고, 동기화는 현재가만 바꾼다
// ─────────────────────────────────────────────────────────────

export interface HoldingRow {
  account: string;
  /** 국내 6자리 · 미국 티커 · 비우면 현재가 자동 반영 안 됨 */
  code: string;
  name: string;
  currency: Currency;
  quantity: number;
  /** 평균 매입 단가 (종목 통화) */
  avgPrice: number;
  /** 현재가 (종목 통화), 모르면 null */
  price: number | null;
  /** 매입금액 (원). 있으면 평균단가 × 환율 대신 이 값을 원가로 쓴다 */
  costKRW?: number | null;
  /** 전일 대비 등락률 (0.0123 = +1.23%), 동기화 때 받음 */
  change?: number | null;
  /** 마지막으로 끝난 정규장 종가 (종목 통화) · 그 종가의 전일 대비 */
  close?: number | null;
  closeChange?: number | null;
}

export interface CashRow {
  account: string;
  currency: Currency;
  amount: number;
}

export interface HoldingsState {
  /** 보유 종목 · 현재가 기준 시각 (ISO) */
  asOf: string | null;
  rows: HoldingRow[];
  cash: CashRow[];
  /** 마지막으로 받은 USD 환율 */
  usdKrw: number | null;
  syncedAt: string | null;
  /** 마지막 동기화에서 API 로 채운 계좌 */
  syncedAccounts: string[];
}

export const emptyHoldings = (): HoldingsState => ({ asOf: null, rows: [], cash: [], usdKrw: null, syncedAt: null, syncedAccounts: [] });

export const holdingKey = (r: Pick<HoldingRow, 'code' | 'name'>) => r.code.trim().toUpperCase() || r.name.trim();

const fx = (c: Currency, usdKrw: number) => (c === 'USD' ? usdKrw : 1);

export function rowCostKRW(r: HoldingRow, usdKrw: number): number {
  return r.costKRW != null && r.costKRW > 0 ? r.costKRW : r.quantity * r.avgPrice * fx(r.currency, usdKrw);
}

export function rowValueKRW(r: HoldingRow, usdKrw: number): number {
  const p = r.price ?? (r.avgPrice || null);
  return p === null ? rowCostKRW(r, usdKrw) : r.quantity * p * fx(r.currency, usdKrw);
}

export function toPositions(h: HoldingsState, usdKrw: number): Position[] {
  return h.rows.map((r) => ({
    key: holdingKey(r),
    name: r.name,
    code: r.code || undefined,
    currency: r.currency,
    accountId: r.account,
    quantity: r.quantity,
    avgPrice: r.avgPrice,
    price: r.price,
    change: r.change ?? null,
    close: r.close ?? null,
    closeChange: r.closeChange ?? null,
    costKRW: rowCostKRW(r, usdKrw),
    valueKRW: rowValueKRW(r, usdKrw),
    attrs: { currency: r.currency === 'USD' ? '달러 자산' : '원화 자산', account: r.account },
  }));
}

export function cashByAccount(h: HoldingsState, usdKrw: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of h.cash) out[c.account] = (out[c.account] ?? 0) + c.amount * fx(c.currency, usdKrw);
  return out;
}

export function holdingsTotal(h: HoldingsState, usdKrw: number): number {
  return h.rows.reduce((s, r) => s + rowValueKRW(r, usdKrw), 0) + Object.values(cashByAccount(h, usdKrw)).reduce((a, b) => a + b, 0);
}

export function accountTotals(h: HoldingsState, usdKrw: number): Record<string, { value: number; cash: number }> {
  const out: Record<string, { value: number; cash: number }> = {};
  const get = (a: string) => (out[a] ??= { value: 0, cash: 0 });
  for (const r of h.rows) get(r.account).value += rowValueKRW(r, usdKrw);
  for (const [a, c] of Object.entries(cashByAccount(h, usdKrw))) get(a).cash += c;
  return out;
}

// ─── 편집 ─────────────────────────────────────────────────────

function validate(r: HoldingRow) {
  if (!r.account.trim()) throw new Error('계좌를 고르세요');
  if (!r.name.trim()) throw new Error('종목 이름을 입력하세요');
  if (!(r.quantity > 0)) throw new Error('수량은 0보다 커야 합니다');
  if (r.avgPrice < 0) throw new Error('평균단가는 0 이상이어야 합니다');
  if (r.price !== null && !(r.price > 0)) throw new Error('현재가는 0보다 커야 합니다');
  if (!(r.avgPrice > 0) && !(r.costKRW && r.costKRW > 0)) throw new Error('평균단가나 매입금액 중 하나는 입력하세요');
}

const sameRow = (r: HoldingRow, account: string, key: string) => r.account === account && holdingKey(r) === key;

/** 같은 계좌 · 같은 종목이 있으면 바꾸고 없으면 추가. original 은 수정 전 (계좌, 키) */
export function upsertHolding(h: HoldingsState, row: HoldingRow, original?: { account: string; key: string }): HoldingsState {
  const next: HoldingRow = { ...row, account: row.account.trim(), code: row.code.trim().toUpperCase(), name: row.name.trim() };
  validate(next);
  const key = holdingKey(next);
  const clash = h.rows.some((r) => sameRow(r, next.account, key) && !(original && sameRow(r, original.account, original.key)));
  if (clash) throw new Error(`'${next.account}' 계좌에 '${next.name}'이(가) 이미 있습니다`);
  const rows = original ? h.rows.filter((r) => !sameRow(r, original.account, original.key)) : [...h.rows];
  rows.push(next);
  return { ...h, rows, asOf: h.asOf ?? new Date().toISOString() };
}

export function removeHolding(h: HoldingsState, account: string, key: string): HoldingsState {
  return { ...h, rows: h.rows.filter((r) => !sameRow(r, account, key)) };
}

export function setCash(h: HoldingsState, account: string, currency: Currency, amount: number): HoldingsState {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('현금은 0 이상으로 입력하세요');
  const cash = h.cash.filter((c) => !(c.account === account && c.currency === currency));
  if (amount > 0 || currency === 'KRW') cash.push({ account, currency, amount });
  return { ...h, cash };
}

// ─── 동기화 ───────────────────────────────────────────────────

export interface SyncAccount {
  name: string;
  /** NH 계좌번호 끝 4자리 */
  suffix?: string;
  rows: HoldingRow[];
  cash: CashRow[];
}

export interface SyncResult {
  asOf: string;
  usdKrw: number | null;
  /** API 로 통째로 받은 계좌 */
  accounts: SyncAccount[];
  /** 종목코드 → 현재가 (종목 통화) */
  prices: Record<string, number>;
  /** 종목코드 → 전일 대비 등락률 */
  changes?: Record<string, number>;
  /** 종목코드 → 마지막 정규장 종가 · 그 날짜 · 종가 등락률 */
  closes?: Record<string, { close: number; date: string | null; change: number | null }>;
  /** dividendsFrom 부터 NH 계좌의 배당 입금 (금액은 그 통화) */
  dividends?: { date: string; account: string; code: string; name: string; currency: Currency; amount: number; fx?: number; krw?: number }[];
  dividendsFrom?: string | null;
  /** NH 가 응답했지만 대시보드 계좌 이름이 없는 계좌 (반영하지 않음) */
  unmapped?: { suffix: string; holdings: number; cash: number }[];
  /** 받지 못한 항목 */
  warnings: string[];
}

/** 동기화 때 현재가를 물어볼 종목 (API 로 받는 계좌의 종목은 빼고) */
export function quoteTargets(h: HoldingsState, apiAccounts: string[]): { code: string; currency: Currency }[] {
  const seen = new Map<string, Currency>();
  for (const r of h.rows) if (r.code && !apiAccounts.includes(r.account)) seen.set(r.code, r.currency);
  return [...seen].map(([code, currency]) => ({ code, currency }));
}

export function applySync(h: HoldingsState, res: SyncResult): HoldingsState {
  const names = new Set(res.accounts.map((a) => a.name));
  const rows = h.rows
    .filter((r) => !names.has(r.account))
    .map((r) => (r.code && res.prices[r.code] > 0 ? { ...r, price: res.prices[r.code] } : r));
  const changes = res.changes ?? {};
  const closes = res.closes ?? {};
  const withChange = (r: HoldingRow): HoldingRow => {
    if (!r.code) return r;
    const c = closes[r.code];
    return {
      ...r,
      ...(changes[r.code] !== undefined ? { change: changes[r.code] } : {}),
      ...(c ? { close: c.close, closeChange: c.change } : {}),
    };
  };
  const cash = h.cash.filter((c) => !names.has(c.account));
  for (const a of res.accounts) {
    rows.push(...a.rows);
    cash.push(...a.cash);
  }
  return { asOf: res.asOf, rows: rows.map(withChange), cash, usdKrw: res.usdKrw ?? h.usdKrw, syncedAt: res.asOf, syncedAccounts: [...names] };
}
