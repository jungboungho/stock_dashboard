import type { DashboardData } from './model';
import type { ExcelBook } from './excel/parse';
import { cashByAccount, holdingsTotal, toPositions } from './holdings';
import type { DailySnapshot, ISODate } from '../types';

const monthEnd = (ym: string): ISODate => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export const bookUsdKrw = (book: ExcelBook) => book.holdings.usdKrw ?? book.usdKrw;

/**
 * Summary 월별 기말자산 → 스냅샷. 기말자산이 비어 있는 달의 입금은 다음 스냅샷에 합쳐진다.
 * 보유종목(동기화 · 편집)이 있으면 그 합계를 기준일의 '현재' 값으로 쓴다 (그 달의 기말자산 대신).
 */
export function excelSnapshots(book: ExcelBook, today: ISODate): DailySnapshot[] {
  const h = book.holdings;
  const liveDate = h.asOf && (h.rows.length || h.cash.length) ? (h.asOf.slice(0, 10) > today ? today : h.asOf.slice(0, 10)) : null;
  const liveMonth = liveDate?.slice(0, 7);
  const liveValue = liveDate ? holdingsTotal(h, bookUsdKrw(book)) : 0;

  const out: DailySnapshot[] = [];
  let principal = 0;
  let pending = 0;
  let prevValue = 0;
  let growth = 1;
  const push = (date: ISODate, value: number) => {
    const base = prevValue + pending;
    if (base > 0) growth *= value / base;
    out.push({
      date,
      principal,
      value,
      profit: value - principal,
      simpleReturn: principal > 0 ? (value - principal) / principal : 0,
      netFlow: pending,
      twr: growth - 1,
    });
    prevValue = value;
    pending = 0;
  };

  for (const m of book.months) {
    if (liveMonth && m.month > liveMonth) break;
    const flow = m.flows.reduce((a, b) => a + b, 0);
    principal += flow;
    pending += flow;
    if (liveMonth && m.month === liveMonth) continue; // 현재 달은 아래에서 보유종목 합계로
    if (m.endValue === null) continue;
    const end = monthEnd(m.month);
    push(end > today ? today : end, m.endValue);
  }
  if (liveDate) push(liveDate, liveValue);
  return out;
}

/** 엑셀(Summary · 입금내역 · 보유종목) → 화면 데이터. book.holdings 가 바뀌면 다시 계산한다 */
export function makeExcelModel(book: ExcelBook, today: ISODate = new Date().toISOString().slice(0, 10)): DashboardData {
  let cacheKey: unknown = null;
  let snaps: DailySnapshot[] = [];
  const snapshots = () => {
    if (cacheKey !== book.holdings) {
      snaps = excelSnapshots(book, today);
      cacheKey = book.holdings;
    }
    return snaps;
  };
  return {
    source: 'excel',
    sourceLabel: `엑셀 · ${book.fileName}`,
    get updatedAt() {
      return book.holdings.syncedAt ?? book.importedAt;
    },
    get asOf() {
      return snapshots().at(-1)?.date ?? today;
    },
    accounts: book.accounts.map((a) => ({ id: a.id, name: a.name, principal: a.principal })),
    accountFilter: false,
    dimensions: [
      { id: 'account', label: '계좌' },
      { id: 'currency', label: '통화' },
    ],
    hasDividends: false,
    goal: book.goal,
    get usdKrw() {
      return bookUsdKrw(book);
    },
    snapshots,
    positions: () => toPositions(book.holdings, bookUsdKrw(book)),
    cash: () => cashByAccount(book.holdings, bookUsdKrw(book)),
    dividends: () => [],
    yearStarts: book.yearStarts,
    deposits: book.deposits.length ? { accounts: book.depositAccounts, rows: book.deposits } : undefined,
  };
}
