import type { YearStart } from '../data/model';
import type { DailySnapshot, ISODate } from '../types';

// ─────────────────────────────────────────────────────────────
// 연초 대비 수익률 (엑셀 Summary 와 같은 계산)
//   연간  = (연말 자산 − 연초 자산 − 연중 순입금) / (연초 자산 + 연중 순입금)
//   월별 = 그달 말 자산 / (연초 자산 + 1월~그달 순입금) − 1
// 연초 자산 = 전년도 마지막 평가금. 원본(엑셀 년도 표)에 값이 있으면 그 값을 쓴다.
// ─────────────────────────────────────────────────────────────

export interface YearMonthPoint {
  month: number; // 1~12
  date: ISODate;
  value: number;
  ytd: number;
}

export interface YearRow {
  year: number;
  start: number;
  flow: number;
  end: number;
  profit: number;
  returnRate: number;
  inProgress: boolean;
  months: YearMonthPoint[];
}

export function yearlyReturns(snaps: DailySnapshot[], yearStarts: YearStart[] = [], asOf?: ISODate): YearRow[] {
  if (!snaps.length) return [];
  const starts = new Map(yearStarts.map((y) => [y.year, y]));
  const years = new Set<number>(snaps.map((s) => Number(s.date.slice(0, 4))));
  for (const y of yearStarts) years.add(y.year);
  const lastYear = Number((asOf ?? snaps.at(-1)!.date).slice(0, 4));

  const rows: YearRow[] = [];
  for (const year of [...years].sort((a, b) => a - b)) {
    if (year > lastYear) continue;
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const inYear = snaps.filter((s) => s.date >= from && s.date <= to);
    const before = snaps.filter((s) => s.date < from).at(-1);
    const override = starts.get(year);
    const nextOverride = starts.get(year + 1);

    // 연초 기준점: 전년 말 스냅샷 → 없으면 그해 첫 스냅샷 (그 날까지 입금은 연초 자산에 포함)
    const base = before ?? inYear[0];
    if (!base && !override) continue;
    const baseIsInYear = !before && !!inYear[0];
    const afterBase = baseIsInYear ? inYear.slice(1) : inYear;

    const start = override?.start ?? base!.value;
    const flow = override?.flow ?? afterBase.reduce((s, x) => s + x.netFlow, 0);
    const lastInYear = inYear.at(-1);
    const end = nextOverride?.start ?? lastInYear?.value ?? start;
    const inProgress = !nextOverride && year === lastYear;
    const denom = start + flow;
    const profit = end - start - flow;

    // 월별 곡선: 전년 12월 스냅샷이 있거나, 그해에 처음 시작한 경우에만 의미가 있다
    const months: YearMonthPoint[] = [];
    const decBefore = before && before.date >= `${year - 1}-12-01`;
    if (decBefore || (baseIsInYear && base!.date.slice(5, 7) === '01')) {
      const monthStart = decBefore ? (override?.start ?? before!.value) : base!.value;
      let cum = 0;
      let idx = 0;
      for (let m = 1; m <= 12; m++) {
        const mKey = `${year}-${String(m).padStart(2, '0')}`;
        let last: DailySnapshot | undefined;
        while (idx < afterBase.length && afterBase[idx].date.slice(0, 7) <= mKey) {
          cum += afterBase[idx].netFlow;
          last = afterBase[idx];
          idx++;
        }
        if (baseIsInYear && m === 1 && !last) last = base;
        if (!last) continue;
        months.push({ month: m, date: last.date, value: last.value, ytd: last.value / (monthStart + cum) - 1 });
      }
    }

    rows.push({
      year,
      start,
      flow,
      end,
      profit,
      returnRate: denom > 0 ? profit / denom : 0,
      inProgress,
      months: months.length >= 2 ? months : [],
    });
  }
  return rows;
}
