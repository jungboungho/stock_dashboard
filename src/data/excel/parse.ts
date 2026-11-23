import type { SheetCells, Workbook } from './xlsx';
import type { YearStart } from '../model';
import type { ISODate } from '../../types';

/**
 * 사용자가 관리하던 '주식.xlsx' 구조를 읽어 앱 데이터로 바꾼다.
 *
 * Summary        : 계좌별 원금 · 목표 · 단위, 년도 표(연초 총자산 · 연중 변경), 월별 표(계좌별 입금 · 기말자산)
 * 투자내역        : 종목별 매수 · 매도 기록 (판매가격 · 판매날짜가 없으면 보유 중)
 * 해외주식리스트   : 달러 종목 이름, 환율
 *
 * 셀 위치가 아니라 머리글 글자('년도', '날짜', '기말자산', '종목' ...)로 표를 찾으므로 행이 늘어나도 동작한다.
 */

export interface ExcelLot {
  name: string;
  quantity: number;
  buyPrice: number;
  sellPrice?: number;
  returnRate?: number;
  profitKRW?: number;
  buyDate?: ISODate;
  sellDate?: ISODate;
  buyNote?: string;
  sellNote?: string;
}

export interface ExcelMonth {
  month: string; // YYYY-MM
  /** 계좌 순서대로 그 달 순입금 (원) */
  flows: number[];
  /** 기말자산 (원), 비어 있으면 null */
  endValue: number | null;
}

export interface ExcelBook {
  version: 1;
  fileName: string;
  importedAt: string;
  unit: number;
  goal: number | null;
  usdKrw: number;
  accounts: { id: string; name: string; principal: number }[];
  yearStarts: YearStart[];
  months: ExcelMonth[];
  lots: ExcelLot[];
  foreign: string[];
}

// ─── 셀 도우미 ────────────────────────────────────────────────

const colToNum = (col: string) => [...col].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const numToCol = (n: number) => {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

interface Grid {
  get(col: string | number, row: number): string | number | undefined;
  rows: number[];
  maxCol: number;
}

function grid(cells: SheetCells): Grid {
  const rowSet = new Set<number>();
  let maxCol = 0;
  for (const ref of Object.keys(cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) continue;
    rowSet.add(Number(m[2]));
    maxCol = Math.max(maxCol, colToNum(m[1]));
  }
  return {
    get: (col, row) => cells[`${typeof col === 'number' ? numToCol(col) : col}${row}`],
    rows: [...rowSet].sort((a, b) => a - b),
    maxCol,
  };
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/,/g, '')))) return Number(v.replace(/,/g, ''));
  return undefined;
};

/** 엑셀 날짜 일련번호 → YYYY-MM-DD */
export function serialToIso(serial: number): ISODate {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000).toISOString().slice(0, 10);
}

function toMonth(v: unknown): string | undefined {
  if (typeof v === 'number') return v > 20000 ? serialToIso(v).slice(0, 7) : undefined;
  const m = /^(\d{4})[-./](\d{1,2})/.exec(str(v));
  return m ? `${m[1]}-${m[2].padStart(2, '0')}` : undefined;
}

function toDate(v: unknown): ISODate | undefined {
  if (typeof v === 'number' && v > 20000) return serialToIso(v);
  const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(str(v));
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : undefined;
}

/** 머리글 행에서 글자 → 열 번호 */
function headerMap(g: Grid, row: number): Map<string, number> {
  const map = new Map<string, number>();
  for (let c = 1; c <= g.maxCol; c++) {
    const h = str(g.get(c, row));
    if (h && !map.has(h)) map.set(h, c);
  }
  return map;
}

const findRow = (g: Grid, pred: (row: number) => boolean) => g.rows.find(pred);

function findSheet(book: Workbook, ...names: string[]): SheetCells | undefined {
  for (const n of names) {
    const hit = Object.keys(book).find((k) => k.trim().toLowerCase() === n.toLowerCase());
    if (hit) return book[hit];
  }
  return undefined;
}

// ─── 시트별 해석 ──────────────────────────────────────────────

