import { MARKET_BY_CODE } from './markets';
// ─────────────────────────────────────────────────────────────
// NH투자증권 PLUG Open API — 조회 전용 클라이언트 (주문 API 는 없음)
// 명세: https://www.nhplug.com/llms.txt · openapi-docs/*/openapi.json
//  - 접근토큰 24시간 재사용, 401 일 때만 재발급 (재발급하면 NH 보안 알림)
//  - REST 초당 5건 → 호출 간격 220ms
//  - HTTP 200 이라도 실패일 수 있음 → 응답 블록 존재 + rsp_msg 로 판단
// ─────────────────────────────────────────────────────────────

export const NH_BASE = 'https://api.nhplug.com:8443';

export type Currency = 'KRW' | 'USD';

export interface HoldingRow {
  account: string;
  code: string;
  name: string;
  currency: Currency;
  quantity: number;
  avgPrice: number;
  price: number | null;
  costKRW?: number | null;
}
export interface CashRow {
  account: string;
  currency: Currency;
  amount: number;
}
export interface SyncAccount {
  name: string;
  /** NH 계좌번호 끝 4자리 */
  suffix?: string;
  rows: HoldingRow[];
  cash: CashRow[];
}
/** 배당 입금 한 건 (금액은 그 통화, 세후 입금액) */
export interface DividendRow {
  date: string; // YYYY-MM-DD
  account: string;
  /** 지금 보유 종목이면 티커 · 국내코드, 아니면 NH 종목코드(ISIN) */
  code: string;
  name: string;
  currency: Currency;
  amount: number;
  /** 그날 USD/KRW (원화 배당은 1). NH 환율 일별 시세(KRW)의 그날 · 없으면 직전 영업일 값 */
  fx: number;
  /** 원화 환산액 = amount × fx (한 번 정하면 고정) */
  krw: number;
}

/** 중계 서버에 쌓아 두는 배당 장부 (KV 'dividends') */
export interface DividendLedger {
  updatedAt: string;
  rows: DividendRow[];
}
export interface LedgerStore {
  get(): Promise<string | null>;
  put(value: string): Promise<void>;
}
export interface SyncResult {
  asOf: string;
  usdKrw: number | null;
  accounts: SyncAccount[];
  prices: Record<string, number>;
  /** 종목코드 → 전일 대비 등락률 (0.0123 = +1.23%). NH 계좌 종목 + 물어본 종목 */
  changes: Record<string, number>;
  /** 종목코드 → 마지막으로 끝난 정규장 종가 · 날짜(YYYYMMDD) · 그 종가의 전일 대비 */
  closes: Record<string, { close: number; date: string | null; change: number | null }>;
  /** 중계 서버 배당 장부 전체 (NH 계좌) */
  dividends: DividendRow[];
  /** 이번에 다시 받은 시작일 (장부 최신일 − 14일, 처음이면 2년 전) */
  dividendsFrom: string | null;
  /** NH 가 응답했지만 대시보드 계좌 이름이 정해지지 않은 계좌 (반영하지 않음) */
  unmapped: { suffix: string; holdings: number; cash: number }[];
  warnings: string[];
}

export interface TokenStore {
  get(): Promise<{ access_token: string; expires_at: number } | null>;
  set(t: { access_token: string; expires_at: number }): Promise<void>;
}

export interface NhConfig {
  appKey: string;
  appSecret: string;
  /** "1234:종합,5678:금계좌" — 계좌번호 끝자리 : 대시보드 계좌 이름 */
  accounts: string;
  tokens: TokenStore;
  fetch?: typeof fetch;
  /** 테스트에서 0 */
  intervalMs?: number;
}

type Json = Record<string, unknown>;
const n = (v: unknown) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, ''))) || 0;
const s = (v: unknown) => String(v ?? '').trim();
const rows = (r: Json, block: string): Json[] => {
  const v = r[block];
  return Array.isArray(v) ? (v as Json[]) : v && typeof v === 'object' ? [v as Json] : [];
};

export function parseAccountMap(spec: string): { suffix: string; name: string }[] {
  return spec
    .split(',')
    .map((p) => p.split(':').map((x) => x.trim()))
    .filter(([suffix, name]) => suffix && name)
    .map(([suffix, name]) => ({ suffix, name }));
}

