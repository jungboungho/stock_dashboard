import { describe, expect, it, vi } from 'vitest';
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

describe('중계 서버: NH 가 응답하는 모든 계좌', () => {
  it('이름이 정해진 계좌만 반영하고, 이름 없는 계좌는 알려만 준다 · 엑셀 매핑이 함께 쓰인다', async () => {
    const { buildSync } = await import('../proxy/src/nh');
    const balanceBy: Record<string, unknown> = {
      '11100001234': { rsp_msg: '조회가 완료되었습니다.', Output_0: { dca: 100 }, Output_1: [{ iem_cd: '360750', iem_nm: 'TIGER', itg_bnc_qty: 2, phs_pr: 10, now_pr: 12 }] },
      '22200004321': { rsp_msg: '조회가 완료되었습니다.', Output_0: { dca: 50 }, Output_1: [{ iem_cd: '379810', iem_nm: 'KODEX', itg_bnc_qty: 3, phs_pr: 10, now_pr: 11 }] },
      '33300008765': { rsp_msg: '조회가 완료되었습니다.', Output_0: { dca: 7 } },
    };
    const fake = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const input = JSON.parse(String(init?.body ?? '{}')).Input_0 ?? {};
      if (path === '/n2/acctinfo')
        return new Response(JSON.stringify({ rsp_msg: '조회가 완료되었습니다.', Output_0: [{ acct_no: '11100001234', acct_type: '01' }, { acct_no: '22200004321', acct_type: '01' }, { acct_no: '33300008765', acct_type: '01' }, { acct_no: '99900000000', acct_type: '03' }] }));
      if (path === '/krstock/inquiry/v1/balance') return new Response(JSON.stringify(balanceBy[input.act_no] ?? {}));
      return new Response(JSON.stringify({ rsp_msg: '조회가 완료되었습니다.' }));
    }) as typeof fetch;
    const tokens: TokenStore = { get: async () => ({ access_token: 't', expires_at: Date.now() / 1000 + 3600 }), set: async () => {} };
    // 서버 비밀값엔 1234 만, 엑셀 설정에서 8765 = 연금1 (4321 은 이름 없음), 5678 은 NH 응답에 없음
    const res = await buildSync({ appKey: 'k', appSecret: 's', accounts: '1234:종합,5678:금계좌,8765:연금1', tokens, fetch: fake, intervalMs: 0 }, []);
    expect(res.accounts.map((a) => [a.name, a.rows.length, a.cash[0].amount])).toEqual([
      ['종합', 1, 100],
      ['연금1', 0, 7],
    ]);
    expect(res.unmapped).toEqual([{ suffix: '4321', holdings: 1, cash: 50 }]);
    expect(res.warnings.join()).toContain('금계좌');
  });

  it('요청의 accountMap(엑셀 설정)이 서버 매핑과 합쳐지고, 같은 끝자리는 엑셀 쪽 이름', async () => {
    const fake = (async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const input = JSON.parse(String(init?.body ?? '{}')).Input_0 ?? {};
      if (path === '/n2/acctinfo') return new Response(JSON.stringify({ rsp_msg: '조회가 완료되었습니다.', Output_0: [{ acct_no: '11100001234', acct_type: '01' }, { acct_no: '22200004321', acct_type: '01' }] }));
      if (path === '/krstock/inquiry/v1/balance') return new Response(JSON.stringify({ rsp_msg: '조회가 완료되었습니다.', Output_0: { dca: input.act_no.endsWith('1234') ? 1 : 2 } }));
      return new Response(JSON.stringify({ rsp_msg: '조회가 완료되었습니다.' }));
    }) as typeof fetch;
    vi.stubGlobal('fetch', fake);
    try {
      const tokens2: TokenStore = { get: async () => ({ access_token: 't', expires_at: Date.now() / 1000 + 3600 }), set: async () => {} };
      const envWithMap: ProxyEnv = { ...env, NH_ACCOUNTS: '1234:종합' };
      const body = JSON.stringify({ quotes: [], accountMap: { '1234': '위탁', '4321': 'ISA', bad: 'x', '9999': 'a,b' } });
      const res = await handle(req('POST', '/sync', body), envWithMap, tokens2);
      const data = (await res.json()) as { accounts: { name: string }[]; unmapped: unknown[] };
      expect(data.accounts.map((a) => a.name)).toEqual(['위탁', 'ISA']);
      expect(data.unmapped).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
