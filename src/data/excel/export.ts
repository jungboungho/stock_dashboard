import type { GroupStore } from '../../domain/groups';
import { yearlyReturns } from '../../domain/yearly';
import { bookUsdKrw, excelSnapshots } from '../excelModel';
import { accountTotals, holdingKey, rowCostKRW, rowValueKRW, type HoldingsState } from '../holdings';
import {
  CASH_CODE,
  DAILY_SHEET,
  GROUPS_SHEET,
  HOLDINGS_SHEET,
  MONTHLY_SHEET,
  OLD_SNAPSHOT_SHEET,
  type DailyRow,
  type ExcelBook,
  type ExcelGroup,
} from './parse';
import type { CellUpdate, SheetData } from './write';

/** 그룹 설정(화면) → 엑셀 '그룹' 시트에 쓸 목록 */
export function groupsForExport(store: GroupStore): ExcelGroup[] {
  return store.groups.map((g) => ({ name: g.name, keys: Object.entries(store.members).filter(([, id]) => id === g.id).map(([k]) => k) }));
}

const round = (n: number, d = 0) => Math.round(n * 10 ** d) / 10 ** d;

/** 그날 보유종목 기준 계좌별 평가금을 일별 기록에 넣는다 (같은 날짜는 바꿈) */
export function upsertDaily(log: DailyRow[], h: HoldingsState, usdKrw: number, date: string): DailyRow[] {
  if (!h.rows.length && !h.cash.length) return log;
  const accounts: Record<string, number> = {};
  for (const [a, t] of Object.entries(accountTotals(h, usdKrw))) accounts[a] = round(t.value + t.cash);
  const row: DailyRow = { date, total: round(Object.values(accounts).reduce((s, v) => s + v, 0)), accounts };
  return [...log.filter((r) => r.date !== date), row].sort((a, b) => a.date.localeCompare(b.date));
}

