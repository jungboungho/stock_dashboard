import { norm, similarity, type PhotoRow } from './photo';
import { MARKETS } from '../../proxy/src/markets';

// ─────────────────────────────────────────────────────────────
// NH 종목 목록 (국내 주식 · ETF + 미국 주식 · ETF)
//  - "종목 목록 업데이트" 버튼: 중계 서버를 거쳐 NH 종목 마스터(.mst)를 받아 브라우저에서 해석하고
//    중계 서버에 '공유 목록'으로 올린다 → 어느 기기에서든 한 번 누르면 모든 기기가 같은 최신 목록을 쓴다
//  - 읽을 때: 공유 목록 → (못 받으면) 이 브라우저에 저장된 목록 → public/instruments.json (국내, 기본)
// 사진에서 읽은 종목 이름 앞부분으로 종목명 · 코드를 찾을 때 쓴다.
// ─────────────────────────────────────────────────────────────

/** MKT: 지수 · 환율 · 금 (proxy/src/markets.ts) */
export type Market = 'KR' | 'US' | 'MKT';

export interface Instrument {
  code: string;
  name: string;
  market: Market;
  /** 이름 말고도 찾을 말 (지수 · 환율: 지역 · 영문 이름 등) */
  aka?: string[];
}

/** 지수 · 환율 · 금. 목록 저장본이 예전 것이어도 항상 최신 목록으로 붙인다 */
export const MARKET_INSTRUMENTS: Instrument[] = MARKETS.map((m) => ({ code: m.code, name: m.name, market: 'MKT', aka: m.aka }));
const withMarkets = (items: Instrument[]): Instrument[] => [...MARKET_INSTRUMENTS, ...items.filter((i) => i.market !== 'MKT')];

export interface InstrumentList {
  updatedAt: string | null;
  items: Instrument[];
  /** shared: 중계 서버 공유 목록 · local: 이 브라우저 저장본 · bundled: 사이트 기본 (국내만) */
  source: 'shared' | 'local' | 'bundled';
}

type Proxy = { url: string; token: string };
type Wire = { updatedAt: string; items: [string, string, Market][] };

const KEY = 'stock-dashboard:instruments:v1';
let cache: Promise<InstrumentList> | null = null;
/** 캐시가 어느 중계 서버 기준인지 (설정이 생기면 공유 목록을 다시 확인) */
let cacheFor = '';

const fromWire = (d: Wire, source: InstrumentList['source']): InstrumentList => ({
  updatedAt: d.updatedAt,
  items: withMarkets(d.items.map(([code, name, market]) => ({ code, name, market }))),
  source,
});

function loadSaved(): Wire | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Wire) : null;
  } catch {
    return null;
  }
}

function saveLocal(text: string): void {
  try {
    localStorage.setItem(KEY, text);
  } catch {
    /* 저장 공간 부족: 이번 화면에서만 사용 */
  }
}

export function listInfo(l: InstrumentList): { updatedAt: string | null; kr: number; us: number; source: InstrumentList['source'] } {
  return { updatedAt: l.updatedAt, kr: l.items.filter((i) => i.market === 'KR').length, us: l.items.filter((i) => i.market === 'US').length, source: l.source };
}

