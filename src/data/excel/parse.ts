import type { SheetCells, Workbook } from './xlsx';
import type { YearStart } from '../model';
import type { Currency, ISODate } from '../../types';
import { emptyHoldings, holdingKey, type HoldingsState } from '../holdings';

/**
 * 사용자가 관리하던 '주식.xlsx' 구조를 읽어 앱 데이터로 바꾼다.
 *
 * Summary        : 계좌별 원금 · 목표 · 단위, 년도 표(연초 총자산 · 연중 변경), 월별 표(계좌별 입금 · 기말자산)
 * 입금내역        : 날짜별 · 계좌별 입금 (음수 = 출금 · 계좌 간 이체)
 * 해외주식리스트   : 환율
 * 보유종목 · 그룹 · 자산스냅샷 : 대시보드의 '엑셀 업데이트'가 쓰는 시트 (계좌별 보유 종목 · 내 그룹 · 날짜별 계좌 평가금)
 *
 * 투자내역 시트는 최신이 아니어서 읽지 않는다.
 * 셀 위치가 아니라 머리글 글자('년도', '날짜', '기말자산' ...)로 표를 찾으므로 행이 늘어나도 동작한다.
 */

export interface ExcelDeposit {
  date: ISODate;
  /** depositAccounts 순서대로 금액 (원) */
  amounts: number[];
}

export interface ExcelMonth {
  month: string; // YYYY-MM
  /** 계좌 순서대로 그 달 순입금 (원) */
  flows: number[];
  /** 기말자산 (원), 비어 있으면 null */
  endValue: number | null;
}

export interface ExcelGroup {
  name: string;
  /** 종목 키 (종목코드, 없으면 종목명) */
  keys: string[];
}

export interface SnapshotLogRow {
  date: ISODate;
  account: string;
  value: number;
}

export interface ExcelBook {
  version: 3;
  fileName: string;
  importedAt: string;
  unit: number;
  goal: number | null;
  usdKrw: number;
  accounts: { id: string; name: string; principal: number }[];
  yearStarts: YearStart[];
  months: ExcelMonth[];
  /** 입금내역 머리글 (종합 · ISA · 금계좌 · 연금1 · 연금2 · IRP ...) */
  depositAccounts: string[];
  deposits: ExcelDeposit[];
  holdings: HoldingsState;
  groups: ExcelGroup[];
  snapshotLog: SnapshotLogRow[];
}

/** 예전(v2)에 저장된 값도 읽는다 */
export function upgradeBook(raw: unknown): ExcelBook | null {
  const b = raw as Omit<Partial<ExcelBook>, 'version'> & { version?: number };
  if (!b || (b.version !== 2 && b.version !== 3)) return null;
  return { ...(b as unknown as ExcelBook), version: 3, holdings: b.holdings ?? emptyHoldings(), groups: b.groups ?? [], snapshotLog: b.snapshotLog ?? [] };
}

export const HOLDINGS_SHEET = '보유종목';
export const GROUPS_SHEET = '그룹';
export const SNAPSHOT_SHEET = '자산스냅샷';
export const CASH_CODE = '현금';

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

