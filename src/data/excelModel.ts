import type { DashboardData, Position } from './model';
import type { ExcelBook } from './excel/parse';
import type { DailySnapshot, ISODate } from '../types';

const monthEnd = (ym: string): ISODate => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** Summary 월별 기말자산 → 스냅샷. 기말자산이 비어 있는 달의 입금은 다음 스냅샷에 합쳐진다 */
export function excelSnapshots(book: ExcelBook, today: ISODate): DailySnapshot[] {
  const out: DailySnapshot[] = [];
  let principal = 0;
  let pending = 0;
  let prevValue = 0;
  let growth = 1;
  for (const m of book.months) {
    const flow = m.flows.reduce((a, b) => a + b, 0);
    principal += flow;
    pending += flow;
    if (m.endValue === null) continue;
    const value = m.endValue;
    const base = prevValue + pending;
    if (base > 0) growth *= value / base;
    const end = monthEnd(m.month);
    out.push({
      date: end > today ? today : end,
      principal,
      value,
      profit: value - principal,
      simpleReturn: principal > 0 ? (value - principal) / principal : 0,
      netFlow: pending,
      twr: growth - 1,
    });
    prevValue = value;
    pending = 0;
  }
  return out;
}

const nameHas = (...words: string[]) => (p: Position) => words.some((w) => p.name.toUpperCase().includes(w.toUpperCase()));

/**
 * 엑셀(Summary · 입금내역) → 화면 데이터.
 * 엑셀에는 보유 종목 · 현재가가 없으므로 종목은 비워 두고(직접 추가 가능), 마이데이터 동기화로 채운다.
 */
export function makeExcelModel(book: ExcelBook, today: ISODate = new Date().toISOString().slice(0, 10)): DashboardData {
  const snaps = excelSnapshots(book, today);
  return {
    source: 'excel',
    sourceLabel: `엑셀 · ${book.fileName}`,
    updatedAt: book.importedAt,
    asOf: snaps.at(-1)?.date ?? today,
    accounts: book.accounts.map((a) => ({ id: a.id, name: a.name, principal: a.principal })),
    accountFilter: false,
    dimensions: [{ id: 'currency', label: '통화' }],
    hasDividends: false,
    goal: book.goal,
    usdKrw: book.usdKrw,
    snapshots: () => snaps,
    positions: () => [],
    cash: () => ({}),
    dividends: () => [],
    yearStarts: book.yearStarts,
    deposits: book.deposits.length ? { accounts: book.depositAccounts, rows: book.deposits } : undefined,
    defaultGroups: [
      { name: '배당주', match: nameHas('SCHD', '배당', 'JEPI') },
      { name: '성장주', match: nameHas('나스닥', 'QQQ', '테슬라', '엔비디아') },
      { name: '채권', match: nameHas('SGOV', 'TLT', '채권', '국채') },
    ],
  };
}
