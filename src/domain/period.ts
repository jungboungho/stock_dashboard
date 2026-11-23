import type { ISODate } from '../types';

export interface DateRange {
  start: ISODate;
  end: ISODate;
}

export type Preset = '1M' | '3M' | '6M' | 'YTD' | '1Y' | '3Y' | 'ALL';

export const PRESETS: { id: Preset; label: string }[] = [
  { id: '1M', label: '1개월' },
  { id: '3M', label: '3개월' },
  { id: '6M', label: '6개월' },
  { id: 'YTD', label: '올해' },
  { id: '1Y', label: '1년' },
  { id: 'ALL', label: '전체' },
];

const toDate = (d: ISODate) => new Date(`${d}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(d: ISODate, days: number): ISODate {
  const x = toDate(d);
  x.setUTCDate(x.getUTCDate() + days);
  return toIso(x);
}

export function addMonths(d: ISODate, months: number): ISODate {
  const x = toDate(d);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + months);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return toIso(x);
}

const clamp = (d: ISODate, min: ISODate, max: ISODate) => (d < min ? min : d > max ? max : d);

/** 마지막 날짜(end) 기준 프리셋 범위. 시작일은 first 보다 앞설 수 없다 */
export function presetRange(preset: Preset, first: ISODate, last: ISODate): DateRange {
  const months: Partial<Record<Preset, number>> = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '3Y': 36 };
  let start: ISODate;
  if (preset === 'ALL') start = first;
  else if (preset === 'YTD') start = `${last.slice(0, 4)}-01-01`;
  else start = addDays(addMonths(last, -months[preset]!), 1);
  return { start: clamp(start, first, last), end: last };
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
}

/** 비교 기간 제안: 바로 앞의 같은 길이 기간 */
export function previousRange(r: DateRange): DateRange {
  const len = daysBetween(r.start, r.end);
  const end = addDays(r.start, -1);
  return { start: addDays(end, -len), end };
}

/** 비교 기간 제안: 1년 전 같은 기간 */
export function lastYearRange(r: DateRange): DateRange {
  return { start: addMonths(r.start, -12), end: addMonths(r.end, -12) };
}