export function parseStockBook(book: Workbook, fileName = '주식.xlsx'): ExcelBook {
  const summary = findSheet(book, 'Summary', '요약');
  if (!summary) throw new Error("'Summary' 시트를 찾지 못했습니다");
  const g = grid(summary);

  // 단위 · 목표 (C열 이름, D열 값)
  let unit = 1;
  let goal: number | null = null;
  for (const r of g.rows) {
    for (let c = 1; c < g.maxCol; c++) {
      const label = str(g.get(c, r));
      if (label === '단위') unit = num(g.get(c + 1, r)) ?? unit;
      if (label === '목표') goal = num(g.get(c + 1, r)) ?? goal;
    }
  }

  // 계좌 목록: 맨 위 A열 이름 + B열 원금, 빈 행에서 멈춤
  const accounts: ExcelBook['accounts'] = [];
  for (let r = 1; r < 20; r++) {
    const name = str(g.get('A', r));
    const principal = num(g.get('B', r));
    if (!name || principal === undefined) break;
    accounts.push({ id: `X${accounts.length + 1}`, name, principal: principal * unit });
  }

  // 년도 표
  const yearStarts: YearStart[] = [];
  const yearHeader = findRow(g, (r) => str(g.get('A', r)) === '년도');
  if (yearHeader !== undefined) {
    const h = headerMap(g, yearHeader);
    const startCol = h.get('총자산');
    const flowCol = h.get('변경');
    for (const r of g.rows.filter((x) => x > yearHeader)) {
      const year = num(g.get('A', r));
      if (year === undefined || year < 1900 || year > 2200) break;
      const start = startCol ? num(g.get(startCol, r)) : undefined;
      if (start === undefined) continue;
      yearStarts.push({ year, start: start * unit, flow: (flowCol ? num(g.get(flowCol, r)) ?? 0 : 0) * unit });
    }
  }

  // 월별 표
  const months: ExcelMonth[] = [];
  const monthHeader = findRow(g, (r) => str(g.get('A', r)) === '날짜' && headerMap(g, r).has('기말자산'));
  if (monthHeader === undefined) throw new Error("Summary 시트에서 '날짜 … 기말자산' 표를 찾지 못했습니다");
  const mh = headerMap(g, monthHeader);
  const endCol = mh.get('기말자산')!;
  const totalCol = mh.get('월투자금') ?? endCol;
  const accountCols: number[] = [];
  for (let c = 2; c < totalCol; c++) if (str(g.get(c, monthHeader))) accountCols.push(c);
  for (const r of g.rows.filter((x) => x > monthHeader)) {
    const month = toMonth(g.get('A', r));
    if (!month) continue;
    const flows = accountCols.map((c) => (num(g.get(c, r)) ?? 0) * unit);
    const end = num(g.get(endCol, r));
    if (flows.every((f) => f === 0) && end === undefined) continue;
    months.push({ month, flows, endValue: end === undefined ? null : end * unit });
  }
  // 월별 표 계좌 수와 맨 위 계좌 목록이 다르면 월별 표 머리글을 계좌 이름으로 사용
  if (accounts.length !== accountCols.length) {
    accounts.length = 0;
    accountCols.forEach((c, i) => {
      accounts.push({ id: `X${i + 1}`, name: str(g.get(c, monthHeader)), principal: months.reduce((s, m) => s + m.flows[i], 0) });
    });
  }
  months.sort((a, b) => a.month.localeCompare(b.month));

  // 해외주식리스트
  const foreign: string[] = [];
  let usdKrw = 1400;
  const fsheet = findSheet(book, '해외주식리스트');
  if (fsheet) {
    const fg = grid(fsheet);
    for (const r of fg.rows) {
      if (r === 1) continue;
      const n = str(fg.get('A', r));
      if (n) foreign.push(n);
    }
    for (const r of fg.rows) {
      for (let c = 1; c <= fg.maxCol; c++) {
        if (str(fg.get(c, r)) === '환율') usdKrw = num(fg.get(c, r + 1)) ?? usdKrw;
      }
    }
  }

  // 투자내역
  const lots: ExcelLot[] = [];
  const tsheet = findSheet(book, '투자내역');
  if (tsheet) {
    const tg = grid(tsheet);
    const header = findRow(tg, (r) => str(tg.get('A', r)) === '종목');
    if (header !== undefined) {
      const h = headerMap(tg, header);
      const col = (name: string) => h.get(name);
      const val = (name: string, r: number) => {
        const c = col(name);
        return c ? tg.get(c, r) : undefined;
      };
      for (const r of tg.rows.filter((x) => x > header)) {
        const name = str(tg.get('A', r));
        const quantity = num(val('개수', r));
        const buyPrice = num(val('구매가격', r));
        if (!name || !quantity || buyPrice === undefined) continue;
        const sellPrice = num(val('판매가격', r));
        lots.push({
          name,
          quantity,
          buyPrice,
          ...(sellPrice !== undefined ? { sellPrice } : {}),
          ...(num(val('수익률', r)) !== undefined ? { returnRate: num(val('수익률', r)) } : {}),
          ...(num(val('수익금액', r)) !== undefined ? { profitKRW: num(val('수익금액', r)) } : {}),
          ...(toDate(val('구매날짜', r)) ? { buyDate: toDate(val('구매날짜', r)) } : {}),
          ...(toDate(val('판매날짜', r)) ? { sellDate: toDate(val('판매날짜', r)) } : {}),
          ...(str(val('구매노트', r)) ? { buyNote: str(val('구매노트', r)) } : {}),
          ...(str(val('판매노트', r)) ? { sellNote: str(val('판매노트', r)) } : {}),
        });
      }
    }
  }

  return { version: 1, fileName, importedAt: new Date().toISOString(), unit, goal, usdKrw, accounts, yearStarts, months, lots, foreign };
}

/** 판매가격도 판매날짜도 없으면 아직 보유 중 */
export const isOpenLot = (l: ExcelLot) => l.sellPrice === undefined && l.sellDate === undefined;
