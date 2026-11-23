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
  /** 그날 USD/KRW (원화 배당은 1, 모르면 null) */
  fx: number | null;
  /** 원화 환산액 = 금액 × 그날 환율 (한 번 정하면 고정) */
  krw: number;
  source: 'API' | '직접';
}

/** 중계 서버 배당 장부의 한 줄 (환율 · 원화금액은 서버가 그날 환율로 정해 둠) */
export interface ApiDividend {
  date: string;
  account: string;
  code: string;
  name: string;
  currency: Currency;
  amount: number;
  fx?: number;
  krw?: number;
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
 * 중계 서버 장부로 NH 배당을 맞춘다: 장부에 있는 계좌의 API 기록은 장부 그대로(그날 환율로 고정된 원화금액),
 * 직접 적은 기록은 그대로 둔다. 같은 날 · 계좌 · 금액이 직접 기록에 이미 있으면 장부 쪽은 넣지 않는다.
 */
export function applyLedger(
  existing: DividendEntry[],
  ledger: ApiDividend[],
  fallbackFx: number,
  code: (d: ApiDividend) => string = (d) => d.code,
): { rows: DividendEntry[]; added: number } {
  const ledgerAccounts = new Set(ledger.map((d) => d.account));
  const keep = existing.filter((e) => !(e.source === 'API' && ledgerAccounts.has(e.account)));
  const manual = new Set(keep.filter((e) => e.source === '직접').map((e) => `${e.date}|${e.account}|${e.amount}`));
  const before = new Set(existing.filter((e) => e.source === 'API').map((e) => `${e.date}|${e.account}|${e.name}|${e.amount}`));
  const fromLedger: DividendEntry[] = ledger
    .filter((d) => !manual.has(`${d.date}|${d.account}|${d.amount}`))
    .map((d) => {
      const fx = d.currency === 'USD' ? (d.fx ?? fallbackFx) : 1;
      return { date: d.date, account: d.account, code: code(d), name: d.name, currency: d.currency, amount: d.amount, fx, krw: d.krw ?? Math.round(d.amount * fx), source: 'API' };
    });
  const added = fromLedger.filter((f) => !before.has(`${f.date}|${f.account}|${f.name}|${f.amount}`)).length;
  return { rows: [...keep, ...fromLedger].sort((a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account)), added };
}

export function toTransactions(rows: DividendEntry[]): Transaction[] {
  return rows.map((r) => ({ date: r.date, accountId: r.account, type: 'DIVIDEND', code: r.code || r.name, name: r.name, amountKRW: r.krw, fxRate: r.fx ?? undefined }));
}
