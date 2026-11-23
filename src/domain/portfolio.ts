import type { PortfolioData } from '../data/provider';
import type { DailySnapshot, GroupDimension, Holding, Instrument, ISODate, Transaction } from '../types';

// ─────────────────────────────────────────────────────────────
// 계산 규칙
//   원금      = 누적 입금 − 누적 출금
//   평가금    = 현금 + Σ(보유수량 × 종가 × 환율)
//   수익금    = 평가금 − 원금            (배당 · 매매차익 · 환차익 모두 포함)
//   단순수익률 = 수익금 / 원금
//   TWR       = Π(1 + r_d) − 1,  r_d = V_d / (V_{d-1} + F_d) − 1   (입출금 F_d 는 장 시작 전에 들어온 것으로 본다)
// ─────────────────────────────────────────────────────────────

const accountFilter = (ids: string[]) => {
  const set = new Set(ids);
  return (t: Transaction) => set.has(t.accountId);
};

/** 가격 · 환율 조회기 (해당 날짜에 값이 없으면 직전 값) */
export function makePriceBook(data: PortfolioData) {
  const byCode = new Map(data.prices.map((p) => [p.code, p]));
  const instruments = new Map(data.instruments.map((i) => [i.code, i]));
  const fxIndex = new Map(data.fx.dates.map((d, i) => [d, i]));
  const priceIndex = new Map(data.prices.map((p) => [p.code, new Map(p.dates.map((d, i) => [d, i]))]));

  const lookup = (dates: ISODate[], values: number[], index: Map<ISODate, number>, date: ISODate) => {
    const exact = index.get(date);
    if (exact !== undefined) return values[exact];
    let lo = 0;
    let hi = dates.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] <= date) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans >= 0 ? values[ans] : values[0];
  };

  const fx = (date: ISODate) => lookup(data.fx.dates, data.fx.rates, fxIndex, date);
  const price = (code: string, date: ISODate) => {
    const p = byCode.get(code);
    if (!p) throw new Error(`가격 없음: ${code}`);
    return lookup(p.dates, p.closes, priceIndex.get(code)!, date);
  };
  const krw = (code: string, date: ISODate) => price(code, date) * (instruments.get(code)?.currency === 'USD' ? fx(date) : 1);

  return { fx, price, krw, instruments };
}

/** 평가 기준일 목록 = 가격 데이터의 날짜 */
export function tradingDates(data: PortfolioData): ISODate[] {
  return data.fx.dates;
}

export function computeSnapshots(data: PortfolioData, accountIds: string[]): DailySnapshot[] {
  const book = makePriceBook(data);
  const txs = data.transactions.filter(accountFilter(accountIds));
  const dates = tradingDates(data);

  let cash = 0;
  let principal = 0;
  const shares = new Map<string, number>();
  let prevValue = 0;
  let growth = 1;
  let t = 0;
  const out: DailySnapshot[] = [];

  for (const date of dates) {
    let netFlow = 0;
    while (t < txs.length && txs[t].date <= date) {
      const x = txs[t++];
      switch (x.type) {
        case 'DEPOSIT':
          cash += x.amountKRW;
          principal += x.amountKRW;
          netFlow += x.amountKRW;
          break;
        case 'WITHDRAW':
          cash -= x.amountKRW;
          principal -= x.amountKRW;
          netFlow -= x.amountKRW;
          break;
        case 'BUY':
          cash -= x.amountKRW;
          shares.set(x.code!, (shares.get(x.code!) ?? 0) + x.quantity!);
          break;
        case 'SELL':
          cash += x.amountKRW;
          shares.set(x.code!, (shares.get(x.code!) ?? 0) - x.quantity!);
          break;
        case 'DIVIDEND':
          cash += x.amountKRW;
          break;
      }
    }
    let value = cash;
    for (const [code, q] of shares) if (q) value += q * book.krw(code, date);

    const base = prevValue + netFlow;
    if (base > 0) growth *= value / base;
    prevValue = value;

    const profit = value - principal;
    out.push({
      date,
      principal,
      value,
      profit,
      simpleReturn: principal > 0 ? profit / principal : 0,
      netFlow,
      twr: growth - 1,
    });
  }
  return out;
}

