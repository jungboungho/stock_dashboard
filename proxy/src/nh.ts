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
  rows: HoldingRow[];
  cash: CashRow[];
}
export interface SyncResult {
  asOf: string;
  usdKrw: number | null;
  accounts: SyncAccount[];
  prices: Record<string, number>;
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
    this.f = cfg.fetch ?? fetch;
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

  async call(path: string, input: Json, retried = false): Promise<Json> {
    const gap = (this.cfg.intervalMs ?? 220) - (Date.now() - this.last);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    this.last = Date.now();
    const token = await this.getToken();
    const res = await this.f(`${NH_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ Input_0: input }),
    });
    if (res.status === 401 && !retried) {
      this.token = null;
      await this.getToken(true);
      return this.call(path, input, true);
    }
    if (!res.ok) throw new Error(`NH ${path} HTTP ${res.status}`);
    return (await res.json()) as Json;
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
  return { rows: items, cashUsd: head ? n(head.fc_dca) : null, usdKrw };
}

export function mapGold(account: string, r: Json): { rows: HoldingRow[]; cash: number | null } {
  const { rows: items, cash } = mapKrStock(account, r);
  return { rows: items, cash };
}

const failed = (r: Json, block: string) => !rows(r, block).length && !/완료|정상|조회/.test(s(r.rsp_msg));

export async function buildSync(cfg: NhConfig, quotes: { code: string; currency: Currency }[]): Promise<SyncResult> {
  const nh = new NhClient(cfg);
  const warnings: string[] = [];
  const map = parseAccountMap(cfg.accounts);
  const info = await nh.call('/n2/acctinfo', {});
  const live = rows(info, 'Output_0').filter((a) => s(a.acct_type) === '01' || s(a.acct_type) === '02');
  let usdKrw: number | null = null;
  const accounts: SyncAccount[] = [];

  for (const { suffix, name } of map) {
    const acct = live.find((a) => s(a.acct_no).endsWith(suffix));
    if (!acct) {
      warnings.push(`${name}: NH 계좌 목록에 끝자리 ${suffix} 계좌가 없습니다`);
      continue;
    }
    const act_no = s(acct.acct_no);
    const kr = await nh.call('/krstock/inquiry/v1/balance', { act_no, bnc_bse_cd: '1', ltg_aot_dit_cd: '9', aet_bse: '2', qut_dit_cd: 'UNT', aly_qut_cd: '1' });
    const gb = await nh.call('/gbstock/inquiry/v1/balance', { act_no, qut_iqr_dit_cd: '9', fc_sec_trd_nat_cd: '200', cur_cd: 'KRW', xns_dit_cd: '0' });
    const au = await nh.call('/krgold/inquiry/v1/goldDepositAndBalance', { act_no });
    if (failed(kr, 'Output_0') && failed(gb, 'Output_0') && failed(au, 'Output_0')) {
      warnings.push(`${name}: 잔고를 받지 못했습니다 (${s(kr.rsp_msg) || s(gb.rsp_msg)})`);
      continue;
    }
    const k = mapKrStock(name, kr);
    const g = mapGbStock(name, gb);
    const a = mapGold(name, au);
    usdKrw ??= g.usdKrw;
    const cash: CashRow[] = [{ account: name, currency: 'KRW', amount: k.cash ?? a.cash ?? 0 }];
    if (g.cashUsd) cash.push({ account: name, currency: 'USD', amount: g.cashUsd });
    accounts.push({ name, rows: [...k.rows, ...g.rows, ...a.rows], cash });
  }

  const prices: Record<string, number> = {};
  for (const q of quotes) {
    try {
      if (q.currency === 'KRW' && /^[0-9A-Z]{6}$/.test(q.code)) {
        const r = await nh.call('/krstock/quote/v1/currentPrice', { iem_cd: q.code, market_cd: 'UNT' });
        const p = n(rows(r, 'Output_0')[0]?.stck_prpr);
        if (p) prices[q.code] = p;
        else warnings.push(`${q.code}: 현재가 없음 (${s(r.rsp_msg)})`);
      } else if (q.currency === 'USD') {
        const r = await nh.call('/gbstock/quote/v1/current', { iem_cd: q.code });
        const p = n(rows(r, 'Output_0')[0]?.trdprc);
        if (p) prices[q.code] = p;
        else warnings.push(`${q.code}: 현재가 없음 (${s(r.rsp_msg)})`);
      }
    } catch (e) {
      warnings.push(`${q.code}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { asOf: new Date().toISOString(), usdKrw, accounts, prices, warnings };
}
