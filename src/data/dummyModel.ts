import type { DashboardData, Position } from './model';
import type { PortfolioData } from './provider';
import { computeHoldings, computeSnapshots } from '../domain/portfolio';

/** 마이데이터 연동 시: makePortfolioModel(await loadPortfolio(new MyDataProvider(url)), { source: 'mydata', ... }) */
export function makeDummyModel(data: PortfolioData): DashboardData {
  return makePortfolioModel(data, { source: 'dummy', sourceLabel: '샘플 데이터' });
}

/**
 * 거래내역 + 일별 시세(PortfolioData) → 화면 데이터.
 * 더미 데이터와 마이데이터가 같은 형태라 이 어댑터를 함께 쓴다.
 */
export function makePortfolioModel(
  data: PortfolioData,
  opts: { source: DashboardData['source']; sourceLabel: string; updatedAt?: string },
): DashboardData {
  const idsKey = (ids: string[]) => [...ids].sort().join(',');
  const snapCache = new Map<string, ReturnType<typeof computeSnapshots>>();
  const holdCache = new Map<string, ReturnType<typeof computeHoldings>>();
  const holdings = (ids: string[]) => {
    const k = idsKey(ids);
    if (!holdCache.has(k)) holdCache.set(k, computeHoldings(data, ids));
    return holdCache.get(k)!;
  };
  const hasCode = (codes: string[]) => (p: Position) => codes.includes(p.key);

  return {
    source: opts.source,
    sourceLabel: opts.sourceLabel,
    updatedAt: opts.updatedAt,
    asOf: data.fx.dates.at(-1)!,
    accounts: data.accounts.map((a) => ({ id: a.id, name: a.name })),
    accountFilter: true,
    dimensions: [
      { id: 'assetClass', label: '자산유형' },
      { id: 'region', label: '지역' },
      { id: 'sector', label: '섹터' },
      { id: 'account', label: '계좌' },
    ],
    hasDividends: true,
    goal: null,
    usdKrw: data.fx.rates.at(-1)!,
    snapshots(ids) {
      const k = idsKey(ids);
      if (!snapCache.has(k)) snapCache.set(k, computeSnapshots(data, ids));
      return snapCache.get(k)!;
    },
    positions(ids) {
      return holdings(ids).holdings.map((h) => {
        const fx = h.instrument.currency === 'USD' ? h.valueKRW / (h.price * h.quantity) : 1;
        return {
          key: h.instrument.code,
          name: h.instrument.name,
          code: h.instrument.code,
          currency: h.instrument.currency,
          accountId: h.accountId,
          quantity: h.quantity,
          avgPrice: h.avgCostKRW / fx,
          price: h.price,
          costKRW: h.costKRW,
          valueKRW: h.valueKRW,
          attrs: { assetClass: h.instrument.assetClass, region: h.instrument.region, sector: h.instrument.sector },
        };
      });
    },
    cash(ids) {
      return holdings(ids).cashByAccount;
    },
    dividends(ids) {
      const set = new Set(ids);
      return data.transactions.filter((t) => t.type === 'DIVIDEND' && set.has(t.accountId));
    },
    deposits: depositsOf(data),
    defaultGroups: [
      { name: '배당주', match: hasCode(['SCHD', 'O', 'JNJ']) },
      { name: '성장주', match: hasCode(['NVDA', 'AAPL', 'MSFT', '000660']) },
      { name: '지수 ETF', match: hasCode(['069500', '360750']) },
      { name: '채권', match: hasCode(['148070']) },
    ],
  };
}

function depositsOf(data: PortfolioData): DashboardData['deposits'] {
  const idx = new Map(data.accounts.map((a, i) => [a.id, i]));
  const byDate = new Map<string, number[]>();
  for (const t of data.transactions) {
    if (t.type !== 'DEPOSIT' && t.type !== 'WITHDRAW') continue;
    const row = byDate.get(t.date) ?? data.accounts.map(() => 0);
    row[idx.get(t.accountId)!] += t.type === 'DEPOSIT' ? t.amountKRW : -t.amountKRW;
    byDate.set(t.date, row);
  }
  return {
    accounts: data.accounts.map((a) => a.name),
    rows: [...byDate].sort((a, b) => a[0].localeCompare(b[0])).map(([date, amounts]) => ({ date, amounts })),
  };
}
