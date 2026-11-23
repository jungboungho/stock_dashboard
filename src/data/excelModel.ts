import type { ClosedTrade, DashboardData, Position } from './model';
import { isOpenLot, type ExcelBook } from './excel/parse';
import type { DailySnapshot, ISODate } from '../types';

const monthEnd = (ym: string): ISODate => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** 월별 기말자산 → 스냅샷. 기말자산이 비어 있는 달의 입금은 다음 스냅샷에 합쳐진다 */
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

export function excelPositions(book: ExcelBook): Position[] {
  const foreign = new Set(book.foreign);
  const agg = new Map<string, { qty: number; cost: number }>();
  for (const l of book.lots.filter(isOpenLot)) {
    const a = agg.get(l.name) ?? { qty: 0, cost: 0 };
    a.qty += l.quantity;
    a.cost += l.quantity * l.buyPrice;
    agg.set(l.name, a);
  }
  return [...agg].map(([name, a]) => {
    const currency = foreign.has(name) ? 'USD' : 'KRW';
    const fx = currency === 'USD' ? book.usdKrw : 1;
    const costKRW = a.cost * fx;
    return {
      key: name,
      name,
      currency,
      quantity: a.qty,
      avgPrice: a.cost / a.qty,
      price: null,
      costKRW,
      valueKRW: costKRW,
      attrs: { currency: currency === 'USD' ? '달러 자산' : '원화 자산' },
    } satisfies Position;
  });
}

export function excelClosedTrades(book: ExcelBook): ClosedTrade[] {
  const foreign = new Set(book.foreign);
  return book.lots
    .filter((l) => !isOpenLot(l) && l.sellPrice !== undefined)
    .map((l) => {
      const fx = foreign.has(l.name) ? book.usdKrw : 1;
      const sell = l.sellPrice!;
      return {
        currency: foreign.has(l.name) ? ('USD' as const) : ('KRW' as const),
        name: l.name,
        quantity: l.quantity,
        buyPrice: l.buyPrice,
        sellPrice: sell,
        returnRate: l.returnRate ?? (l.buyPrice > 0 ? (sell - l.buyPrice) / l.buyPrice : 0),
        profitKRW: l.profitKRW ?? (sell - l.buyPrice) * l.quantity * fx,
        buyDate: l.buyDate,
        sellDate: l.sellDate,
        buyNote: l.buyNote,
        sellNote: l.sellNote,
      };
    })
    .sort((a, b) => (b.sellDate ?? '').localeCompare(a.sellDate ?? ''));
}

const nameHas = (...words: string[]) => (p: Position) => words.some((w) => p.name.toUpperCase().includes(w.toUpperCase()));

export function makeExcelModel(book: ExcelBook, today: ISODate = new Date().toISOString().slice(0, 10)): DashboardData {
  const snaps = excelSnapshots(book, today);
  const positions = excelPositions(book);
  return {
    source: 'excel',
    sourceLabel: `엑셀 · ${book.fileName}`,
    asOf: snaps.at(-1)?.date ?? today,
    accounts: book.accounts.map((a) => ({ id: a.id, name: a.name, principal: a.principal })),
    accountFilter: false,
    dimensions: [{ id: 'currency', label: '통화' }],
    hasDividends: false,
    goal: book.goal,
    usdKrw: book.usdKrw,
    snapshots: () => snaps,
    positions: () => positions.map((p) => ({ ...p, attrs: { ...p.attrs } })),
    cash: () => ({}),
    dividends: () => [],
    yearStarts: book.yearStarts,
    closedTrades: excelClosedTrades(book),
    defaultGroups: [
      { name: '배당주', match: nameHas('SCHD', '배당', 'JEPI', '미배다우') },
      { name: '채권', match: nameHas('SGOV', 'TLT', '채권', '국채') },
      { name: '성장주', match: nameHas('테슬라', '나스닥', '엔비디아', 'QQQ') },
    ],
  };
}
