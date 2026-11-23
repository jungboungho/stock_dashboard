import type { Currency } from '../types';
import { holdingKey, rowCostKRW, rowValueKRW, type HoldingRow, type HoldingsState } from './holdings';

// ─────────────────────────────────────────────────────────────
// 증권사 앱 계좌 화면 캡처(OCR 글자) → 계좌의 종목 · 수량 · 평가금 · 손익 · 현금
//  화면 구조: [계좌 이름] [총액] … '투자' 목록(종목명 평가금 / 수량 손익) … '현금' 목록
//  OCR 은 '주'·'원' 같은 글자를 자주 틀리므로 숫자와 줄 구조로 읽고,
//  종목 이름은 지금 보유 종목과 비슷한 이름 → 같은 수량 → 비슷한 금액 순으로 맞춘다.
// ─────────────────────────────────────────────────────────────

export interface PhotoRow {
  name: string;
  /** 지금 보유 종목과 맞춘 경우 그 종목의 코드 · 통화 */
  code: string;
  currency: Currency;
  quantity: number | null;
  /** 평가금 (원) */
  value: number | null;
  /** 평가손익 (원), 못 읽으면 null */
  pnl: number | null;
  /** OCR 원문 이름 (확인용) */
  ocrName: string;
  matched: 'name' | 'quantity' | 'value' | null;
}

export interface PhotoResult {
  account: string | null;
  /** 화면 맨 위 총액 (원) */
  total: number | null;
  rows: PhotoRow[];
  cashKRW: number | null;
  cashUSD: number | null;
}

const AMOUNT = /[+\-−~]?\d{1,3}(?:[,.]\d{3})+(?![\d.,]*\d)/g;
const toNum = (s: string) => Number(s.replace(/[+\-−~,.]/g, '')) * (/^[\-−~]/.test(s) ? -1 : 1);
const signed = (s: string) => /^[+\-−~]/.test(s);
/** 앱 화면의 메뉴 · 광고 줄 (종목 이름에 '배당' 같은 글자가 들어가므로 줄 모양으로 거른다) */
const STOP = /^(?:시세\s*평가.*|.*총\s*수익.*|.*직접설정.*|.*일간\s*수익.*|계좌\s+수익.*|.*세금\s+배당.*|.*\s관리$|.*관리$|친구와.*|.*다운로드.*|AD\s.*|.*국민 협동.*|자산\s+관심.*|증권사 미제공.*)$/;

const norm = (s: string) => s.replace(/[\s()·.,|_\-]/g, '').toUpperCase();
function similarity(a: string, b: string): number {
  const A = norm(a);
  const B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(A);
  const gb = grams(B);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  return (2 * inter) / (A.length - 1 + B.length - 1 || 1);
}