export function buildExportSheets(book: ExcelBook, groups: ExcelGroup[], today = new Date().toISOString().slice(0, 10)): SheetData[] {
  const h = book.holdings;
  const usdKrw = bookUsdKrw(book);
  const date = (h.asOf ?? new Date().toISOString()).slice(0, 10);
  const groupOf = new Map<string, string>();
  for (const g of groups) for (const k of g.keys) groupOf.set(k, g.name);

  // ── 보유종목
  const holdingRows = [...h.rows]
    .sort((a, b) => a.account.localeCompare(b.account) || rowValueKRW(b, usdKrw) - rowValueKRW(a, usdKrw))
    .map((r) => {
      const value = rowValueKRW(r, usdKrw);
      const cost = rowCostKRW(r, usdKrw);
      return [date, r.account, r.code, r.name, r.currency, r.quantity, round(r.avgPrice, 4), r.price, r.currency === 'USD' ? usdKrw : null, round(cost), round(value), round(value - cost), groupOf.get(holdingKey(r)) ?? ''];
    });
  const cashRows = h.cash.map((c) => [date, c.account, CASH_CODE, CASH_CODE, c.currency, c.amount, null, null, c.currency === 'USD' ? usdKrw : null, null, round(c.amount * (c.currency === 'USD' ? usdKrw : 1)), null, '']);

  // ── 그룹
  const names = new Map(h.rows.map((r) => [holdingKey(r), r]));
  const groupRows: (string | null)[][] = [];
  for (const g of groups) {
    if (!g.keys.length) groupRows.push([g.name, null, null]);
    for (const k of g.keys) {
      const r = names.get(k);
      groupRows.push([g.name, r?.code || null, r?.name ?? k]);
    }
  }

  // ── 일별 · 월별 자산추이 (화면의 자산 추이와 같은 계산)
  const snaps = excelSnapshots(book, today);
  const snapOf = new Map(snaps.map((s) => [s.date, s]));
  const known = [...book.depositAccounts];
  for (const d of book.dailyLog) for (const a of Object.keys(d.accounts)) if (!known.includes(a)) known.push(a);
  const accountCols = known.filter((a) => book.dailyLog.some((d) => a in d.accounts));
  const dailyRows = book.dailyLog.map((d) => {
    const s = snapOf.get(d.date);
    return [d.date, d.total, s ? round(s.principal) : null, s ? round(d.total - s.principal) : null, s && s.principal > 0 ? round((d.total - s.principal) / s.principal, 4) : null, ...accountCols.map((a) => d.accounts[a] ?? null)];
  });

  const dailyMonths = new Set(book.dailyLog.map((d) => d.date.slice(0, 7)));
  if (h.asOf && (h.rows.length || h.cash.length)) dailyMonths.add(h.asOf.slice(0, 7));
  const ytd = new Map<string, number>();
  for (const y of yearlyReturns(snaps, book.yearStarts, snaps.at(-1)?.date ?? today)) for (const m of y.months) ytd.set(m.date.slice(0, 7), m.ytd);
  const lastOfMonth = new Map<string, (typeof snaps)[number]>();
  const flowOfMonth = new Map<string, number>();
  for (const s of snaps) {
    const m = s.date.slice(0, 7);
    lastOfMonth.set(m, s);
    flowOfMonth.set(m, (flowOfMonth.get(m) ?? 0) + s.netFlow);
  }
  let prevTwr = 0;
  const monthlyRows = [...lastOfMonth].map(([m, s]) => {
    const monthReturn = (1 + s.twr) / (1 + prevTwr) - 1;
    prevTwr = s.twr;
    return [m, round(s.value), round(flowOfMonth.get(m) ?? 0), round(s.principal), round(s.profit), round(s.simpleReturn, 4), round(monthReturn, 4), ytd.has(m) ? round(ytd.get(m)!, 4) : null, dailyMonths.has(m) ? `일별 ${s.date}` : 'Summary'];
  });

  return [
    {
      name: HOLDINGS_SHEET,
      widths: [11, 8, 10, 30, 6, 10, 11, 11, 9, 14, 14, 14, 10],
      rows: [['기준일', '계좌', '종목코드', '종목명', '통화', '수량', '평균단가', '현재가', '환율', '매입금액(원)', '평가금액(원)', '평가손익(원)', '그룹'], ...holdingRows, ...cashRows],
    },
    { name: GROUPS_SHEET, widths: [12, 10, 30], rows: [['그룹', '종목코드', '종목명'], ...groupRows] },
    {
      name: DAILY_SHEET,
      renameFrom: OLD_SNAPSHOT_SHEET,
      widths: [11, 15, 15, 15, 9, ...accountCols.map(() => 14)],
      rows: [['날짜', '총자산(원)', '투자원금(원)', '수익금(원)', '수익률', ...accountCols], ...dailyRows],
    },
    {
      name: MONTHLY_SHEET,
      widths: [9, 15, 14, 15, 15, 9, 9, 9, 16],
      rows: [['월', '기말자산(원)', '순입금(원)', '투자원금(원)', '수익금(원)', '수익률', '월 수익률', '연초대비', '기준'], ...monthlyRows],
    },
  ];
}

/**
 * Summary 기말자산 칸을 '월별 자산추이' 시트와 연결하는 수식.
 * 일별 기록이 시작된 달부터 아래 모든 행에 넣는다 (그 전 달은 직접 입력한 값 그대로).
 * 수식 값은 엑셀이 다시 계산하지만, 대시보드가 바로 읽을 수 있게 계산된 값도 함께 넣는다.
 */
export function summaryLinkCells(
  book: ExcelBook,
  target: { col: string; rows: Record<string, number> },
  monthlyValues: Record<string, number>,
  fromMonth: string,
): CellUpdate[] {
  const sheet = `'${MONTHLY_SHEET}'`;
  return Object.entries(target.rows)
    .filter(([m]) => m >= fromMonth)
    .map(([m, row]) => {
      const key = `IF(ISNUMBER($A${row}),TEXT($A${row},"yyyy-mm"),TRIM($A${row}))`;
      const formula = `IFERROR(INDEX(${sheet}!$B:$B,MATCH(${key},${sheet}!$A:$A,0))/${book.unit},"")`;
      const v = monthlyValues[m];
      return { ref: `${target.col}${row}`, formula, value: v === undefined ? '' : v / book.unit };
    });
}

/** 월별 시트에 쓴 월 → 기말자산 (원) */
export function monthlyFromSheets(sheets: SheetData[]): Record<string, number> {
  const s = sheets.find((x) => x.name === MONTHLY_SHEET);
  const out: Record<string, number> = {};
  for (const r of s?.rows.slice(1) ?? []) if (typeof r[0] === 'string' && typeof r[1] === 'number') out[r[0]] = r[1];
  return out;
}
