import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { handle, type ProxyEnv } from './handler';

// 내 PC에서 돌리는 중계 서버 (개발 · 확인용). Cloudflare Worker 와 같은 코드를 쓴다.
//   npm run proxy
// 설정은 proxy/.dev.vars (git 제외) 에서 읽는다:
//   CRED_FILE=C:/내/경로/credential.txt   (또는 NH_APP_KEY / NH_APP_SECRET)
//   NH_ACCOUNTS=1234:종합,5678:금계좌
//   PROXY_TOKEN=아무도_모르는_긴_문자열
// 접근토큰은 local-data/nh_token.json 에 저장해 24시간 재사용한다.

const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const vars: Record<string, string> = {};
const varsFile = resolve(root, 'proxy', '.dev.vars');
if (existsSync(varsFile)) {
  for (const line of readFileSync(varsFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
const get = (k: string) => process.env[k] ?? vars[k] ?? '';

let appKey = get('NH_APP_KEY');
let appSecret = get('NH_APP_SECRET');
if ((!appKey || !appSecret) && get('CRED_FILE')) {
  for (const line of readFileSync(get('CRED_FILE'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const [k, ...rest] = line.split(':');
    const key = (k ?? '').toLowerCase().replace(/\s/g, '');
    if (key === 'appkey') appKey = rest.join(':').trim();
    if (key === 'appsecret') appSecret = rest.join(':').trim();
  }
}
const env: ProxyEnv = { NH_APP_KEY: appKey, NH_APP_SECRET: appSecret, NH_ACCOUNTS: get('NH_ACCOUNTS'), PROXY_TOKEN: get('PROXY_TOKEN'), ALLOWED_ORIGINS: get('ALLOWED_ORIGINS') || undefined };
if (!env.NH_APP_KEY || !env.NH_APP_SECRET || !env.PROXY_TOKEN || !env.NH_ACCOUNTS) {
  console.error('proxy/.dev.vars 에 CRED_FILE(또는 NH_APP_KEY/NH_APP_SECRET), NH_ACCOUNTS, PROXY_TOKEN 을 넣으세요.');
  process.exit(1);
}

const tokenFile = resolve(root, 'local-data', 'nh_token.json');
const tokens = {
  get: async () => (existsSync(tokenFile) ? JSON.parse(readFileSync(tokenFile, 'utf8')) : null),
  set: async (t: { access_token: string; expires_at: number }) => {
    mkdirSync(dirname(tokenFile), { recursive: true });
    writeFileSync(tokenFile, JSON.stringify(t));
  },
};

const port = Number(get('PORT') || 8787);
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  const response = await handle(request, env, tokens);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
  console.log(new Date().toISOString().slice(11, 19), req.method, req.url, response.status);
}).listen(port, () => console.log(`중계 서버: http://localhost:${port}  (계좌: ${env.NH_ACCOUNTS.split(',').map((a) => a.split(':')[1]).join(', ')})`));
