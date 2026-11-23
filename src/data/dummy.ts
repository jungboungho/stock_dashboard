import type { DataProvider } from './provider';
import type { Account, FxSeries, Instrument, ISODate, PriceSeries, Transaction } from '../types';

// ─────────────────────────────────────────────────────────────
// 가상 데이터. 종목 이름만 실제이고 가격 · 배당 · 거래는 모두 seed 로 만든 임의 값이다.
// ─────────────────────────────────────────────────────────────

interface InstrumentSpec extends Instrument {
  start: number; // 시작가 (종목 통화)
  mu: number; // 연 기대수익률
  sigma: number; // 연 변동성
  beta: number; // 시장 요인 민감도 (0~1)
  /** 배당 지급 월 (1~12) 과 회당 주당 배당금 (종목 통화) */
  dividend?: { months: number[]; perShare: number };
}

const INSTRUMENTS: InstrumentSpec[] = [
  { code: '005930', name: '삼성전자', currency: 'KRW', assetClass: '국내주식', region: '한국', sector: '반도체', start: 74000, mu: 0.06, sigma: 0.28, beta: 0.7, dividend: { months: [2, 5, 8, 11], perShare: 361 } },
  { code: '000660', name: 'SK하이닉스', currency: 'KRW', assetClass: '국내주식', region: '한국', sector: '반도체', start: 138000, mu: 0.22, sigma: 0.42, beta: 0.7, dividend: { months: [2, 5, 8, 11], perShare: 300 } },
  { code: '035420', name: 'NAVER', currency: 'KRW', assetClass: '국내주식', region: '한국', sector: '인터넷', start: 225000, mu: -0.02, sigma: 0.32, beta: 0.5, dividend: { months: [4], perShare: 1100 } },
  { code: '005380', name: '현대차', currency: 'KRW', assetClass: '국내주식', region: '한국', sector: '자동차', start: 205000, mu: 0.08, sigma: 0.27, beta: 0.6, dividend: { months: [4, 5, 8, 11], perShare: 2000 } },
  { code: '069500', name: 'KODEX 200', currency: 'KRW', assetClass: 'ETF', region: '한국', sector: '지수', start: 35000, mu: 0.07, sigma: 0.18, beta: 0.9, dividend: { months: [1, 4, 7, 10], perShare: 180 } },
  { code: '360750', name: 'TIGER 미국S&P500', currency: 'KRW', assetClass: 'ETF', region: '미국', sector: '지수', start: 14500, mu: 0.14, sigma: 0.17, beta: 0.9, dividend: { months: [1, 4, 7, 10], perShare: 40 } },
  { code: '148070', name: 'KOSEF 국고채10년', currency: 'KRW', assetClass: '채권', region: '한국', sector: '채권', start: 112000, mu: 0.03, sigma: 0.06, beta: 0.1, dividend: { months: [1, 4, 7, 10], perShare: 750 } },
  { code: 'AAPL', name: 'Apple', currency: 'USD', assetClass: '해외주식', region: '미국', sector: 'IT', start: 185, mu: 0.12, sigma: 0.26, beta: 0.8, dividend: { months: [2, 5, 8, 11], perShare: 0.25 } },
  { code: 'MSFT', name: 'Microsoft', currency: 'USD', assetClass: '해외주식', region: '미국', sector: 'IT', start: 375, mu: 0.14, sigma: 0.24, beta: 0.8, dividend: { months: [3, 6, 9, 12], perShare: 0.8 } },
  { code: 'NVDA', name: 'NVIDIA', currency: 'USD', assetClass: '해외주식', region: '미국', sector: '반도체', start: 48, mu: 0.45, sigma: 0.5, beta: 0.8, dividend: { months: [3, 6, 9, 12], perShare: 0.01 } },
  { code: 'JNJ', name: 'Johnson & Johnson', currency: 'USD', assetClass: '해외주식', region: '미국', sector: '헬스케어', start: 158, mu: 0.04, sigma: 0.17, beta: 0.4, dividend: { months: [3, 6, 9, 12], perShare: 1.22 } },
  { code: 'SCHD', name: 'Schwab US Dividend ETF', currency: 'USD', assetClass: 'ETF', region: '미국', sector: '지수', start: 25.5, mu: 0.07, sigma: 0.15, beta: 0.8, dividend: { months: [3, 6, 9, 12], perShare: 0.25 } },
  { code: 'O', name: 'Realty Income', currency: 'USD', assetClass: '리츠', region: '미국', sector: '리츠', start: 56, mu: 0.03, sigma: 0.2, beta: 0.5, dividend: { months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], perShare: 0.26 } },
];

