import type { SheetCells, Workbook } from './xlsx';
import type { YearStart } from '../model';
import type { Currency, ISODate } from '../../types';
import { emptyHoldings, holdingKey, type HoldingsState } from '../holdings';
import type { DividendEntry } from '../dividends';
import { addMarketItems, emptyWatchlist, WATCH_UNGROUPED, type Watchlist } from '../watchlist';

/**
 * 사용자가 관리하던 '주식.xlsx' 구조를 읽어 앱 데이터로 바꾼다.
 *
 * Summary        : 계좌별 원금 · 목표 · 단위, 년도 표(연초 총자산 · 연중 변경), 월별 표(계좌별 입금 · 기말자산)
 * 입금내역        : 날짜별 · 계좌별 입금 (음수 = 출금 · 계좌 간 이체)
 * 해외주식리스트   : 환율
 * 보유종목 · 그룹 · 일별 / 월별 자산추이 : 대시보드의 '엑셀 업데이트'가 쓰는 시트
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

/** 일별 자산추이 한 줄 (그날 보유종목 기준 계좌별 평가금 + 현금) */
export interface DailyRow {
  date: ISODate;
  total: number;
  /** 계좌 이름 → 평가금 (원) */
  accounts: Record<string, number>;
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
  dailyLog: DailyRow[];
  /** '배당' 시트 (NH 동기화 + 직접 적은 것) */
  dividends: DividendEntry[];
  /** '월별 자산추이' 시트의 월 → 기말자산 (원). Summary 기말자산이 빈 달에 쓴다 */
  monthlyValues: Record<string, number>;
  /** 동기화로 확인한 NH 계좌 (끝자리 · 대시보드 이름, 이름 없으면 null) → ③ 엑셀 업데이트 때 '설정' 시트에 줄 추가 */
  nhAccounts?: { suffix: string; name: string | null }[];
  /** '관심종목' 시트 */
  watchlist: Watchlist;
}

/** 예전(v2)에 저장된 값도 읽는다 */
export function upgradeBook(raw: unknown): ExcelBook | null {
  const b = raw as Omit<Partial<ExcelBook>, 'version'> & { version?: number; snapshotLog?: { date: ISODate; account: string; value: number }[] };
  if (!b || (b.version !== 2 && b.version !== 3)) return null;
  const { snapshotLog, ...rest } = b;
  return {
    ...(rest as unknown as ExcelBook),
    version: 3,
    holdings: b.holdings ?? emptyHoldings(),
    groups: b.groups ?? [],
    dailyLog: b.dailyLog ?? dailyFromLong(snapshotLog ?? []),
    dividends: b.dividends ?? [],
    watchlist: b.watchlist ?? emptyWatchlist(),
    monthlyValues: b.monthlyValues ?? {},
  };
}

export const HOLDINGS_SHEET = '보유종목';
export const GROUPS_SHEET = '그룹';
/** 예전 이름 (계좌별 세로 형식). 읽을 때만 쓰고, 쓸 때는 '일별 자산추이'로 이름을 바꾼다 */
export const OLD_SNAPSHOT_SHEET = '자산스냅샷';
export const DAILY_SHEET = '일별 자산추이';
export const MONTHLY_SHEET = '월별 자산추이';
export const TOTAL_LABEL = '합계';
export const DIVIDEND_SHEET = '배당';
export const WATCH_SHEET = '관심종목';
export const CASH_CODE = '현금';
export const SETTINGS_SHEET = '설정';
export const SETTING_URL = '중계 서버 주소';
export const SETTING_TOKEN = '접속 토큰';

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

