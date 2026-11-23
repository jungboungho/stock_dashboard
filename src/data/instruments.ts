import { norm, similarity, type PhotoRow } from './photo';

// ─────────────────────────────────────────────────────────────
// NH 국내주식 · ETF 종목 목록 (public/instruments.json, tools/build_instruments.py 로 만듦)
// 사진에서 읽은 종목 이름 앞부분으로 종목명 · 코드를 찾는다.
// ─────────────────────────────────────────────────────────────

export interface Instrument {
  code: string;
  name: string;
}

let cache: Promise<Instrument[]> | null = null;

export function loadInstruments(): Promise<Instrument[]> {
  // 개발 서버는 BASE_URL '/', 배포본은 './' (페이지 기준 → /stock_dashboard/instruments.json)
  cache ??= fetch(`${import.meta.env.BASE_URL}instruments.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`종목 목록을 받지 못했습니다 (${r.status})`);
      return r.json() as Promise<{ items: [string, string][] }>;
    })
    .then((d) => d.items.map(([code, name]) => ({ code, name })))
    .catch((e) => {
      cache = null;
      throw e;
    });
  return cache;
}

/** 아이콘 찌꺼기 · '…' 를 뺀, 검색에 쓸 앞부분 */
function queryOf(ocrName: string): string {
  return ocrName
    .replace(/(\.{1,3}|…)\s*$/, '')
    .replace(/\s+(?:\S{1,2})$/, (m) => (/[가-힣A-Za-z]{2}/.test(m) ? m : '')) // 끝에 붙은 1~2글자 찌꺼기
    .trim();
}

/**
 * 이름 앞부분이 같은 종목 (짧은 이름 순). 하나도 없으면 비슷한 이름 상위 몇 개.
 * 띄어쓰기 · 괄호는 무시한다 ('TIGER 미국나스닥100레버리지' → 'TIGER 미국나스닥100레버리지(합성)').
 */
export function searchInstruments(list: Instrument[], ocrName: string, limit = 8): Instrument[] {
  const q = norm(queryOf(ocrName));
  if (q.length < 2) return [];
  const prefix = list.filter((i) => norm(i.name).startsWith(q)).sort((a, b) => a.name.length - b.name.length);
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
 * 국내 종목(원화)만 대상 — 미국 종목은 앱이 티커를 이름으로 보여주므로 코드로 바로 쓴다.
 */
export function fillFromInstruments(rows: PhotoRow[], list: Instrument[]): PhotoRow[] {
  return rows.map((row) => {
    if (row.matched) return row;
    const ticker = row.ocrName.trim().toUpperCase();
    if (/^[A-Z]{1,5}$/.test(ticker)) return { ...row, name: ticker, code: ticker, currency: 'USD' };
    const found = searchInstruments(list, row.ocrName);
    if (!found.length) return row;
    return { ...row, name: found[0].name, code: found[0].code, currency: 'KRW', matched: 'list', candidates: found.length > 1 ? found : undefined };
  });
}