export class NhClient {
  private last = 0;
  private token: string | null = null;
  private readonly f: typeof fetch;

  constructor(private readonly cfg: NhConfig) {
    // Workers 에서는 전역 fetch 를 객체에 담아 부르면 this 가 바뀌어 오류가 난다 → 감싸서 호출
    this.f = cfg.fetch ?? ((input, init) => fetch(input, init));
  }

  private async getToken(force = false): Promise<string> {
    if (!force) {
      if (this.token) return this.token;
      const cached = await this.cfg.tokens.get();
      if (cached && cached.expires_at > Date.now() / 1000 + 300) return (this.token = cached.access_token);
    }
    const q = new URLSearchParams({ appkey: this.cfg.appKey, appsecretkey: this.cfg.appSecret, grant_type: 'client_credentials', scope: 'oob' });
    const res = await this.f(`${NH_BASE}/oauth2/token?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (!res.ok) throw new Error(`NH 접근토큰 발급 실패 (HTTP ${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    await this.cfg.tokens.set({ access_token: body.access_token, expires_at: Date.now() / 1000 + (body.expires_in ?? 86400) });
    return (this.token = body.access_token);
  }

  async call(path: string, input: Json): Promise<Json> {
    return (await this.request(path, input)).body;
  }

  /** 연속조회: 응답 헤더 cts · cts_flag 를 다음 요청 헤더에 실어 끝까지 (같은 cts 가 오면 멈춤) */
  async callAll(path: string, input: Json, block = 'Output_0', maxPages = 40): Promise<Json[]> {
    const out: Json[] = [];
    let cts = '';
    for (let page = 0; page < maxPages; page++) {
      const { body, next } = await this.request(path, input, cts);
      out.push(...rows(body, block));
      if (!next || next === cts) break;
      cts = next;
    }
    return out;
  }

  private async request(path: string, input: Json, cts = '', retried = false): Promise<{ body: Json; next: string }> {
    const gap = (this.cfg.intervalMs ?? 220) - (Date.now() - this.last);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    this.last = Date.now();
    const token = await this.getToken();
    const res = await this.f(`${NH_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}`, ...(cts ? { cts, cts_flag: 'Y' } : {}) },
      body: JSON.stringify({ Input_0: input }),
    });
    // 토큰이 무효면 NH 는 401 또는 HTTP 400 + IGW40043("유효하지 않은 token") 으로 답한다
    // (같은 앱키로 다른 곳에서 새 토큰을 받으면 예전 토큰은 무효가 됨) → 한 번만 새로 받는다
    const body = (await res.json().catch(() => ({}))) as Json;
    const invalidToken = res.status === 401 || s(body.rsp_cd) === 'IGW40043' || /유효하지 않은 token/i.test(s(body.rsp_msg));
    if (invalidToken && !retried) {
      this.token = null;
      await this.getToken(true);
      return this.request(path, input, cts, true);
    }
    if (!res.ok) throw new Error(`NH ${path} HTTP ${res.status}${body.rsp_msg ? ` ${s(body.rsp_msg)}` : ''}`);
    const more = res.headers.get('cts_flag') === 'Y';
    return { body, next: more ? s(res.headers.get('cts')) : '' };
  }
}

// ─── 응답 → 대시보드 형식 ────────────────────────────────────

export function mapKrStock(account: string, r: Json): { rows: HoldingRow[]; cash: number | null } {
  const head = rows(r, 'Output_0')[0];
  const items = rows(r, 'Output_1')
    .map((x): HoldingRow => {
      const qty = n(x.itg_bnc_qty) || n(x.rsdl_qty);
      const avg = n(x.phs_pr);
      return { account, code: s(x.iem_cd), name: s(x.iem_nm), currency: 'KRW', quantity: qty, avgPrice: avg, price: n(x.now_pr) || null, costKRW: qty * avg || null };
    })
    .filter((x) => x.quantity > 0);
  return { rows: items, cash: head ? n(head.dca) : null };
}

export function mapGbStock(account: string, r: Json): { rows: HoldingRow[]; cashUsd: number | null; usdKrw: number | null } {
  const head = rows(r, 'Output_0')[0];
  let usdKrw: number | null = null;
  const items = rows(r, 'Output_1')
    .map((x): HoldingRow => {
      const qty = n(x.cns_bse_bnc_qty);
      if (!usdKrw && n(x.tdt_sby_bse_xcg_rt)) usdKrw = n(x.tdt_sby_bse_xcg_rt);
      return {
        account,
        code: s(x.iem_cd).toUpperCase(),
        name: s(x.iem_nm),
        currency: 'USD', // 미국(200) 시장만 조회
        quantity: qty,
        avgPrice: qty ? n(x.fc_abk_amt) / qty : 0,
        price: n(x.fc_sec_end_pr) || null,
        costKRW: n(x.krw_abk_amt1) || null,
      };
    })
    .filter((x) => x.quantity > 0);
  // 달러 현금 = 외화예수금 + 외화미결제정산금액 (체결됐지만 결제 전인 매수 대금을 빼야 종목과 이중으로 세지 않음.
  // NH 의 외화자산금액 = 외화평가금액 + 이 값)
  return { rows: items, cashUsd: head ? Math.round((n(head.fc_dca) + n(head.fc_ny_stl_xcl_amt)) * 100) / 100 : null, usdKrw };
}

export function mapGold(account: string, r: Json): { rows: HoldingRow[]; cash: number | null } {
  const { rows: items, cash } = mapKrStock(account, r);
  return { rows: items, cash };
}

/** 종합거래내역 → 배당 입금 (적요에 '배당' · '분배'가 든 입금: 외화배당금입금, 소수점해외배당금, 배당금입금 …) */
export function mapDividends(account: string, txs: Json[], tickerByName: Map<string, string>): Omit<DividendRow, 'fx' | 'krw'>[] {
  return txs
    .filter((t) => /배당|분배/.test(s(t.sps_cd_krl_anm)) && !/세|환급|출금/.test(s(t.sps_cd_krl_anm)) && n(t.trd_amt) > 0)
    .map((t) => {
      const d = s(t.trd_dt);
      const name = s(t.iem_nm);
      return {
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        account,
        code: tickerByName.get(name) ?? s(t.iem_cd),
        name,
        currency: s(t.cur_cd) === 'USD' ? 'USD' : 'KRW',
        amount: Math.round(n(t.trd_amt) * 100) / 100,
      } as Omit<DividendRow, 'fx' | 'krw'>;
    });
}

const ymd = (d: string) => d.replace(/-/g, '');
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** 장부의 최신일 − 14일 (늦게 들어오는 입금 대비), 비어 있으면 2년 전 */
export function ledgerFrom(rows: DividendRow[], today: string): string {
  const last = rows.reduce((m, r) => (r.date > m ? r.date : m), '');
  const d = new Date(`${last || today}T00:00:00Z`);
  if (last) d.setUTCDate(d.getUTCDate() - 14);
  else d.setUTCFullYear(d.getUTCFullYear() - 2);
  return iso(d);
}

/** 그날 환율, 없으면(휴일) 직전 영업일 */
export function fxOn(date: string, fx: Map<string, number>): number | null {
  const d = new Date(`${date}T00:00:00Z`);
  for (let i = 0; i < 10; i++) {
    const v = fx.get(iso(d));
    if (v) return v;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return null;
}

/**
 * 장부에 합치기: 이번에 받은 계좌 · 기간(from 이후)은 새로 받은 것으로 바꾸고,
 * 예전에 같은 배당(날짜 · 계좌 · 종목 · 금액)이 있었으면 그때 정한 환율 · 원화금액을 그대로 쓴다.
 */
export function mergeLedger(old: DividendRow[], fresh: Omit<DividendRow, 'fx' | 'krw'>[], accounts: string[], from: string, fx: Map<string, number>, fallbackFx: number | null): DividendRow[] {
  const key = (r: { date: string; account: string; name: string; amount: number }) => `${r.date}|${r.account}|${r.name}|${r.amount}`;
  const fixed = new Map(old.map((r) => [key(r), r]));
  const keep = old.filter((r) => !(accounts.includes(r.account) && r.date >= from));
  const added = fresh.map((r): DividendRow => {
    const prev = fixed.get(key(r));
    if (prev) return { ...r, fx: prev.fx, krw: prev.krw };
    const rate = r.currency === 'USD' ? (fxOn(r.date, fx) ?? fallbackFx ?? 0) : 1;
    return { ...r, fx: rate, krw: Math.round(r.amount * rate) };
  });
  return [...keep, ...added].sort((a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account) || a.name.localeCompare(b.name));
}

/**
 * 국내: 일자별 시세 최근 2일 종가로 현재가 · 등락률 (현재가 시세의 prdy_ctrt 는 부호가 없어 내린 날도 +로 옴)
 * 장중에는 첫 줄이 오늘 현재가
 */
export interface Quote {
  price: number | null;
  /** 현재가의 전일 대비 */
  change: number | null;
  /** 마지막으로 끝난 정규장 종가 · 그 날짜 · 그 종가의 전일 대비 */
  close: number | null;
  closeDate: string | null;
  closeChange: number | null;
  msg: string;
}

/** 그 시장의 현지 날짜 · 시각(분) · 요일 */
export function marketClock(now: Date, timeZone: string): { date: string; minutes: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: `${parts.year}${parts.month}${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday };
}

/**
 * 일별 종가 목록(최신 먼저)에서 '끝난 정규장' 종가를 고른다.
 * 첫 줄이 오늘(평일)이고 그 시장의 장이 아직 끝나지 않았으면(장 전 · 장중) 그 줄은 건너뛴다.
 * NH 미국 일별 시세는 장 시작 전에도 오늘 줄을 만들어 전일 종가를 그대로 넣어 두므로,
 * 장 전에 그 줄을 쓰면 종가 등락률이 0% 가 된다.
 */
export function pickClose(days: { date: string; close: number }[], clock: { date: string; minutes: number; weekday: number }, closeAt: number) {
  const live = days[0] && days[0].date === clock.date && clock.weekday >= 1 && clock.weekday <= 5 && clock.minutes < closeAt;
  const [c, prev] = live ? days.slice(1) : days;
  return { close: c?.close || null, closeDate: c?.date ?? null, closeChange: c?.close && prev?.close ? c.close / prev.close - 1 : null };
}

const ymdOf = (v: unknown) => {
  const d = s(v).replace(/\D/g, '');
  return d.length === 6 ? `20${d}` : d; // '26/11/24' → 20261124
};

/**
 * 국내: 일자별 시세(정규장) 최근 3일 → 현재가 · 등락률(첫 두 줄), 종가 · 종가 등락률(끝난 장 기준)
 * (현재가 시세의 prdy_ctrt 는 부호가 없어 내린 날도 +로 와서 쓰지 않음)
 */
export async function quoteKr(nh: NhClient, code: string, now = new Date()): Promise<Quote> {
  const r = await nh.call('/krstock/quote/v1/currentDaily', { iem_cd: code, market_cd: 'UNT', array_cnt: '3', view_main_yn: 'Y' });
  const days = rows(r, 'Output_0').map((x) => ({ date: ymdOf(x.bsop_date), close: n(x.stck_clpr) }));
  const [today, prev] = days;
  return {
    price: today?.close || null,
    change: today?.close && prev?.close ? today.close / prev.close - 1 : null,
    ...pickClose(days, marketClock(now, 'Asia/Seoul'), 15 * 60 + 30),
    msg: s(r.rsp_msg),
  };
}

/** 미국: 현재가상세(주간 · 장전후 포함 현재가, pctchng 는 부호 있는 %) + 일별 시세(정규장 종가) */
export async function quoteUs(nh: NhClient, code: string, now = new Date()): Promise<Quote> {
  const r = await nh.call('/gbstock/quote/v1/current', { iem_cd: code });
  const o = rows(r, 'Output_0')[0];
  const pct = o?.pctchng;
  const clock = marketClock(now, 'America/New_York');
  let closes = { close: null as number | null, closeDate: null as string | null, closeChange: null as number | null };
  try {
    const p = await nh.call('/gbstock/quote/v1/period', { iem_cd: code, end_dt: clock.date, count: '3', maxavg: '0', gubun: '3', xtick: '0001', today_cls: '0', market_cls: '1' });
    const days = rows(p, 'Output_1').map((x) => ({ date: ymdOf(x.trade_date), close: n(x.close_prc) }));
    closes = pickClose(days, clock, 16 * 60);
  } catch {
    /* 종가는 못 받아도 현재가는 쓴다 */
  }
  return { price: n(o?.trdprc) || null, change: pct === undefined || pct === null || pct === '' ? null : n(pct) / 100, ...closes, msg: s(r.rsp_msg) };
}

/** 환율은 24시간 움직이므로 '종가' = 어제 마지막 값 */
const ALL_DAY = { tz: 'Asia/Seoul', open: 0, close: 24 * 60 };
const SEOUL_GOLD = { tz: 'Asia/Seoul', open: 9 * 60, close: 15 * 60 + 30 };

/** 등락 부호(1 상한 · 2 상승 · 3 보합 · 4 하한 · 5 하락)로 부호 없는 등락률을 바로잡는다 */
export function signedPct(pct: unknown, sign: unknown): number | null {
  if (pct === undefined || pct === null || pct === '') return null;
  const v = Math.abs(n(pct)) / 100;
  const sg = s(sign);
  return sg === '4' || sg === '5' ? -v : sg === '3' ? 0 : sg === '1' || sg === '2' ? v : n(pct) / 100;
}

async function indexFx(nh: NhClient, iem: string, now: Date) {
  const r = await nh.call('/gbstock/quote/v1/symbolIndexFxPeriod', { iem_cd: iem, end_dt: marketClock(now, 'Asia/Seoul').date, array_cnt: '4', maxavg: '0', gubun: '1', xtick: '001', today_cls: '0', scale_change: '0' });
  const o = rows(r, 'Output_0')[0];
  return {
    price: n(o?.ovrs_prpr) || null,
    change: signedPct(o?.prdy_ctrt, o?.prdy_vrss_sign),
    days: rows(r, 'Output_1').map((x) => ({ date: ymdOf(x.bsop_date), close: n(x.ovrs_prpr) })),
    msg: s(r.rsp_msg),
  };
}

/**
 * 지수 · 환율 · 금 (목록은 markets.ts). 코드는 IDX: · FX: · GOLD: 접두어
 *  - 지수 · 환율: 해외 지수/환율 기간별 시세 · 금: KRX 금현물(원/g)
 *  - 원화 환율(cross) = 원/달러 × (그 통화 1단위의 달러 값) × per(100엔 등)
 */
export async function quoteMarket(nh: NhClient, code: string, now = new Date()): Promise<Quote | null> {
  const def = MARKET_BY_CODE[code]?.def;
  if (!def) return null;
  if (def.kind === 'index') {
    const q = await indexFx(nh, def.iem, now);
    return { price: q.price, change: q.change, ...pickClose(q.days, marketClock(now, def.tz), def.close), msg: q.msg };
  }
  if (def.kind === 'fx') {
    const own = await indexFx(nh, def.iem, now);
    const per = def.per ?? 1;
    const allDay = marketClock(now, ALL_DAY.tz);
    if (!def.cross) {
      return { price: own.price ? own.price * per : null, change: own.change, ...pickClose(own.days.map((d) => ({ date: d.date, close: d.close * per })), allDay, ALL_DAY.close), msg: own.msg };
    }
    const krw = await indexFx(nh, 'KRW', now);
    // NH 값 v: invert 면 '그 통화 1단위 = v 달러', 아니면 '1달러 = v 그 통화'
    const inKrw = (v: number, usdKrw: number) => (def.invert ? v : 1 / v) * usdKrw * per;
    const krwOn = new Map(krw.days.map((d) => [d.date, d.close]));
    const days = own.days.filter((d) => d.close && krwOn.get(d.date)).map((d) => ({ date: d.date, close: inKrw(d.close, krwOn.get(d.date)!) }));
    const change = own.change === null || krw.change === null ? null : (1 + krw.change) * (def.invert ? 1 + own.change : 1 / (1 + own.change)) - 1;
    return { price: own.price && krw.price ? inKrw(own.price, krw.price) : null, change, ...pickClose(days, allDay, ALL_DAY.close), msg: own.msg || krw.msg };
  }
  // 금현물: 현재가 + 일별 추이(등락률은 부호가 없어 부호로 바로잡고, 종가는 추이에서)
  const cur = await nh.call('/krgold/quote/v1/goldCurrent', { iem_cd: def.iem });
  const o = rows(cur, 'Output_0')[0];
  const clock = marketClock(now, SEOUL_GOLD.tz);
  const from = new Date(now.getTime() - 14 * 86_400_000);
  const t = await nh.call('/krgold/quote/v1/goldDailyTrend', { iem_cd: def.iem, sdate: marketClock(from, SEOUL_GOLD.tz).date, edate: clock.date, gubun: '1' });
  const days = rows(t, 'Output_0').map((x) => ({ date: ymdOf(x.bsop_date), close: n(x.stck_prpr) }));
  return { price: n(o?.stck_prpr) || null, change: signedPct(o?.prdy_ctrt, o?.prdy_vrss_sign), ...pickClose(days, clock, SEOUL_GOLD.close), msg: s(cur.rsp_msg) };
}

const failed = (r: Json, block: string) => !rows(r, block).length && !/완료|정상|조회/.test(s(r.rsp_msg));

export async function buildSync(cfg: NhConfig, quotes: { code: string; currency: Currency }[], ledger: LedgerStore | null = null): Promise<SyncResult> {
  const nh = new NhClient(cfg);
  const warnings: string[] = [];
  const map = parseAccountMap(cfg.accounts);
  const info = await nh.call('/n2/acctinfo', {});
  const live = rows(info, 'Output_0').filter((a) => s(a.acct_type) === '01' || s(a.acct_type) === '02');
  let usdKrw: number | null = null;
  const accounts: SyncAccount[] = [];
  const today = iso(new Date());
  // 배당 장부: 최신일 − 14일부터 다시 받는다
  let book: DividendRow[] = [];
  if (ledger) {
    try {
      book = (JSON.parse((await ledger.get()) ?? 'null') as DividendLedger | null)?.rows ?? [];
    } catch {
      book = [];
    }
  }
  const dividendsFrom = ledger ? ledgerFrom(book, today) : null;
  const fresh: Omit<DividendRow, 'fx' | 'krw'>[] = [];
  const fetchedAccounts: string[] = [];

  const unmapped: SyncResult['unmapped'] = [];
  const nameOf = (actNo: string) => map.find((m) => actNo.endsWith(m.suffix))?.name ?? null;
  for (const { suffix, name } of map) {
    if (!live.some((a) => s(a.acct_no).endsWith(suffix))) warnings.push(`${name}: NH 계좌 목록에 끝자리 ${suffix} 계좌가 없습니다 (엑셀 값 유지)`);
  }

  // NH 가 응답하는 모든 실계좌: 이름이 정해진 계좌는 최신으로, 아니면 잔고가 오는지만 알려준다
  for (const acct of live) {
    const act_no = s(acct.acct_no);
    const name = nameOf(act_no);
    const kr = await nh.call('/krstock/inquiry/v1/balance', { act_no, bnc_bse_cd: '1', ltg_aot_dit_cd: '9', aet_bse: '2', qut_dit_cd: 'UNT', aly_qut_cd: '1' });
    const gb = await nh.call('/gbstock/inquiry/v1/balance', { act_no, qut_iqr_dit_cd: '9', fc_sec_trd_nat_cd: '200', cur_cd: 'KRW', xns_dit_cd: '0' });
    if (!name) {
      if (!(failed(kr, 'Output_0') && failed(gb, 'Output_0'))) {
        const k = mapKrStock('', kr);
        const g = mapGbStock('', gb);
        unmapped.push({ suffix: act_no.slice(-4), holdings: k.rows.length + g.rows.length, cash: (k.cash ?? 0) + (g.cashUsd ?? 0) });
      }
      continue;
    }
    const au = await nh.call('/krgold/inquiry/v1/goldDepositAndBalance', { act_no });
    if (failed(kr, 'Output_0') && failed(gb, 'Output_0') && failed(au, 'Output_0')) {
      warnings.push(`${name}: 잔고를 받지 못했습니다 (${s(kr.rsp_msg) || s(gb.rsp_msg)}) — 엑셀 값 유지`);
      continue;
    }
    const k = mapKrStock(name, kr);
    const g = mapGbStock(name, gb);
    const a = mapGold(name, au);
    usdKrw ??= g.usdKrw;
    const cash: CashRow[] = [{ account: name, currency: 'KRW', amount: k.cash ?? a.cash ?? 0 }];
    if (g.cashUsd) cash.push({ account: name, currency: 'USD', amount: g.cashUsd });
    accounts.push({ name, suffix: act_no.slice(-4), rows: [...k.rows, ...g.rows, ...a.rows], cash });

    if (dividendsFrom) {
      try {
        const txs = await nh.callAll('/common/inquiry/v1/totalTransaction', {
          iqr_tp_cd: '1', iqr_rge_cd: '1', act_no, iqr_sta_dt: ymd(dividendsFrom), iqr_end_dt: ymd(today), iem_llf_cd: '00', act_trd_dtl_cd: '00',
        });
        const tickerByName = new Map([...k.rows, ...g.rows].map((r) => [r.name, r.code]));
        fresh.push(...mapDividends(name, txs, tickerByName));
        fetchedAccounts.push(name);
      } catch (e) {
        warnings.push(`${name} 배당 내역: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 현재가 · 등락률: 물어본 종목 + NH 계좌 종목 (NH 계좌 종목의 현재가는 잔고 값을 그대로 쓰고 등락률만)
  const prices: Record<string, number> = {};
  const changes: Record<string, number> = {};
  const closes: SyncResult['closes'] = {};
  const asked = new Set(quotes.map((q) => q.code));
  const targets = new Map<string, Currency>(quotes.map((q) => [q.code, q.currency]));
  for (const a of accounts) for (const r of a.rows) if (r.code && !targets.has(r.code)) targets.set(r.code, r.currency);
  for (const [code, currency] of targets) {
    try {
      const q = MARKET_BY_CODE[code] ? await quoteMarket(nh, code) : currency === 'KRW' ? (/^[0-9A-Z]{6}$/.test(code) ? await quoteKr(nh, code) : null) : await quoteUs(nh, code);
      if (!q) continue;
      if (q.change !== null) changes[code] = q.change;
      if (q.close) closes[code] = { close: q.close, date: q.closeDate, change: q.closeChange };
      if (asked.has(code)) {
        if (q.price) prices[code] = q.price;
        else warnings.push(`${code}: 현재가 없음 (${q.msg})`);
      }
    } catch (e) {
      if (asked.has(code)) warnings.push(`${code}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 달러 배당의 그날 환율 (NH 환율 일별 시세 'KRW' = USD/KRW, 최신일부터 거꾸로)
  if (ledger && dividendsFrom) {
    const fx = new Map<string, number>();
    if (fresh.some((r) => r.currency === 'USD')) {
      try {
        const days = Math.min(1000, Math.ceil((Date.parse(today) - Date.parse(dividendsFrom)) / 86_400_000) + 15);
        const r = await nh.call('/gbstock/quote/v1/symbolIndexFxPeriod', { iem_cd: 'KRW', end_dt: ymd(today), array_cnt: String(days), maxavg: '0', gubun: '1', xtick: '001', today_cls: '0', scale_change: '0' });
        for (const x of rows(r, 'Output_1')) {
          const d = s(x.bsop_date);
          if (d.length === 8 && n(x.ovrs_prpr)) fx.set(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, n(x.ovrs_prpr));
        }
      } catch (e) {
        warnings.push(`배당 환율: ${e instanceof Error ? e.message : String(e)} (오늘 환율로 계산)`);
      }
    }
    book = mergeLedger(book, fresh, fetchedAccounts, dividendsFrom, fx, usdKrw);
    await ledger.put(JSON.stringify({ updatedAt: new Date().toISOString(), rows: book } satisfies DividendLedger));
  }

  return { asOf: new Date().toISOString(), usdKrw, accounts, prices, changes, closes, dividends: book, dividendsFrom, unmapped, warnings };
}
