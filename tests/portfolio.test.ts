import { describe, expect, it } from 'vitest';
import type { PortfolioData } from '../src/data/provider';
import { generateDummy } from '../src/data/dummy';
import { computeHoldings, computeSnapshots, groupHoldings, periodStats, rebasedReturns, summarizeDividends } from '../src/domain/portfolio';
import { lastYearRange, presetRange, previousRange } from '../src/domain/period';
import type { Transaction } from '../src/types';

/** 손으로 계산 가능한 작은 데이터: 3영업일, 1종목 */
function tiny(transactions: Transaction[], closes = [100, 110, 99]): PortfolioData {
  const dates = ['2025-01-02', '2025-01-03', '2025-01-06'];
  return {
    provider: 'test',
    accounts: [{ id: 'A', name: '테스트', institution: '-', type: '위탁' }],
    instruments: [{ code: 'X', name: '종목X', currency: 'KRW', assetClass: '국내주식', region: '한국', sector: '-' }],
    transactions,
    prices: [{ code: 'X', dates, closes }],
    fx: { pair: 'USDKRW', dates, rates: [1300, 1300, 1300] },
  };
}

describe('computeSnapshots', () => {
  it('원금 · 평가금 · 수익금 · 단순수익률', () => {
    const data = tiny([
      { date: '2025-01-02', accountId: 'A', type: 'DEPOSIT', amountKRW: 1000 },
      { date: '2025-01-02', accountId: 'A', type: 'BUY', code: 'X', quantity: 10, price: 100, amountKRW: 1000 },
    ]);
    const s = computeSnapshots(data, ['A']);
    expect(s.map((x) => x.principal)).toEqual([1000, 1000, 1000]);
    expect(s.map((x) => x.value)).toEqual([1000, 1100, 990]);
    expect(s[1].profit).toBe(100);
    expect(s[2].simpleReturn).toBeCloseTo(-0.01);
  });

  it('TWR 은 중간 입금의 영향을 받지 않는다', () => {
    // 1일 1000 입금 → 10주. 2일 +10% 후 1100 추가 입금(현금 보유). 3일 주가 −10%
    const data = tiny([
      { date: '2025-01-02', accountId: 'A', type: 'DEPOSIT', amountKRW: 1000 },
      { date: '2025-01-02', accountId: 'A', type: 'BUY', code: 'X', quantity: 10, price: 100, amountKRW: 1000 },
      { date: '2025-01-06', accountId: 'A', type: 'DEPOSIT', amountKRW: 1100 },
    ]);
    const s = computeSnapshots(data, ['A']);
    // 3일 평가금 = 990 + 1100 = 2090, r3 = 2090 / (1100 + 1100) − 1 = −5%
    expect(s[2].value).toBe(2090);
    expect(s[2].netFlow).toBe(1100);
    expect(s[2].twr).toBeCloseTo(1.1 * 0.95 - 1, 10);
    // 단순수익률은 원금 2100 기준
    expect(s[2].simpleReturn).toBeCloseTo(-10 / 2100, 10);
  });

  it('출금하면 원금이 줄고 수익금은 유지된다', () => {
    const data = tiny([
      { date: '2025-01-02', accountId: 'A', type: 'DEPOSIT', amountKRW: 2000 },
      { date: '2025-01-03', accountId: 'A', type: 'WITHDRAW', amountKRW: 500 },
    ]);
    const s = computeSnapshots(data, ['A']);
    expect(s[1].principal).toBe(1500);
    expect(s[1].profit).toBe(0);
    expect(s[1].twr).toBeCloseTo(0, 10);
  });
});

describe('computeHoldings', () => {
  it('이동평균법: 일부 매도 후 평균단가 유지', () => {
    const data = tiny([
      { date: '2025-01-02', accountId: 'A', type: 'DEPOSIT', amountKRW: 5000 },
      { date: '2025-01-02', accountId: 'A', type: 'BUY', code: 'X', quantity: 10, price: 100, amountKRW: 1000 },
      { date: '2025-01-03', accountId: 'A', type: 'BUY', code: 'X', quantity: 10, price: 110, amountKRW: 1100 },
      { date: '2025-01-06', accountId: 'A', type: 'SELL', code: 'X', quantity: 5, price: 99, amountKRW: 495 },
    ]);
    const { holdings, cashByAccount, totalValue } = computeHoldings(data, ['A']);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].quantity).toBe(15);
    expect(holdings[0].avgCostKRW).toBeCloseTo(105);
    expect(holdings[0].valueKRW).toBe(15 * 99);
    expect(cashByAccount.A).toBe(5000 - 1000 - 1100 + 495);
    expect(totalValue).toBe(15 * 99 + 3395);
  });
});