const ACCOUNTS: Account[] = [
  { id: 'A1', name: '종합매매', institution: '가상증권', type: '위탁' },
  { id: 'A2', name: 'ISA', institution: '가상증권', type: 'ISA' },
  { id: 'A3', name: '연금저축', institution: '가상투자증권', type: '연금저축' },
];

interface AccountPlan {
  accountId: string;
  initial: number;
  monthly: number;
  targets: Record<string, number>;
  taxFreeDividend: boolean;
  withdrawals?: { date: ISODate; amount: number }[];
}

const PLANS: AccountPlan[] = [
  {
    accountId: 'A1',
    initial: 30_000_000,
    monthly: 1_500_000,
    taxFreeDividend: false,
    targets: { '005930': 0.12, '000660': 0.08, '035420': 0.05, '005380': 0.05, AAPL: 0.15, MSFT: 0.15, NVDA: 0.15, JNJ: 0.05, SCHD: 0.12, O: 0.08 },
    withdrawals: [{ date: '2025-08-11', amount: 8_000_000 }],
  },
  {
    accountId: 'A2',
    initial: 10_000_000,
    monthly: 1_000_000,
    taxFreeDividend: true,
    targets: { '069500': 0.3, '360750': 0.4, '148070': 0.2, '005930': 0.1 },
  },
  {
    accountId: 'A3',
    initial: 5_000_000,
    monthly: 500_000,
    taxFreeDividend: true,
    targets: { '360750': 0.6, '148070': 0.4 },
  },
];

export const DUMMY_START: ISODate = '2024-01-02';
export const DUMMY_END: ISODate = '2026-11-20';

const FEE = { KRW: 0.00015, USD: 0.001 };
const DIV_TAX = { KRW: 0.154, USD: 0.15 };

// ─── 유틸 ─────────────────────────────────────────────────────