export interface HoldingsResult {
  holdings: Holding[];
  cashByAccount: Record<string, number>;
  totalValue: number;
}

/** 기준일 시점 보유 종목 (이동평균법 원가) */
export function computeHoldings(data: PortfolioData, accountIds: string[], asOf?: ISODate): HoldingsResult {
  const book = makePriceBook(data);
  const date = asOf ?? tradingDates(data).at(-1)!;
  const txs = data.transactions.filter(accountFilter(accountIds)).filter((x) => x.date <= date);

  const pos = new Map<string, { accountId: string; code: string; qty: number; cost: number }>();
  const cashByAccount: Record<string, number> = Object.fromEntries(accountIds.map((id) => [id, 0]));

  for (const x of txs) {
    const key = `${x.accountId}|${x.code}`;
    switch (x.type) {
      case 'DEPOSIT':
      case 'DIVIDEND':
        cashByAccount[x.accountId] += x.amountKRW;
        break;
      case 'WITHDRAW':
        cashByAccount[x.accountId] -= x.amountKRW;
        break;
      case 'BUY': {
        cashByAccount[x.accountId] -= x.amountKRW;
        const p = pos.get(key) ?? { accountId: x.accountId, code: x.code!, qty: 0, cost: 0 };
        p.qty += x.quantity!;
        p.cost += x.amountKRW;
        pos.set(key, p);
        break;
      }
      case 'SELL': {
        cashByAccount[x.accountId] += x.amountKRW;
        const p = pos.get(key);
        if (!p || p.qty <= 0) break;
        const ratio = Math.min(1, x.quantity! / p.qty);
        p.cost -= p.cost * ratio;
        p.qty -= x.quantity!;
        break;
      }
    }
  }

  const holdings: Holding[] = [];
  for (const p of pos.values()) {
    if (p.qty <= 0) continue;
    const instrument = book.instruments.get(p.code)!;
    const valueKRW = p.qty * book.krw(p.code, date);
    holdings.push({
      accountId: p.accountId,
      instrument,
      quantity: p.qty,
      avgCostKRW: p.cost / p.qty,
      price: book.price(p.code, date),
      valueKRW,
      costKRW: p.cost,
      profitKRW: valueKRW - p.cost,
      returnRate: p.cost > 0 ? (valueKRW - p.cost) / p.cost : 0,
    });
  }
  holdings.sort((a, b) => b.valueKRW - a.valueKRW);
  const cash = Object.values(cashByAccount).reduce((a, b) => a + b, 0);
  const totalValue = holdings.reduce((s, h) => s + h.valueKRW, 0) + cash;
  return { holdings, cashByAccount, totalValue };
}

export interface GroupRow {
  key: string;
  value: number;
  cost: number;
  profit: number;
  returnRate: number;
  weight: number;
  count: number;
}

export const CASH_GROUP = '현금';

export function groupHoldings(
  result: HoldingsResult,
  dim: GroupDimension,
  accountName: (id: string) => string = (id) => id,
): GroupRow[] {
  const rows = new Map<string, GroupRow>();
  const add = (key: string, value: number, cost: number, count: number) => {
    const r = rows.get(key) ?? { key, value: 0, cost: 0, profit: 0, returnRate: 0, weight: 0, count: 0 };
    r.value += value;
    r.cost += cost;
    r.count += count;
    rows.set(key, r);
  };
  const keyOf = (h: Holding) => (dim === 'account' ? accountName(h.accountId) : h.instrument[dim as keyof Instrument]);

  for (const h of result.holdings) add(keyOf(h), h.valueKRW, h.costKRW, 1);
  for (const [id, cash] of Object.entries(result.cashByAccount)) {
    if (Math.round(cash) === 0) continue;
    add(dim === 'account' ? accountName(id) : CASH_GROUP, cash, cash, 0);
  }

  const total = result.totalValue || 1;
  return [...rows.values()]
    .map((r) => ({ ...r, profit: r.value - r.cost, returnRate: r.cost > 0 ? (r.value - r.cost) / r.cost : 0, weight: r.value / total }))
    .sort((a, b) => b.value - a.value);
}

