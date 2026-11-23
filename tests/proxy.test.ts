import { describe, expect, it } from 'vitest';
import { handle, type ListStore, type ProxyEnv } from '../proxy/src/handler';
import type { TokenStore } from '../proxy/src/nh';

const env: ProxyEnv = { NH_APP_KEY: 'k', NH_APP_SECRET: 's', NH_ACCOUNTS: '1234:종합', PROXY_TOKEN: 'secret\n' };
const tokens: TokenStore = { get: async () => null, set: async () => {} };
const req = (method: string, path: string, body?: string, token = 'secret') =>
  new Request(`https://proxy.test${path}`, { method, body, headers: { Authorization: `Bearer ${token}`, Origin: 'https://jungboungho.github.io' } });

describe('중계 서버: 공유 종목 목록', () => {
  it('저장 전 404 → 형식 확인 → 저장 → 다른 기기가 같은 목록을 받는다', async () => {
    let saved: string | null = null;
    const list: ListStore = { get: async () => saved, put: async (v) => void (saved = v) };
    expect((await handle(req('GET', '/instruments'), env, tokens, list)).status).toBe(404);
    expect((await handle(req('PUT', '/instruments', '{"oops":1}'), env, tokens, list)).status).toBe(400);
    const body = JSON.stringify({ updatedAt: '2026-11-23T06:00:00Z', items: [['005930', '삼성전자', 'KR'], ['TSLA', '테슬라', 'US']] });
    const put = await handle(req('PUT', '/instruments', body), env, tokens, list);
    expect(put.status).toBe(200);
    const got = await handle(req('GET', '/instruments'), env, tokens, list);
    expect(got.headers.get('Access-Control-Allow-Origin')).toBe('https://jungboungho.github.io');
    expect(await got.json()).toEqual(JSON.parse(body));
  });

  it('토큰이 틀리면 읽기 · 쓰기 모두 401 (비밀값 끝 줄바꿈은 무시)', async () => {
    const list: ListStore = { get: async () => '{}', put: async () => {} };
    expect((await handle(req('GET', '/instruments', undefined, 'wrong'), env, tokens, list)).status).toBe(401);
    expect((await handle(req('PUT', '/instruments', '{}', 'wrong'), env, tokens, list)).status).toBe(401);
    const pre = await handle(new Request('https://proxy.test/instruments', { method: 'OPTIONS', headers: { Origin: 'https://jungboungho.github.io' } }), env, tokens, list);
    expect(pre.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
  });
});