/** 이름 앞의 아이콘 OCR 찌꺼기 (S, (er, @, 숭 …) 제거 */
function cleanName(s: string): string {
  return s
    .replace(/^[^A-Za-z가-힣]*/, '')
    .replace(/^(?:[A-Za-z]{1,2}|\(er|er|숭|으|ㅇ|[가-힣])\s+(?=\S{2,})/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function detectAccount(lines: string[], accounts: string[]): string | null {
  const head = lines.slice(0, 5).join(' ');
  const alias: [RegExp, string][] = [
    [/금현물/, '금계좌'],
    [/IRP/i, 'IRP'],
    [/ISA/i, 'ISA'],
  ];
  const byName = [...accounts].sort((a, b) => b.length - a.length).find((a) => head.includes(a));
  if (byName) return byName;
  for (const [re, name] of alias) if (re.test(head) && accounts.includes(name)) return name;
  return null;
}

export function parseAccountScreen(text: string, accounts: string[]): PhotoResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\(\s*[+\-−]?[\d.,]+\s*%?\s*\)?\s*$/, ' ').replace(/\(\s*[+\-−]?[\d.,]+\s*%?\s*\)/g, ' ').trim()) // (+14.77%) 같은 수익률 괄호 제거
    .filter(Boolean);
  const res: PhotoResult = { account: detectAccount(lines, accounts), total: null, rows: [], cashKRW: null, cashUSD: null };

  // 총액: '일간 수익' 줄 앞의 첫 큰 금액
  const dayIdx = lines.findIndex((l) => /일간/.test(l));
  for (const l of lines.slice(0, dayIdx > 0 ? dayIdx : 6)) {
    const m = l.match(AMOUNT);
    if (m && !signed(m[0]) && toNum(m[0]) >= 1000) {
      res.total = toNum(m[0]);
      break;
    }
    if (/^\D{0,3}0\s*원/.test(l)) {
      res.total = 0; // 빈 계좌
      break;
    }
  }

  type Cur = { names: string[]; value: number | null; pnl: number | null; quantity: number | null };
  let cur: Cur | null = null;
  const flush = () => {
    if (cur && cur.value !== null) {
      const ocrName = cleanName(cur.names.join(' '));
      res.rows.push({ name: ocrName, ocrName, code: '', currency: 'KRW', quantity: cur.quantity, value: cur.value, pnl: cur.pnl, matched: null });
    }
    cur = null;
  };

  let section: 'none' | 'invest' | 'cash' = 'none';
  for (const raw of lines) {
    if (/^투자$|총\s*수익|직접설정/.test(raw)) {
      section = 'invest';
      continue;
    }
    if (/^현금$/.test(raw) || /^현금\s*$/.test(raw)) {
      flush();
      section = 'cash';
      continue;
    }
    const cashLike = /현금성자산/.test(raw);
    if (section === 'cash' || cashLike) {
      const usd = /\$\s*([\d,]+\.\d{1,2})/.exec(raw);
      if (usd) res.cashUSD = Number(usd[1].replace(/,/g, ''));
      else if (/원|현금성자산/.test(raw)) {
        const m = raw.match(AMOUNT) ?? raw.match(/\d[\d,]*(?=\s*원)/g);
        if (m) res.cashKRW = (res.cashKRW ?? 0) + Math.abs(toNum(m[m.length - 1]));
      }
      if (cashLike) flush();
      continue;
    }
    if (section !== 'invest' || STOP.test(raw)) {
      if (STOP.test(raw) && section === 'invest' && /관리/.test(raw)) {
        flush();
        section = 'none';
      }
      continue;
    }

    // 수량 줄: 앞에 글자 없이 숫자로 시작 (117주, 1,952%, 783&)
    // (종목 줄은 항상 이름으로 시작하므로, 숫자로 시작하는 줄은 수량 줄)
    const lead = /^[^\dA-Za-z가-힣+\-−]{0,3}(\d{1,3}(?:,\d{3})+|\d+)(?=\D|$)/.exec(raw);
    const amounts = [...raw.matchAll(AMOUNT)];
    const c0 = cur as Cur | null;
    if (lead && c0 && c0.value !== null && c0.quantity === null) {
      c0.quantity = Number(lead[1].replace(/,/g, ''));
      const end = lead.index + lead[0].length;
      const rest = amounts.filter((x) => x.index! >= end);
      const p = rest.find((x) => signed(x[0])) ?? rest[0];
      if (p && c0.pnl === null) c0.pnl = toNum(p[0]);
      continue;
    }

    const value = amounts.find((a) => !signed(a[0]));
    const pnl = amounts.find((a) => signed(a[0]));
    const text = raw.replace(AMOUNT, ' ').replace(/[원%&¥¢!$]+/g, ' ').trim();
    if (value) {
      const c = cur as Cur | null;
      if (c && c.value !== null && c.quantity === null) {
        // 평가금 다음에 나온 두 번째 금액 = 손익인데 부호를 못 읽음 → 손익은 비워 두고(예전 매입금액 유지) 이름만 이어 붙임
        const before = raw.slice(0, value.index).replace(/[원%&¥¢!$]+/g, ' ');
        if (cleanName(before)) c.names.push(before);
        continue;
      }
      if (c && c.value !== null) flush();
      if (!cur) cur = { names: [], value: null, pnl: null, quantity: null };
      const cc = cur as Cur;
      if (cc.value === null) {
        cc.value = toNum(value[0]);
        const before = raw.slice(0, value.index).replace(/[원%&¥¢!$]+/g, ' ');
        if (cleanName(before)) cc.names.push(before);
      }
      if (pnl) cc.pnl = toNum(pnl[0]);
      continue;
    }
    if (pnl && cur) {
      (cur as Cur).pnl = toNum(pnl[0]);
      const before = cleanName(raw.slice(0, pnl.index));
      if (before) (cur as Cur).names.push(before);
      continue;
    }
    // 글자만 있는 줄: 다음 종목 이름의 앞부분이거나 지금 종목 이름의 뒷부분
    if (cleanName(text)) {
      const c = cur as Cur | null;
      if (c && c.value !== null && c.quantity === null) c.names.push(text);
      else if (c && c.value !== null && c.quantity !== null) {
        flush();
        cur = { names: [text], value: null, pnl: null, quantity: null };
      } else {
        if (!cur) cur = { names: [], value: null, pnl: null, quantity: null };
        (cur as Cur).names.push(text);
      }
    }
  }
  flush();
  return res;
}

