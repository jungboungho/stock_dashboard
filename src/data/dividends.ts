import type { Currency, Transaction } from '../types';
import type { HoldingsState } from './holdings';
import type { Instrument } from './instruments';

// ─────────────────────────────────────────────────────────────
// 배당 기록 (엑셀 '배당' 시트 ↔ NH 동기화)
//  - 출처 'API': 동기화가 NH 종합거래내역에서 가져온 것 (다시 동기화하면 그 기간은 새로 받은 값으로 바뀜)
//  - 출처 '직접': 엑셀에 직접 적은 것 (ISA · 연금 · IRP 등) — 동기화가 건드리지 않음
// ─────────────────────────────────────────────────────────────

export interface DividendEntry {
  date: string; // YYYY-MM-DD
  account: string;
  code: string;
  name: string;
  currency: Currency;
  /** 세후 입금액 (그 통화) */
  amount: number;
  /** 원화 환산액 (받은 때의 환율로 한 번 계산해 고정) */
  krw: number;
  source: 'API' | '직접';
}

/** NH 가 준 배당 (금액은 그 통화) */
export interface ApiDividend {
  date: string;
  account: string;
  code: string;
  name: string;
  currency: Currency;
  amount: number;
}

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

/** NH 종목코드(ISIN)로 온 배당은 보유 종목 · 종목 목록에서 같은 이름을 찾아 티커로 바꾼다 */
export function resolveCode(d: ApiDividend, h: HoldingsState, list: Instrument[]): string {
  if (!ISIN.test(d.code)) return d.code;
  const held = h.rows.find((r) => r.name === d.name && r.code);
  if (held) return held.code;
  const market = d.currency === 'USD' ? 'US' : 'KR';
  return list.find((i) => i.market === market && i.name === d.name)?.code ?? d.code;
}

/**
 * 동기화 결과를 합친다: 받은 계좌 · 기간(from 이후)의 예전 API 기록은 지우고 새로 받은 것으로.
 * 직접 적은 기록은 그대로 둔다. 같은 날 · 계좌 · 종목 · 금액이 직접 기록에 이미 있으면 API 쪽을 넣지 않는다.
 */
export function mergeApiDividends(
  existing: DividendEntry[],
  incoming: ApiDividend[],
  accounts: string[],
  from: string,
  usdKrw: number,
  code: (d: ApiDividend) => string = (d) => d.code,
): { rows: DividendEntry[]; added: number } {
  const keep = existing.filter((e) => !(e.source === 'API' && accounts.includes(e.account) && e.date >= from));
  const before = new Set(existing.filter((e) => e.source === 'API').map((e) => `${e.date}|${e.account}|${e.name}|${e.amount}`));
  const manual = new Set(keep.filter((e) => e.source === '직접').map((e) => `${e.date}|${e.account}|${e.amount}`));
  const fresh: DividendEntry[] = incoming
    .filter((d) => !manual.has(`${d.date}|${d.account}|${d.amount}`))
    .map((d) => ({ ...d, code: code(d), krw: Math.round(d.amount * (d.currency === 'USD' ? usdKrw : 1)), source: 'API' }));
  // 원화 환산은 처음 받았을 때 값을 유지 (환율이 바뀌어도 과거 배당 금액이 흔들리지 않게)
  const oldKrw = new Map(existing.filter((e) => e.source === 'API').map((e) => [`${e.date}|${e.account}|${e.name}|${e.amount}`, e.krw]));
  for (const f of fresh) f.krw = oldKrw.get(`${f.date}|${f.account}|${f.name}|${f.amount}`) ?? f.krw;
  const added = fresh.filter((f) => !before.has(`${f.date}|${f.account}|${f.name}|${f.amount}`)).length;
  return { rows: [...keep, ...fresh].sort((a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account)), added };
}

/** 다음 동기화 때 받을 시작일: 처음이면 2년 전부터, 아니면 마지막 API 배당 14일 전부터 */
export function dividendsFrom(rows: DividendEntry[], today = new Date()): string {
  const last = rows.filter((r) => r.source === 'API').at(-1)?.date;
  const d = last ? new Date(`${last}T00:00:00Z`) : new Date(Date.UTC(today.getUTCFullYear() - 2, today.getUTCMonth(), today.getUTCDate()));
  if (last) d.setUTCDate(d.getUTCDate() - 14);
  return d.toISOString().slice(0, 10);
}

export function toTransactions(rows: DividendEntry[]): Transaction[] {
  return rows.map((r) => ({ date: r.date, accountId: r.account, type: 'DIVIDEND', code: r.code || r.name, name: r.name, amountKRW: r.krw }));
}
