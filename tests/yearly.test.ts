import { describe, expect, it } from 'vitest';
import { yearlyReturns } from '../src/domain/yearly';
import type { DailySnapshot } from '../src/types';

const snap = (date: string, value: number, netFlow = 0): DailySnapshot => ({ date, value, netFlow, principal: 0, profit: 0, simpleReturn: 0, twr: 0 });

describe('yearlyReturns (스냅샷만으로 계산)', () => {
  const snaps = [
    snap('2024-01-02', 1000, 1000), // 첫 입금
    snap('2024-06-28', 1300, 200),
    snap('2024-12-31', 1400),
    snap('2025-01-31', 1500, 100),
    snap('2025-03-31', 1450),
  ];
  const rows = yearlyReturns(snaps, [], '2025-03-31');

  it('첫해는 첫 스냅샷이 연초 자산', () => {
    const y = rows[0];
    expect(y).toMatchObject({ year: 2024, start: 1000, flow: 200, end: 1400, profit: 200, inProgress: false });
    expect(y.returnRate).toBeCloseTo(200 / 1200);
    // 1월 시작이라 월별 곡선 있음: 1월 0%, 6월 1300/(1000+200)−1, 12월 1400/1200−1
    expect(y.months.map((m) => m.month)).toEqual([1, 6, 12]);
    expect(y.months[0].ytd).toBeCloseTo(0);
    expect(y.months[2].ytd).toBeCloseTo(1400 / 1200 - 1);
  });

  it('다음 해는 전년 마지막 평가금이 연초 자산', () => {
    const y = rows[1];
    expect(y).toMatchObject({ year: 2025, start: 1400, flow: 100, end: 1450, inProgress: true });
    expect(y.returnRate).toBeCloseTo((1450 - 1400 - 100) / 1500);
    expect(y.months.map((m) => [m.month, +m.ytd.toFixed(6)])).toEqual([
      [1, +(1500 / 1500 - 1).toFixed(6)],
      [3, +(1450 / 1500 - 1).toFixed(6)],
    ]);
  });

  it('원본의 연초 값이 있으면 그 값을 우선', () => {
    const r = yearlyReturns(snaps, [{ year: 2025, start: 1350, flow: 150 }], '2025-03-31');
    expect(r[1]).toMatchObject({ start: 1350, flow: 150 });
  });

  it('데이터가 없으면 빈 목록', () => {
    expect(yearlyReturns([], [], '2025-01-01')).toEqual([]);
  });
});