/** 시트의 값을 행 · 열 배열로 (빈 칸은 null). '설정' 시트를 내용 그대로 다시 쓸 때 쓴다 */
export function sheetRows(book: Workbook, name: string): (string | number | null)[][] | null {
  const cells = findSheet(book, name);
  if (!cells) return null;
  const g = grid(cells);
  const last = g.rows.at(-1) ?? 0;
  const out: (string | number | null)[][] = [];
  for (let r = 1; r <= last; r++) {
    const row: (string | number | null)[] = [];
    for (let c = 1; c <= g.maxCol; c++) row.push(g.get(c, r) ?? null);
    while (row.length && row.at(-1) === null) row.pop();
    out.push(row);
  }
  return out;
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
    dailyLog: parseDaily(book),
    dividends: parseDividends(book, holdings.usdKrw ?? usdKrw),
    watchlist: parseWatchlist(book),
    monthlyValues: parseMonthly(book),
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
      change: num(r['등락률']) ?? null,
      close: num(r['종가']) ?? null,
      closeChange: num(r['종가등락률']) ?? null,
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

/**
 * '설정' 시트의 동기화 설정 (어느 칸이든 '중계 서버 주소' · '접속 토큰' 오른쪽 칸 값).
 * 'NH 계좌 1234' 오른쪽 칸 = 그 NH 계좌(끝자리 1234)를 대시보드에서 부를 계좌 이름 (예: ISA).
 * 브라우저에 저장된 엑셀 값(ExcelBook)에는 넣지 않고, 불러올 때 동기화 설정으로만 옮긴다.
 */
export function parseSyncSettings(book: Workbook): { url: string; token: string; accountMap: Record<string, string> } | null {
  const cells = findSheet(book, SETTINGS_SHEET);
  if (!cells) return null;
  const g = grid(cells);
  let url = '';
  let token = '';
  const accountMap: Record<string, string> = {};
  for (const r of g.rows) {
    for (let c = 1; c < g.maxCol; c++) {
      const label = str(g.get(c, r));
      if (label === SETTING_URL) url = str(g.get(c + 1, r));
      if (label === SETTING_TOKEN) token = str(g.get(c + 1, r));
      const m = /^NH\s*계좌\s*(\d{3,6})$/.exec(label);
      const name = str(g.get(c + 1, r));
      if (m && name) accountMap[m[1]] = name;
    }
  }
  return url && token ? { url, token, accountMap } : null;
}

/** 예전 '자산스냅샷'(기준일 · 계좌 · 평가금액) → 일별 행 */
function dailyFromLong(rows: { date: ISODate; account: string; value: number }[]): DailyRow[] {
  const byDate = new Map<string, DailyRow>();
  for (const r of rows) {
    const d = byDate.get(r.date) ?? { date: r.date, total: 0, accounts: {} };
    if (r.account === TOTAL_LABEL) d.total = r.value;
    else d.accounts[r.account] = r.value;
    byDate.set(r.date, d);
  }
  for (const d of byDate.values()) if (!d.total) d.total = Object.values(d.accounts).reduce((a, b) => a + b, 0);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** 일별 자산추이에서 계좌 열이 아닌 머리글 */
export const DAILY_METRICS = ['날짜', '총자산(원)', '투자원금(원)', '수익금(원)', '수익률'];

export function parseDaily(book: Workbook): DailyRow[] {
  const rows = table(findSheet(book, DAILY_SHEET), ['날짜', '총자산(원)']);
  if (!rows.length) {
    const old: { date: ISODate; account: string; value: number }[] = [];
    for (const r of table(findSheet(book, OLD_SNAPSHOT_SHEET), ['기준일', '계좌', '평가금액(원)'])) {
      const date = toDate(r['기준일']);
      const value = num(r['평가금액(원)']);
      const account = str(r['계좌']);
      if (date && account && value !== undefined) old.push({ date, account, value });
    }
    return dailyFromLong(old);
  }
  const out: DailyRow[] = [];
  for (const r of rows) {
    const date = toDate(r['날짜']);
    const total = num(r['총자산(원)']);
    if (!date || total === undefined) continue;
    const accounts: Record<string, number> = {};
    for (const [k, v] of Object.entries(r)) {
      const n = num(v);
      if (!DAILY_METRICS.includes(k) && n !== undefined) accounts[k] = n;
    }
    out.push({ date, total, accounts });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** '배당' 시트: 날짜 · 계좌 · 종목코드 · 종목명 · 통화 · 금액 · 환율 · 원화금액 · 출처 (출처가 비면 '직접') */
export function parseDividends(book: Workbook, usdKrw: number): DividendEntry[] {
  const out: DividendEntry[] = [];
  for (const r of table(findSheet(book, DIVIDEND_SHEET), ['날짜', '계좌', '금액'])) {
    const date = toDate(r['날짜']);
    const account = str(r['계좌']);
    const amount = num(r['금액']);
    if (!date || !account || amount === undefined || amount === 0) continue;
    const currency = currencyOf(r['통화']);
    const fx = currency === 'USD' ? (num(r['환율']) ?? null) : 1;
    const krw = num(r['원화금액']) ?? Math.round(amount * (currency === 'USD' ? (fx ?? usdKrw) : 1));
    out.push({ date, account, code: str(r['종목코드']).toUpperCase(), name: str(r['종목명']), currency, amount, fx, krw, source: str(r['출처']).toUpperCase() === 'API' ? 'API' : '직접' });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** '관심종목' 시트: 그룹 · 종목코드 · 종목명 · 통화 (+ 마지막 시세). 종목코드가 빈 줄은 빈 그룹 */
export function parseWatchlist(book: Workbook): Watchlist {
  const w = emptyWatchlist();
  // 시트가 없으면(처음) 시장 지표 '발견' 그룹으로 시작. 시트가 있으면 사용자가 지운 것도 그대로 둔다
  if (!findSheet(book, WATCH_SHEET)) return addMarketItems(w);
  for (const r of table(findSheet(book, WATCH_SHEET), ['그룹', '종목코드'])) {
    const g = str(r['그룹']);
    const group = g === WATCH_UNGROUPED ? '' : g;
    if (group && !w.groups.includes(group)) w.groups.push(group);
    const code = str(r['종목코드']).toUpperCase();
    if (!code || w.items.some((i) => i.code === code && i.group === group)) continue;
    w.items.push({
      code,
      name: str(r['종목명']) || code,
      currency: currencyOf(r['통화']),
      group,
      price: num(r['현재가']) ?? null,
      change: num(r['등락률']) ?? null,
      close: num(r['종가']) ?? null,
      closeChange: num(r['종가등락률']) ?? null,
    });
  }
  return w;
}

export function parseMonthly(book: Workbook): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of table(findSheet(book, MONTHLY_SHEET), ['월', '기말자산(원)'])) {
    const month = toMonth(r['월']);
    const v = num(r['기말자산(원)']);
    if (month && v !== undefined) out[month] = v;
  }
  return out;
}

/** Summary 월별 표에서 월 → 행 번호와 기말자산 열 (엑셀 업데이트 때 수식을 넣을 칸) */
export function summaryEndCells(book: Workbook): { sheet: string; col: string; rows: Record<string, number> } | null {
  const sheet = Object.keys(book).find((k) => ['summary', '요약'].includes(k.trim().toLowerCase()));
  if (!sheet) return null;
  const g = grid(book[sheet]);
  const header = findRow(g, (r) => str(g.get('A', r)) === '날짜' && headerMap(g, r).has('기말자산'));
  if (header === undefined) return null;
  const col = numToCol(headerMap(g, header).get('기말자산')!);
  const rows: Record<string, number> = {};
  for (const r of g.rows.filter((x) => x > header)) {
    const m = toMonth(g.get('A', r));
    if (m && !rows[m]) rows[m] = r;
  }
  return { sheet, col, rows };
}