// ─── 기간 분석 ────────────────────────────────────────────────

export interface PeriodStats {
  start: ISODate;
  end: ISODate;
  startValue: number;
  endValue: number;
  startPrincipal: number;
  endPrincipal: number;
  netFlow: number;
  /** 기간 중 늘어난 수익금 = 평가금 변화 − 순입금 */
  periodProfit: number;
  /** 기간 시간가중수익률 */
  twr: number;
  dividends: number;
}

/** 기간 시작일 직전 영업일 종가를 기준값으로 삼는다 */
export function periodStats(snaps: DailySnapshot[], txs: Transaction[], start: ISODate, end: ISODate): PeriodStats {
  const inRange = snaps.filter((s) => s.date >= start && s.date <= end);
  const before = snaps.filter((s) => s.date < start).at(-1);
  const last = inRange.at(-1) ?? before;
  const baseValue = before?.value ?? 0;
  const baseGrowth = 1 + (before?.twr ?? 0);
  const netFlow = inRange.reduce((s, x) => s + x.netFlow, 0);
  const dividends = txs.filter((t) => t.type === 'DIVIDEND' && t.date >= start && t.date <= end).reduce((s, t) => s + t.amountKRW, 0);
  const endValue = last?.value ?? 0;
  return {
    start,
    end,
    startValue: baseValue,
    endValue,
    startPrincipal: before?.principal ?? 0,
    endPrincipal: last?.principal ?? 0,
    netFlow,
    periodProfit: endValue - baseValue - netFlow,
    twr: last ? (1 + last.twr) / baseGrowth - 1 : 0,
    dividends,
  };
}

/** 기간 시작을 0% 로 맞춘 누적 수익률 곡선 (기간 비교용) */
export function rebasedReturns(snaps: DailySnapshot[], start: ISODate, end: ISODate): { day: number; date: ISODate; value: number }[] {
  const before = snaps.filter((s) => s.date < start).at(-1);
  const base = 1 + (before?.twr ?? 0);
  return snaps
    .filter((s) => s.date >= start && s.date <= end)
    .map((s, i) => ({ day: i + 1, date: s.date, value: (1 + s.twr) / base - 1 }));
}

// ─── 배당 ─────────────────────────────────────────────────────

export interface DividendSummary {
  byMonth: { month: string; amount: number }[];
  byYear: { year: string; amount: number }[];
  byInstrument: { code: string; amount: number; count: number }[];
  trailing12m: number;
}

export function summarizeDividends(txs: Transaction[], asOf: ISODate): DividendSummary {
  const divs = txs.filter((t) => t.type === 'DIVIDEND' && t.date <= asOf);
  const months = new Map<string, number>();
  const years = new Map<string, number>();
  const inst = new Map<string, { amount: number; count: number }>();
  for (const d of divs) {
    const m = d.date.slice(0, 7);
    months.set(m, (months.get(m) ?? 0) + d.amountKRW);
    years.set(m.slice(0, 4), (years.get(m.slice(0, 4)) ?? 0) + d.amountKRW);
    const r = inst.get(d.code!) ?? { amount: 0, count: 0 };
    r.amount += d.amountKRW;
    r.count += 1;
    inst.set(d.code!, r);
  }
  const cutoff = new Date(`${asOf}T00:00:00Z`);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  const from = cutoff.toISOString().slice(0, 10);
  return {
    byMonth: [...months].map(([month, amount]) => ({ month, amount })).sort((a, b) => a.month.localeCompare(b.month)),
    byYear: [...years].map(([year, amount]) => ({ year, amount })).sort((a, b) => a.year.localeCompare(b.year)),
    byInstrument: [...inst].map(([code, r]) => ({ code, ...r })).sort((a, b) => b.amount - a.amount),
    trailing12m: divs.filter((d) => d.date > from).reduce((s, d) => s + d.amountKRW, 0),
  };
}