async function fetchShared(proxy: Proxy): Promise<Wire | null> {
  const res = await fetch(`${proxy.url}/instruments`, { headers: { Authorization: `Bearer ${proxy.token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`공유 종목 목록을 받지 못했습니다 (${res.status})`);
  return (await res.json()) as Wire;
}

async function fetchBundled(): Promise<InstrumentList> {
  // 개발 서버는 BASE_URL '/', 배포본은 './' (페이지 기준 → /stock_dashboard/instruments.json)
  const r = await fetch(`${import.meta.env.BASE_URL}instruments.json`);
  if (!r.ok) throw new Error(`종목 목록을 받지 못했습니다 (${r.status})`);
  const d = (await r.json()) as { items: [string, string][] };
  return { updatedAt: null, items: withMarkets(d.items.map(([code, name]) => ({ code, name, market: 'KR' as const }))), source: 'bundled' };
}

/** 가장 최신 목록. 중계 서버 공유 목록이 이 브라우저 저장본보다 새것이면 저장본도 바꾼다 */
export function loadInstrumentList(proxy?: Proxy | null): Promise<InstrumentList> {
  const key = proxy?.token ? proxy.url : '';
  if (key !== cacheFor) cache = null;
  cacheFor = key;
  cache ??= (async () => {
    const saved = loadSaved();
    if (proxy?.token) {
      try {
        const shared = await fetchShared(proxy);
        if (shared && (!saved || shared.updatedAt > saved.updatedAt)) {
          saveLocal(JSON.stringify(shared));
          return fromWire(shared, 'shared');
        }
        if (shared && saved && shared.updatedAt === saved.updatedAt) return fromWire(saved, 'shared');
      } catch {
        /* 중계 서버에 못 닿으면 저장본 · 기본 목록 */
      }
    }
    return saved ? fromWire(saved, 'local') : fetchBundled();
  })().catch((e) => {
    cache = null;
    throw e;
  });
  return cache;
}

export const loadInstruments = (proxy?: Proxy | null) => loadInstrumentList(proxy).then((l) => l.items);

// ─── NH 종목 마스터(.mst) 해석: CP949 · 고정 길이 레코드 (구조는 nhplug.com/instruments/*.h) ───

const DOMESTIC_REC = 237; // m_new_stock: sCode(6) sMarket(1) sKorName(41) …
const OVERSEAS_REC = 164; // m_gtsstock: sGIC(15) sKorName(40) sEngName(40) sNationCode(3) sSymbol(12) …

function records(bytes: Uint8Array, size: number, label: string): Uint8Array[] {
  if (bytes.length % size) throw new Error(`${label} 파일 크기가 레코드 크기와 맞지 않습니다 (구조가 바뀌었을 수 있음)`);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

export function parseDomesticMaster(bytes: Uint8Array): Instrument[] {
  const dec = new TextDecoder('euc-kr');
  const ascii = new TextDecoder('ascii');
  return records(bytes, DOMESTIC_REC, '국내 종목')
    .map((r) => ({ code: ascii.decode(r.subarray(0, 6)).trim(), name: dec.decode(r.subarray(7, 48)).trim().replace(/^[*#]+/, '').trim(), market: 'KR' as const }))
    .filter((i) => i.code && i.name);
}

/** 미국(USA) 종목만 (대시보드는 원화 · 달러만 다룸). 한글 이름이 없으면 영문 이름 */
export function parseOverseasMaster(bytes: Uint8Array): Instrument[] {
  const dec = new TextDecoder('euc-kr');
  const ascii = new TextDecoder('ascii');
  const out: Instrument[] = [];
  for (const r of records(bytes, OVERSEAS_REC, '해외 종목')) {
    if (ascii.decode(r.subarray(95, 98)) !== 'USA') continue;
    const code = ascii.decode(r.subarray(98, 110)).trim();
    const name = dec.decode(r.subarray(15, 55)).trim() || ascii.decode(r.subarray(55, 95)).trim();
    if (code && name) out.push({ code, name, market: 'US' });
  }
  return out;
}

/** 중계 서버를 거쳐 국내 · 미국 종목 마스터를 받아 해석하고, 공유 목록으로 올린다 (이 브라우저에도 저장) */
export async function refreshInstruments(proxy: Proxy, onProgress: (msg: string) => void): Promise<{ kr: number; us: number; shared: boolean; error?: string }> {
  const get = async (file: string, label: string) => {
    onProgress(`${label} 종목 파일 받는 중…`);
    let res: Response;
    try {
      res = await fetch(`${proxy.url}/instruments/${file}.mst`, { headers: { Authorization: `Bearer ${proxy.token}` } });
    } catch {
      throw new Error('중계 서버에 연결하지 못했습니다');
    }
    if (res.status === 401) throw new Error('접속 토큰이 맞지 않습니다');
    if (!res.ok) throw new Error(`${label} 종목 파일을 받지 못했습니다 (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  };
  const kr = parseDomesticMaster(await get('m_new_stock', '국내'));
  const us = parseOverseasMaster(await get('m_gtsstock', '해외'));
  if (kr.length < 1000) throw new Error(`국내 종목이 너무 적습니다 (${kr.length}) — 파일을 확인하세요`);
  // 지수 · 환율 · 금도 함께 저장 (공유 목록에서 바로 검색되도록)
  const wire: Wire = { updatedAt: new Date().toISOString(), items: [...MARKET_INSTRUMENTS, ...kr, ...us].map((i) => [i.code, i.name, i.market]) };
  const text = JSON.stringify(wire);
  saveLocal(text);
  cacheFor = proxy.url;
  cache = Promise.resolve(fromWire(wire, 'local'));
  onProgress('공유 목록으로 올리는 중…');
  try {
    const res = await fetch(`${proxy.url}/instruments`, { method: 'PUT', headers: { Authorization: `Bearer ${proxy.token}`, 'Content-Type': 'application/json' }, body: text });
    if (!res.ok) throw new Error(`중계 서버 응답 ${res.status}`);
    cache = Promise.resolve(fromWire(wire, 'shared'));
    return { kr: kr.length, us: us.length, shared: true };
  } catch (e) {
    return { kr: kr.length, us: us.length, shared: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── 검색 ─────────────────────────────────────────────────────

const normCache = new WeakMap<Instrument[], string[][]>();
/** 종목마다 찾을 이름들 (이름 + 별칭) */
function normalized(list: Instrument[]): string[][] {
  let n = normCache.get(list);
  if (!n) normCache.set(list, (n = list.map((i) => [i.name, ...(i.aka ?? [])].map(norm))));
  return n;
}
const MARKET_ORDER: Record<Market, number> = { MKT: 0, KR: 1, US: 2 };

/** 아이콘 찌꺼기 · '…' 를 뺀, 검색에 쓸 앞부분 */
function queryOf(ocrName: string): string {
  return ocrName
    .replace(/(\.{1,3}|…)\s*$/, '')
    .replace(/\s+(?:\S{1,2})$/, (m) => (/[가-힣A-Za-z]{2}/.test(m) ? m : '')) // 끝에 붙은 1~2글자 찌꺼기
    .trim();
}

/**
 * 이름 앞부분이 같은 종목 (국내 먼저, 짧은 이름 순). 하나도 없으면 비슷한 이름 상위 몇 개.
 * 띄어쓰기 · 괄호는 무시한다 ('TIGER 미국나스닥100레버리지' → 'TIGER 미국나스닥100레버리지(합성)').
 */
export function searchInstruments(list: Instrument[], ocrName: string, limit = 8): Instrument[] {
  const q = norm(queryOf(ocrName));
  if (q.length < 2 && !(q.length === 1 && /[가-힣]/.test(q))) return [];
  const names = normalized(list);
  const prefix = list
    .filter((i, k) => (q.length >= 2 ? names[k].some((n) => n.startsWith(q)) : i.market === 'MKT' && names[k].includes(q)))
    // 지수 · 환율 먼저, 그다음 국내 · 미국, 짧은 이름 순
    .sort((a, b) => MARKET_ORDER[a.market] - MARKET_ORDER[b.market] || a.name.length - b.name.length);
  if (prefix.length) return prefix.slice(0, limit);
  return list
    .map((i) => ({ i, s: similarity(q, i.name) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.min(limit, 5))
    .map((x) => x.i);
}

/**
 * 보유 종목과 못 맞춘 줄: 종목 목록에서 찾아 하나면 채우고, 여러 개면 첫 번째로 채우고 고를 수 있게 후보를 붙인다.
 * 영문 티커(TSLA)로 읽힌 줄은 미국 종목 코드로 쓴다 (목록에 있으면 한글 이름으로).
 */
export function fillFromInstruments(rows: PhotoRow[], all: Instrument[]): PhotoRow[] {
  const list = all.filter((i) => i.market !== 'MKT'); // 계좌 사진에는 지수 · 환율이 없다
  return rows.map((row) => {
    if (row.matched) return row;
    const ticker = row.ocrName.trim().toUpperCase();
    if (/^[A-Z]{1,5}$/.test(ticker)) {
      const us = list.find((i) => i.market === 'US' && i.code === ticker);
      return { ...row, name: us?.name ?? ticker, code: ticker, currency: 'USD', matched: us ? 'list' : row.matched };
    }
    const found = searchInstruments(list, row.ocrName);
    if (!found.length) return row;
    const first = found[0];
    return {
      ...row,
      name: first.name,
      code: first.code,
      currency: first.market === 'US' ? 'USD' : 'KRW',
      matched: 'list',
      candidates: found.length > 1 ? found.map((f) => ({ code: f.code, name: f.name, market: f.market === 'US' ? 'US' : 'KR' })) : undefined,
    };
  });
}