/** 재현 가능한 난수 (mulberry32) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function businessDays(start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(iso(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const round = (n: number, currency: 'KRW' | 'USD') => (currency === 'KRW' ? Math.round(n / 5) * 5 : Math.round(n * 100) / 100);

// ─── 생성 ─────────────────────────────────────────────────────

export interface DummyDataset {
  accounts: Account[];
  instruments: Instrument[];
  transactions: Transaction[];
  prices: PriceSeries[];
  fx: FxSeries;
}

export function generateDummy(seed = 20240102): DummyDataset {
  const rand = rng(seed);
  const dates = businessDays(DUMMY_START, DUMMY_END);
  const dt = 1 / 252;

  // 가격: 시장 공통 요인 + 개별 요인 GBM
  const closes: Record<string, number[]> = {};
  for (const s of INSTRUMENTS) closes[s.code] = [s.start];
  const fxRates = [1300];
  for (let i = 1; i < dates.length; i++) {
    const market = normal(rand);
    for (const s of INSTRUMENTS) {
      const z = s.beta * market + Math.sqrt(1 - s.beta * s.beta) * normal(rand);
      const prev = closes[s.code][i - 1];
      const next = prev * Math.exp((s.mu - (s.sigma * s.sigma) / 2) * dt + s.sigma * Math.sqrt(dt) * z);
      closes[s.code].push(round(next, s.currency));
    }
    // 환율: 1380 근처로 회귀하는 랜덤워크
    const prevFx = fxRates[i - 1];
    fxRates.push(Math.round((prevFx + 0.02 * (1380 - prevFx) * dt * 50 + prevFx * 0.06 * Math.sqrt(dt) * normal(rand)) * 10) / 10);
  }

  const spec = Object.fromEntries(INSTRUMENTS.map((s) => [s.code, s]));
  const priceAt = (code: string, i: number) => closes[code][i];
  const krwPrice = (code: string, i: number) => priceAt(code, i) * (spec[code].currency === 'USD' ? fxRates[i] : 1);

  // 입금일: 첫 영업일 + 매월 25일(휴일이면 다음 영업일)
  const depositIdx = new Set<number>();
  let lastMonth = '';
  for (let i = 0; i < dates.length; i++) {
    const ym = dates[i].slice(0, 7);
    if (ym !== lastMonth && Number(dates[i].slice(8)) >= 25) {
      depositIdx.add(i);
      lastMonth = ym;
    }
  }
  // 배당 지급일: 지급 월의 15일 이후 첫 영업일
  const divIdx = new Map<number, number>(); // date index -> month
  let lastDivMonth = '';
  for (let i = 0; i < dates.length; i++) {
    const ym = dates[i].slice(0, 7);
    if (ym !== lastDivMonth && Number(dates[i].slice(8)) >= 15) {
      divIdx.set(i, Number(dates[i].slice(5, 7)));
      lastDivMonth = ym;
    }
  }

  const transactions: Transaction[] = [];

  for (const plan of PLANS) {
    let cash = 0;
    const shares: Record<string, number> = {};
    const withdrawals = new Map((plan.withdrawals ?? []).map((w) => [w.date, w.amount]));

    const trade = (i: number, code: string, qty: number) => {
      if (qty === 0) return;
      const s = spec[code];
      const price = priceAt(code, i);
      const fx = s.currency === 'USD' ? fxRates[i] : 1;
      const gross = Math.abs(qty) * price * fx;
      const fee = gross * FEE[s.currency];
      const amount = Math.round(qty > 0 ? gross + fee : gross - fee);
      cash += qty > 0 ? -amount : amount;
      shares[code] = (shares[code] ?? 0) + qty;
      transactions.push({
        date: dates[i],
        accountId: plan.accountId,
        type: qty > 0 ? 'BUY' : 'SELL',
        code,
        quantity: Math.abs(qty),
        price,
        amountKRW: amount,
        ...(s.currency === 'USD' ? { fxRate: fx } : {}),
      });
    };

    const holdingsValue = (i: number) => Object.entries(shares).reduce((sum, [c, q]) => sum + q * krwPrice(c, i), 0);

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];

      // 배당
      const month = divIdx.get(i);
      if (month !== undefined) {
        for (const [code, q] of Object.entries(shares)) {
          const d = spec[code].dividend;
          if (!q || !d || !d.months.includes(month)) continue;
          const s = spec[code];
          const fx = s.currency === 'USD' ? fxRates[i] : 1;
          const tax = plan.taxFreeDividend ? 0 : DIV_TAX[s.currency];
          const amount = Math.round(q * d.perShare * fx * (1 - tax));
          if (amount <= 0) continue;
          cash += amount;
          transactions.push({ date, accountId: plan.accountId, type: 'DIVIDEND', code, amountKRW: amount, ...(s.currency === 'USD' ? { fxRate: fx } : {}) });
        }
      }

      // 출금: 비중대로 팔아서 현금 확보
      const w = withdrawals.get(date);
      if (w) {
        const total = holdingsValue(i);
        const need = Math.max(0, w - cash);
        for (const [code, q] of Object.entries(shares)) {
          if (need === 0 || q === 0) continue;
          const share = (q * krwPrice(code, i)) / total;
          const sell = Math.min(q, Math.ceil((share * need) / krwPrice(code, i)) + 1);
          trade(i, code, -sell);
        }
        cash -= w;
        transactions.push({ date, accountId: plan.accountId, type: 'WITHDRAW', amountKRW: w });
      }

      // 입금 + 목표 비중으로 매수
      const isFirst = i === 0;
      if (isFirst || depositIdx.has(i)) {
        const amount = isFirst ? plan.initial : plan.monthly;
        cash += amount;
        transactions.push({ date, accountId: plan.accountId, type: 'DEPOSIT', amountKRW: amount });

        const total = holdingsValue(i) + cash;
        const deficits = Object.entries(plan.targets).map(([code, wt]) => {
          const cur = (shares[code] ?? 0) * krwPrice(code, i);
          return { code, gap: Math.max(0, wt * total - cur) };
        });
        const gapSum = deficits.reduce((s, d) => s + d.gap, 0);
        const budget = cash * 0.995;
        for (const d of deficits) {
          if (gapSum <= 0) break;
          const alloc = (budget * d.gap) / gapSum;
          const unit = krwPrice(d.code, i) * (1 + FEE[spec[d.code].currency]);
          const qty = Math.floor(alloc / unit);
          if (qty > 0) trade(i, d.code, qty);
        }
      }
    }
  }

  const order: Record<string, number> = { DEPOSIT: 0, DIVIDEND: 1, SELL: 2, WITHDRAW: 3, BUY: 4 };
  transactions.sort((a, b) => a.date.localeCompare(b.date) || a.accountId.localeCompare(b.accountId) || order[a.type] - order[b.type]);

  return {
    accounts: ACCOUNTS,
    instruments: INSTRUMENTS.map(({ code, name, currency, assetClass, region, sector }) => ({ code, name, currency, assetClass, region, sector })),
    transactions,
    prices: INSTRUMENTS.map((s) => ({ code: s.code, dates, closes: closes[s.code] })),
    fx: { pair: 'USDKRW', dates, rates: fxRates },
  };
}

export class DummyProvider implements DataProvider {
  readonly name = 'dummy';
  private readonly data: DummyDataset;

  constructor(seed?: number) {
    this.data = generateDummy(seed);
  }

  async getAccounts() {
    return this.data.accounts;
  }
  async getInstruments() {
    return this.data.instruments;
  }
  async getTransactions() {
    return this.data.transactions;
  }
  async getPriceHistory() {
    return this.data.prices;
  }
  async getFxHistory() {
    return this.data.fx;
  }
}
