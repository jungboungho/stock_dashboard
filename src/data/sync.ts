import type { Currency } from '../types';
import type { HoldingsState, SyncResult } from './holdings';
import { quoteTargets } from './holdings';

/**
 * 마이데이터 동기화 (NH 투자증권 Open API 중계 서버).
 * 앱키 · 시크릿은 중계 서버에만 있고, 브라우저는 중계 서버 주소와 접속 토큰만 안다.
 * 주소 · 토큰은 이 브라우저에만 저장한다 (공개 저장소 · 사이트에는 넣지 않음).
 */
export interface SyncSettings {
  url: string;
  token: string;
  /** NH 계좌 끝자리 → 대시보드 계좌 이름 (엑셀 '설정' 시트의 'NH 계좌 1234' 줄) */
  accountMap?: Record<string, string>;
}

const KEY = 'stock-dashboard:sync:v1';

export function loadSyncSettings(): SyncSettings | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as SyncSettings | null;
    if (s?.url && s.token) return s;
  } catch {
    /* 무시 */
  }
  const url = (import.meta.env.VITE_MYDATA_PROXY_URL as string | undefined)?.trim();
  return url ? { url, token: '' } : null;
}

export function saveSyncSettings(s: SyncSettings | null): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* 무시 */
  }
}

export function normalizeUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(u)) throw new Error('주소는 https:// 로 시작해야 합니다');
  return u;
}

async function request<T>(s: SyncSettings, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${s.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('중계 서버에 연결하지 못했습니다. 주소와 인터넷 연결을 확인하세요.');
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 401) throw new Error('접속 토큰이 맞지 않습니다.');
  if (!res.ok) throw new Error(data.error ?? `중계 서버 오류 (${res.status})`);
  return data;
}

export async function checkProxy(s: SyncSettings): Promise<{ accounts: string[] }> {
  return request(s, '/health');
}

/** NH 계좌 잔고 + 나머지 계좌 종목의 현재가 */
export async function fetchSync(s: SyncSettings, h: HoldingsState, apiAccounts: string[], extra: { code: string; currency: Currency }[] = []): Promise<SyncResult> {
  // 배당은 중계 서버가 자기 장부의 최신일 − 14일부터 다시 받아 장부 전체를 돌려준다
  const quotes = new Map(quoteTargets(h, apiAccounts).map((q) => [q.code, q]));
  for (const q of extra) if (!quotes.has(q.code)) quotes.set(q.code, q); // 관심 종목
  return request<SyncResult>(s, '/sync', { quotes: [...quotes.values()], accountMap: s.accountMap ?? {} });
}