/** 계좌를 못 읽었으면 총액이 가장 가까운 계좌로 */
export function guessAccountByTotal(total: number | null, totals: Record<string, number>): string | null {
  if (!total) return null;
  let best: string | null = null;
  let diff = Infinity;
  for (const [a, t] of Object.entries(totals)) {
    const d = Math.abs(t - total) / Math.max(total, 1);
    if (d < diff) [best, diff] = [a, d];
  }
  return diff < 0.15 ? best : null;
}

/** 읽은 종목을 지금 보유 종목(그 계좌 우선, 그다음 전체)과 맞춘다 */
export function matchHoldings(res: PhotoResult, h: HoldingsState): PhotoResult {
  const inAccount = h.rows.filter((r) => r.account === res.account);
  const pool = [...inAccount, ...h.rows.filter((r) => r.account !== res.account)];
  const used = new Set<HoldingRow>();
  const take = (row: PhotoRow, r: HoldingRow, how: PhotoRow['matched']) => {
    used.add(r);
    return { ...row, name: r.name, code: r.code, currency: r.currency, matched: how };
  };
  // 1) 이름
  let rows = res.rows.map((row) => {
    let best: HoldingRow | null = null;
    let score = 0;
    for (const r of pool) {
      if (used.has(r) && r.account === res.account) continue;
      const s = Math.max(similarity(row.ocrName, r.name), r.code ? similarity(row.ocrName, r.code) : 0);
      if (s > score) [best, score] = [r, s];
    }
    return best && score >= 0.45 ? take(row, best, 'name') : row;
  });
  // 2) 같은 계좌의 같은 수량, 3) 비슷한 평가금
  rows = rows.map((row) => {
    if (row.matched) return row;
    const free = inAccount.filter((r) => !used.has(r));
    const q = free.find((r) => row.quantity !== null && r.quantity === row.quantity);
    if (q) return take(row, q, 'quantity');
    const v = free.find((r) => row.value && Math.abs(r.quantity * (r.price ?? r.avgPrice) - row.value) / row.value < 0.15);
    return v ? take(row, v, 'value') : row;
  });
  return { ...res, rows };
}

/** 확인한 결과로 그 계좌의 종목 · 현금을 바꾼다 */
export function applyPhoto(h: HoldingsState, account: string, rows: PhotoRow[], cashKRW: number | null, cashUSD: number | null, usdKrw: number): HoldingsState {
  const old = new Map(h.rows.filter((r) => r.account === account).map((r) => [holdingKey(r), r]));
  const next: HoldingRow[] = rows
    .filter((r) => r.name.trim() && r.quantity && r.quantity > 0 && r.value && r.value > 0)
    .map((r) => {
      const qty = r.quantity!;
      const value = r.value!;
      const prev = old.get(holdingKey({ code: r.code, name: r.name }));
      const fx = r.currency === 'USD' ? usdKrw : 1;
      // 손익을 못 읽었으면 예전 매입금액(수량 비례) 유지
      const cost = r.pnl !== null ? value - r.pnl : prev ? (rowCostKRW(prev, usdKrw) / prev.quantity) * qty : value;
      return {
        account,
        code: r.code.trim().toUpperCase(),
        name: r.name.trim(),
        currency: r.currency,
        quantity: qty,
        price: Math.round((value / qty / fx) * 100) / 100,
        avgPrice: Math.round((cost / qty / fx) * 100) / 100,
        costKRW: Math.round(cost),
      };
    });
  const cash = h.cash.filter((c) => c.account !== account);
  cash.push({ account, currency: 'KRW', amount: cashKRW ?? 0 });
  if (cashUSD) cash.push({ account, currency: 'USD', amount: cashUSD });
  return { ...h, rows: [...h.rows.filter((r) => r.account !== account), ...next], cash, asOf: new Date().toISOString() };
}

/** 확인 화면용: 읽은 합계와 화면 총액 비교 */
export function photoTotal(rows: PhotoRow[], cashKRW: number | null, cashUSD: number | null, usdKrw: number): number {
  return rows.reduce((s, r) => s + (r.value ?? 0), 0) + (cashKRW ?? 0) + (cashUSD ?? 0) * usdKrw;
}

export { rowValueKRW };
