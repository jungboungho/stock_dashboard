import { norm, similarity, type PhotoRow } from './photo';

// ─────────────────────────────────────────────────────────────
// NH 종목 목록 (국내 주식 · ETF + 미국 주식 · ETF)
//  - 기본: public/instruments.json (국내, tools/build_instruments.py 로 만듦)
//  - "종목 목록 업데이트" 버튼: 중계 서버를 거쳐 NH 종목 마스터(.mst)를 받아 브라우저에서 해석하고
//    이 브라우저에 저장 → 그 뒤로는 저장된 최신 목록을 쓴다
// 사진에서 읽은 종목 이름 앞부분으로 종목명 · 코드를 찾을 때 쓴다.
// ─────────────────────────────────────────────────────────────

export type Market = 'KR' | 'US';

export interface Instrument {
  code: string;
  name: string;
  market: Market;
}

export interface InstrumentList {
  updatedAt: string | null;
  items: Instrument[];
}

const KEY = 'stock-dashboard:instruments:v1';
let cache: Promise<InstrumentList> | null = null;

function loadSaved(): InstrumentList | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as { updatedAt: string; items: [string, string, Market][] };
    return { updatedAt: d.updatedAt, items: d.items.map(([code, name, market]) => ({ code, name, market })) };
  } catch {
    return null;
  }
}

export function savedListInfo(): { updatedAt: string; kr: number; us: number } | null {
  const l = loadSaved();
  return l?.updatedAt ? { updatedAt: l.updatedAt, kr: l.items.filter((i) => i.market === 'KR').length, us: l.items.filter((i) => i.market === 'US').length } : null;
}

export function loadInstrumentList(): Promise<InstrumentList> {
  const saved = loadSaved();
  if (saved) return Promise.resolve(saved);
  // 개발 서버는 BASE_URL '/', 배포본은 './' (페이지 기준 → /stock_dashboard/instruments.json)
  cache ??= fetch(`${import.meta.env.BASE_URL}instruments.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`종목 목록을 받지 못했습니다 (${r.status})`);
      return r.json() as Promise<{ items: [string, string][] }>;
    })
    .then((d) => ({ updatedAt: null, items: d.items.map(([code, name]) => ({ code, name, market: 'KR' as const })) }))
    .catch((e) => {
      cache = null;
      throw e;
    });
  return cache;
}

export const loadInstruments = () => loadInstrumentList().then((l) => l.items);

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

/** 중계 서버를 거쳐 국내 · 미국 종목 마스터를 받아 이 브라우저에 저장 */
export async function refreshInstruments(proxy: { url: string; token: string }, onProgress: (msg: string) => void): Promise<{ kr: number; us: number }> {
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
  const updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(KEY, JSON.stringify({ updatedAt, items: [...kr, ...us].map((i) => [i.code, i.name, i.market]) }));
  } catch {
    throw new Error('브라우저 저장 공간이 부족해 종목 목록을 저장하지 못했습니다');
  }
  cache = null;
  return { kr: kr.length, us: us.length };
}

// ─── 검색 ─────────────────────────────────────────────────────

const normCache = new WeakMap<Instrument[], string[]>();
function normalized(list: Instrument[]): string[] {
  let n = normCache.get(list);
  if (!n) normCache.set(list, (n = list.map((i) => norm(i.name))));
  return n;
}

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
  if (q.length < 2) return [];
  const names = normalized(list);
  const prefix = list
    .filter((_, i) => names[i].startsWith(q))
    .sort((a, b) => (a.market === b.market ? 0 : a.market === 'KR' ? -1 : 1) || a.name.length - b.name.length);
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
export function fillFromInstruments(rows: PhotoRow[], list: Instrument[]): PhotoRow[] {
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
      candidates: found.length > 1 ? found.map((f) => ({ code: f.code, name: f.name, market: f.market })) : undefined,
    };
  });
}