/** 엑셀 날짜 · '2025-01-24' · '~23 / 2 / 9'(23년 2월 9일까지 잔고) 를 날짜로 */
export function toDate(v: unknown): ISODate | undefined {
  if (typeof v === 'number' && v > 20000) return serialToIso(v);
  const m = /(\d{2,4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/.exec(str(v));
  if (!m) return undefined;
  const y = m[1].length === 2 ? `20${m[1]}` : m[1];
  return `${y}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
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

  // 입금내역
  const depositAccounts: string[] = [];
  const deposits: ExcelDeposit[] = [];
  const dsheet = findSheet(book, '입금내역');
  if (dsheet) {
    const dg = grid(dsheet);
    const header = findRow(dg, (r) => str(dg.get('A', r)) === '날짜');
    if (header !== undefined) {
      const cols: number[] = [];
      for (let c = 2; c <= dg.maxCol; c++) {
        const h = str(dg.get(c, header));
        if (!h) continue;
        cols.push(c);
        depositAccounts.push(h);
      }
      for (const r of dg.rows.filter((x) => x > header)) {
        const date = toDate(dg.get('A', r));
        if (!date) continue;
        const amounts = cols.map((c) => (num(dg.get(c, r)) ?? 0) * unit);
        if (amounts.every((a) => a === 0)) continue;
        deposits.push({ date, amounts });
      }
      deposits.sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  // 환율 (해외주식리스트의 '환율' 아래 칸)
  let usdKrw = 1400;
  const fsheet = findSheet(book, '해외주식리스트');
  if (fsheet) {
    const fg = grid(fsheet);
    for (const r of fg.rows) {
      for (let c = 1; c <= fg.maxCol; c++) {
        if (str(fg.get(c, r)) === '환율') usdKrw = num(fg.get(c, r + 1)) ?? usdKrw;
      }
    }
  }

  const holdings = parseHoldings(book);
  return {
    version: 3,
    fileName,
    importedAt: new Date().toISOString(),
    unit,
    goal,
    usdKrw: holdings.usdKrw ?? usdKrw,
    accounts,
    yearStarts,
    months,
    depositAccounts,
    deposits,
    holdings,
    groups: parseGroups(book),
    snapshotLog: parseSnapshotLog(book),
  };
}

/** 머리글 행(필수 글자를 모두 가진 첫 행)을 찾아 행마다 {머리글: 값} 으로 */
function table(cells: SheetCells | undefined, required: string[]): Record<string, string | number | undefined>[] {
  if (!cells) return [];
  const g = grid(cells);
  const header = findRow(g, (r) => {
    const h = headerMap(g, r);
    return required.every((k) => h.has(k));
  });
  if (header === undefined) return [];
  const h = headerMap(g, header);
  return g.rows
    .filter((r) => r > header)
    .map((r) => Object.fromEntries([...h].map(([k, c]) => [k, g.get(c, r)])));
}

const currencyOf = (v: unknown): Currency => (str(v).toUpperCase() === 'USD' || str(v) === '달러' ? 'USD' : 'KRW');

export function parseHoldings(book: Workbook): HoldingsState {
  const h = emptyHoldings();
  for (const r of table(findSheet(book, HOLDINGS_SHEET), ['계좌', '종목명', '수량'])) {
    const account = str(r['계좌']);
    const name = str(r['종목명']);
    const code = str(r['종목코드']);
    const qty = num(r['수량']);
    if (!account || !name || qty === undefined) continue;
    const date = toDate(r['기준일']);
    if (date && !h.asOf) h.asOf = `${date}T00:00:00`;
    const rate = num(r['환율']);
    if (rate && !h.usdKrw) h.usdKrw = rate;
    const currency = currencyOf(r['통화']);
    if (code === CASH_CODE || name === CASH_CODE) {
      h.cash.push({ account, currency, amount: qty });
      continue;
    }
    h.rows.push({
      account,
      code: code.toUpperCase(),
      name,
      currency,
      quantity: qty,
      avgPrice: num(r['평균단가']) ?? 0,
      price: num(r['현재가']) ?? null,
      costKRW: num(r['매입금액(원)']) ?? null,
    });
  }
  return h;
}

export function parseGroups(book: Workbook): ExcelGroup[] {
  const out: ExcelGroup[] = [];
  for (const r of table(findSheet(book, GROUPS_SHEET), ['그룹'])) {
    const name = str(r['그룹']);
    if (!name) continue;
    let g = out.find((x) => x.name === name);
    if (!g) out.push((g = { name, keys: [] }));
    const key = holdingKey({ code: str(r['종목코드']), name: str(r['종목명']) });
    if (key && !g.keys.includes(key)) g.keys.push(key);
  }
  return out;
}

export function parseSnapshotLog(book: Workbook): SnapshotLogRow[] {
  const out: SnapshotLogRow[] = [];
  for (const r of table(findSheet(book, SNAPSHOT_SHEET), ['기준일', '계좌', '평가금액(원)'])) {
    const date = toDate(r['기준일']);
    const value = num(r['평가금액(원)']);
    const account = str(r['계좌']);
    if (date && account && value !== undefined) out.push({ date, account, value });
  }
  return out;
}