describe('periodStats', () => {
  it('기간 수익금 = 평가금 변화 − 순입금', () => {
    const data = tiny([
      { date: '2025-01-02', accountId: 'A', type: 'DEPOSIT', amountKRW: 1000 },
      { date: '2025-01-02', accountId: 'A', type: 'BUY', code: 'X', quantity: 10, price: 100, amountKRW: 1000 },
      { date: '2025-01-06', accountId: 'A', type: 'DEPOSIT', amountKRW: 1100 },
    ]);
    const s = computeSnapshots(data, ['A']);
    const p = periodStats(s, data.transactions, '2025-01-06', '2025-01-06');
    expect(p.startValue).toBe(1100);
    expect(p.endValue).toBe(2090);
    expect(p.netFlow).toBe(1100);
    expect(p.periodProfit).toBe(-110);
    expect(p.twr).toBeCloseTo(-0.05, 10);
    expect(rebasedReturns(s, '2025-01-03', '2025-01-06').map((r) => r.value)).toEqual([expect.closeTo(0.1, 10), expect.closeTo(1.1 * 0.95 - 1, 10)]);
  });
});

describe('더미 데이터', () => {
  const d = generateDummy();
  const data: PortfolioData = { provider: 'dummy', ...d };
  const ids = d.accounts.map((a) => a.id);

  it('같은 seed 면 항상 같은 데이터', () => {
    expect(generateDummy().transactions).toEqual(d.transactions);
  });

  it('현금이 음수가 되지 않는다', () => {
    for (const id of ids) {
      for (const s of d.prices[0].dates.filter((_, i) => i % 20 === 0)) {
        const { cashByAccount } = computeHoldings(data, [id], s);
        expect(cashByAccount[id]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('계좌별 합 = 전체', () => {
    const all = computeSnapshots(data, ids).at(-1)!;
    const sum = ids.map((id) => computeSnapshots(data, [id]).at(-1)!).reduce((a, s) => ({ value: a.value + s.value, principal: a.principal + s.principal }), { value: 0, principal: 0 });
    expect(sum.value).toBeCloseTo(all.value, 4);
    expect(sum.principal).toBe(all.principal);
  });

  it('그룹 비중 합계 = 100%, 그룹 평가금 합 = 총 평가금', () => {
    const res = computeHoldings(data, ids);
    for (const dim of ['assetClass', 'region', 'sector', 'account'] as const) {
      const rows = groupHoldings(res, dim);
      expect(rows.reduce((s, r) => s + r.weight, 0)).toBeCloseTo(1, 10);
      expect(rows.reduce((s, r) => s + r.value, 0)).toBeCloseTo(res.totalValue, 4);
      expect(rows.length).toBeLessThanOrEqual(9); // 범주색 8개 + 현금
    }
  });

  it('스냅샷 평가금 = 보유종목 평가금 + 현금', () => {
    const last = computeSnapshots(data, ids).at(-1)!;
    expect(computeHoldings(data, ids).totalValue).toBeCloseTo(last.value, 4);
  });

  it('배당 합계 일치', () => {
    const sum = summarizeDividends(d.transactions, '2026-11-20');
    const total = d.transactions.filter((t) => t.type === 'DIVIDEND').reduce((s, t) => s + t.amountKRW, 0);
    expect(sum.byYear.reduce((s, y) => s + y.amount, 0)).toBe(total);
    expect(sum.byMonth.reduce((s, y) => s + y.amount, 0)).toBe(total);
  });
});

describe('기간 프리셋', () => {
  it('1년 / 올해 / 전체', () => {
    expect(presetRange('1Y', '2024-01-02', '2026-11-20')).toEqual({ start: '2025-11-21', end: '2026-11-20' });
    expect(presetRange('YTD', '2024-01-02', '2026-11-20')).toEqual({ start: '2026-01-01', end: '2026-11-20' });
    expect(presetRange('ALL', '2024-01-02', '2026-11-20')).toEqual({ start: '2024-01-02', end: '2026-11-20' });
    expect(presetRange('3Y', '2024-01-02', '2026-11-20').start).toBe('2024-01-02');
  });

  it('직전 기간 · 전년 동기', () => {
    expect(previousRange({ start: '2026-11-01', end: '2026-11-10' })).toEqual({ start: '2026-10-22', end: '2026-10-31' });
    expect(lastYearRange({ start: '2024-02-29', end: '2024-03-31' })).toEqual({ start: '2023-02-28', end: '2023-03-31' });
  });
});
