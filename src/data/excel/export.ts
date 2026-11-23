import type { GroupStore } from '../../domain/groups';
import { accountTotals, holdingKey, rowCostKRW, rowValueKRW, type HoldingsState } from '../holdings';
import { CASH_CODE, GROUPS_SHEET, HOLDINGS_SHEET, SNAPSHOT_SHEET, type ExcelBook, type ExcelGroup, type SnapshotLogRow } from './parse';
import type { SheetData } from './write';

/** 그룹 설정(화면) → 엑셀 '그룹' 시트에 쓸 목록 */
export function groupsForExport(store: GroupStore): ExcelGroup[] {
  return store.groups.map((g) => ({ name: g.name, keys: Object.entries(store.members).filter(([, id]) => id === g.id).map(([k]) => k) }));
}

const round = (n: number, d = 0) => Math.round(n * 10 ** d) / 10 ** d;

/** 오늘 계좌별 평가금을 자산스냅샷에 넣는다 (같은 날짜는 바꿈) */
export function nextSnapshotLog(log: SnapshotLogRow[], h: HoldingsState, usdKrw: number, date: string): SnapshotLogRow[] {
  const totals = accountTotals(h, usdKrw);
  const today = Object.entries(totals).map(([account, t]) => ({ date, account, value: round(t.value + t.cash) }));
  if (today.length) today.push({ date, account: '합계', value: round(today.reduce((s, r) => s + r.value, 0)) });
  return [...log.filter((r) => r.date !== date), ...today].sort((a, b) => a.date.localeCompare(b.date));
}

export function buildExportSheets(book: ExcelBook, groups: ExcelGroup[], log: SnapshotLogRow[]): SheetData[] {
  const h = book.holdings;
  const usdKrw = h.usdKrw ?? book.usdKrw;
  const date = (h.asOf ?? new Date().toISOString()).slice(0, 10);
  const groupOf = new Map<string, string>();
  for (const g of groups) for (const k of g.keys) groupOf.set(k, g.name);

  const holdingRows = [...h.rows]
    .sort((a, b) => a.account.localeCompare(b.account) || rowValueKRW(b, usdKrw) - rowValueKRW(a, usdKrw))
    .map((r) => {
      const value = rowValueKRW(r, usdKrw);
      const cost = rowCostKRW(r, usdKrw);
      return [date, r.account, r.code, r.name, r.currency, r.quantity, round(r.avgPrice, 4), r.price, r.currency === 'USD' ? usdKrw : null, round(cost), round(value), round(value - cost), groupOf.get(holdingKey(r)) ?? ''];
    });
  const cashRows = h.cash.map((c) => [date, c.account, CASH_CODE, CASH_CODE, c.currency, c.amount, null, null, c.currency === 'USD' ? usdKrw : null, null, round(c.amount * (c.currency === 'USD' ? usdKrw : 1)), null, '']);

  const names = new Map(h.rows.map((r) => [holdingKey(r), r]));
  const groupRows: (string | null)[][] = [];
  for (const g of groups) {
    if (!g.keys.length) groupRows.push([g.name, null, null]);
    for (const k of g.keys) {
      const r = names.get(k);
      groupRows.push([g.name, r?.code || null, r?.name ?? k]);
    }
  }

  return [
    {
      name: HOLDINGS_SHEET,
      widths: [11, 8, 10, 30, 6, 10, 11, 11, 9, 14, 14, 14, 10],
      rows: [['기준일', '계좌', '종목코드', '종목명', '통화', '수량', '평균단가', '현재가', '환율', '매입금액(원)', '평가금액(원)', '평가손익(원)', '그룹'], ...holdingRows, ...cashRows],
    },
    { name: GROUPS_SHEET, widths: [12, 10, 30], rows: [['그룹', '종목코드', '종목명'], ...groupRows] },
    { name: SNAPSHOT_SHEET, widths: [11, 8, 16], rows: [['기준일', '계좌', '평가금액(원)'], ...log.map((r) => [r.date, r.account, r.value])] },
  ];
}
