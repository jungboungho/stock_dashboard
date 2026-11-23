import { handle, type ProxyEnv } from './handler';

// Cloudflare Worker 진입점. 앱키 · 시크릿 · 접속 토큰은 `wrangler secret put` 으로만 넣는다.
interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export default {
  async fetch(req: Request, env: ProxyEnv & { TOKENS: KV }): Promise<Response> {
    return handle(req, env, {
      get: async () => JSON.parse((await env.TOKENS.get('nh_token')) ?? 'null'),
      set: async (t) => env.TOKENS.put('nh_token', JSON.stringify(t), { expirationTtl: 86400 }),
    });
  },
};
