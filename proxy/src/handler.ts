import { buildSync, parseAccountMap, type Currency, type TokenStore } from './nh';

// 중계 서버 공통 처리 (Cloudflare Worker · 로컬 개발 서버가 같이 씀)
//  GET  /health  → 설정된 계좌 이름 (NH 호출 없음)
//  POST /sync    → { quotes: [{code, currency}] } → SyncResult
// 모든 요청은 Authorization: Bearer <PROXY_TOKEN> 필요.

export interface ProxyEnv {
  NH_APP_KEY: string;
  NH_APP_SECRET: string;
  NH_ACCOUNTS: string;
  PROXY_TOKEN: string;
  /** 쉼표로 구분한 허용 출처 */
  ALLOWED_ORIGINS?: string;
}

const DEFAULT_ORIGINS = 'https://jungboungho.github.io,http://localhost:5173,http://localhost:5179';

function cors(req: Request, env: ProxyEnv): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(',').map((o) => o.trim());
  if (!allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function handle(req: Request, rawEnv: ProxyEnv, tokens: TokenStore): Promise<Response> {
  // 비밀값을 넣을 때 따라 들어온 줄바꿈 · 공백 제거
  const t = (v: string | undefined) => (v ?? '').trim();
  const env: ProxyEnv = { ...rawEnv, NH_APP_KEY: t(rawEnv.NH_APP_KEY), NH_APP_SECRET: t(rawEnv.NH_APP_SECRET), NH_ACCOUNTS: t(rawEnv.NH_ACCOUNTS), PROXY_TOKEN: t(rawEnv.PROXY_TOKEN) };
  const h = cors(req, env);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...h, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

  const auth = req.headers.get('Authorization') ?? '';
  if (!env.PROXY_TOKEN || !safeEqual(auth, `Bearer ${env.PROXY_TOKEN}`)) return json({ error: '접속 토큰이 맞지 않습니다' }, 401);

  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  try {
    if (req.method === 'GET' && path === '/health') {
      return json({ ok: true, accounts: parseAccountMap(env.NH_ACCOUNTS ?? '').map((a) => a.name) });
    }
    if (req.method === 'POST' && path === '/sync') {
      const body = (await req.json().catch(() => ({}))) as { quotes?: { code: string; currency: Currency }[] };
      const quotes = (body.quotes ?? []).filter((q) => q && typeof q.code === 'string' && (q.currency === 'KRW' || q.currency === 'USD')).slice(0, 60);
      const result = await buildSync({ appKey: env.NH_APP_KEY, appSecret: env.NH_APP_SECRET, accounts: env.NH_ACCOUNTS, tokens }, quotes);
      return json(result);
    }
    // 종목 마스터 파일 (공개 · 인증 불필요). NH 사이트가 브라우저 직접 접근(CORS)을 막아서 그대로 전달만 한다.
    // 해석은 브라우저가 한다 (Worker 무료 CPU 한도 안에서 끝나도록)
    const mst = /^\/instruments\/(m_new_stock|m_gtsstock)\.mst$/.exec(path);
    if (req.method === 'GET' && mst) {
      const res = await fetch(`https://www.nhplug.com/instruments/${mst[1]}.mst`);
      if (!res.ok) return json({ error: `종목 파일을 받지 못했습니다 (NH ${res.status})` }, 502);
      return new Response(res.body, { headers: { ...h, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
    }
    return json({ error: '없는 경로입니다' }, 404);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
}
