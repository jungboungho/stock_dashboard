import type { DashboardData } from './model';
import type { ExcelBook } from './excel/parse';
import { accountTotals, cashByAccount, holdingsTotal, toPositions } from './holdings';
import type { DailySnapshot, ISODate } from '../types';

const monthEnd = (ym: string): ISODate => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export const bookUsdKrw = (book: ExcelBook) => book.holdings.usdKrw ?? book.usdKrw;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * 자산 추이 스냅샷.
 *  - 일별 기록(일별 자산추이 시트 + 지금 보유종목 합계)이 있는 달은 그 날짜들을 그대로 쓴다
 *    (원금은 그달 입금내역을 날짜까지 더함)
 *  - 없는 달은 Summary 기말자산(없으면 월별 자산추이 시트 값)을 월말 값으로 쓴다
 *  - 기말자산이 빈 달의 입금은 다음 스냅샷에 합쳐진다
 */
export function excelSnapshots(book: ExcelBook, today: ISODate): DailySnapshot[] {
  const h = book.holdings;
  const points = new Map<string, number>();
  for (const d of book.dailyLog ?? []) if (d.date <= today) points.set(d.date, d.total);
  if (h.asOf && (h.rows.length || h.cash.length)) {
    const live = h.asOf.slice(0, 10) > today ? today : h.asOf.slice(0, 10);
    points.set(live, holdingsTotal(h, bookUsdKrw(book)));
  }
  const byMonth = new Map<string, [ISODate, number][]>();
  for (const [date, value] of [...points].sort((a, b) => a[0].localeCompare(b[0]))) {
    const m = date.slice(0, 7);
    byMonth.set(m, [...(byMonth.get(m) ?? []), [date, value]]);
  }
  const summary = new Map(book.months.map((m) => [m.month, m]));
  const monthly = book.monthlyValues ?? {};
  const todayMonth = today.slice(0, 7);
  const months = [...new Set([...summary.keys(), ...byMonth.keys(), ...Object.keys(monthly)])].filter((m) => m <= todayMonth).sort();
  const depositsIn = (month: string, upTo: string) => sum(book.deposits.filter((d) => d.date.startsWith(month) && d.date <= upTo).map((d) => sum(d.amounts)));
  const hasDeposits = (month: string) => book.deposits.some((d) => d.date.startsWith(month));

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

  for (const month of months) {
    const m = summary.get(month);
    const monthFlow = m ? sum(m.flows) : depositsIn(month, '9999-12-31');
    const days = byMonth.get(month);
    if (days?.length) {
      const base = principal;
      let counted = 0;
      for (const [date, value] of days) {
        const toDate = hasDeposits(month) ? depositsIn(month, date) : monthFlow;
        pending += toDate - counted;
        counted = toDate;
        principal = base + toDate;
        push(date, value);
      }
      pending += monthFlow - counted;
      principal = base + monthFlow;
      continue;
    }
    principal += monthFlow;
    pending += monthFlow;
    const end = m?.endValue ?? monthly[month] ?? null;
    if (end === null) continue;
    const last = monthEnd(month);
    push(last > today ? today : last, end);
  }
  return out;
}

/**
 * 고른 계좌들만의 자산 추이.
 * 평가금은 계좌별로 기록된 날(일별 자산추이 + 지금 보유종목)만 알 수 있고,
 * 원금은 입금내역의 그 계좌 열을 날짜까지 더한다.
 */
export function excelAccountSnapshots(book: ExcelBook, accounts: string[], today: ISODate): DailySnapshot[] {
  const pick = new Set(accounts);
  const points = new Map<string, number>();
  for (const d of book.dailyLog ?? []) {
    if (d.date > today || !accounts.some((a) => a in d.accounts)) continue;
    points.set(d.date, sum(accounts.map((a) => d.accounts[a] ?? 0)));
  }
  const h = book.holdings;
  if (h.asOf && (h.rows.length || h.cash.length)) {
    const live = h.asOf.slice(0, 10) > today ? today : h.asOf.slice(0, 10);
    const t = accountTotals(h, bookUsdKrw(book));
    points.set(live, sum(accounts.map((a) => (t[a] ? t[a].value + t[a].cash : 0))));
  }
  const cols = book.depositAccounts.map((a, i) => (pick.has(a) ? i : -1)).filter((i) => i >= 0);
  const principalAt = (date: string) => sum(book.deposits.filter((d) => d.date <= date).map((d) => sum(cols.map((i) => d.amounts[i] ?? 0))));

  const out: DailySnapshot[] = [];
  let prevValue = 0;
  let prevPrincipal = 0;
  let growth = 1;
  for (const [date, value] of [...points].sort((a, b) => a[0].localeCompare(b[0]))) {
    const principal = principalAt(date);
    const flow = out.length ? principal - prevPrincipal : principal;
    const base = prevValue + (out.length ? flow : 0);
    if (out.length && base > 0) growth *= value / base;
    out.push({ date, principal, value, profit: value - principal, simpleReturn: principal > 0 ? (value - principal) / principal : 0, netFlow: flow, twr: growth - 1 });
    prevValue = value;
    prevPrincipal = principal;
  }
  return out;
}

/** 엑셀(Summary · 입금내역 · 보유종목) → 화면 데이터. book.holdings 가 바뀌면 다시 계산한다 */
export function makeExcelModel(book: ExcelBook, today: ISODate = new Date().toISOString().slice(0, 10)): DashboardData {
  let cacheKey: unknown[] = [];
  let snaps: DailySnapshot[] = [];
  const snapshots = () => {
    if (cacheKey[0] !== book.holdings || cacheKey[1] !== book.dailyLog) {
      snaps = excelSnapshots(book, today);
      cacheKey = [book.holdings, book.dailyLog];
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
    get trendAccounts() {
      const set = new Set(book.depositAccounts);
      for (const d of book.dailyLog) for (const a of Object.keys(d.accounts)) set.add(a);
      for (const r of book.holdings.rows) set.add(r.account);
      return [...set];
    },
    accountSnapshots: (accounts) => excelAccountSnapshots(book, accounts, today),
  };
}
