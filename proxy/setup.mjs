#!/usr/bin/env node
// 내 Cloudflare 계정에 중계 서버(Worker)를 한 번에 설정 · 배포한다.
//
//   npm run worker:setup              # 처음 설정 (이미 된 단계는 건너뜀)
//   npm run worker:setup -- --dry-run # 바꾸는 명령은 실행하지 않고 보여만 줌
//   npm run worker:setup -- --new-token  # 접속 토큰을 새로 만듦 (엑셀 설정 시트도 바꿔야 함)
//
// 하는 일: Cloudflare 로그인 확인 → proxy/wrangler.toml 준비(대시보드 주소 · KV) → 배포
//         → 비밀값 등록(NH 앱키 · 시크릿은 직접 입력, 접속 토큰은 자동 생성) → 엑셀 '설정' 시트에 넣을 값 안내
// NH 앱키 · 시크릿은 이 스크립트가 읽거나 저장하지 않는다 (wrangler 가 직접 입력받아 Cloudflare 에만 보냄).

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

// npm 을 거치면 PowerShell 이 '--' 를 먹어 플래그가 npm 으로 갈 수 있어 npm_config_* 도 본다
const flag = (name) => process.argv.includes(`--${name}`) || process.env[`npm_config_${name.replace(/-/g, '_')}`] === 'true';
const dry = flag('dry-run');
const newToken = flag('new-token');
const proxyDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(proxyDir, '..');
const toml = resolve(proxyDir, 'wrangler.toml');
const tokenFile = resolve(root, 'local-data', 'worker-token.txt');
const win = process.platform === 'win32';
const rl = createInterface({ input: process.stdin, output: process.stdout });

const say = (s = '') => console.log(s);
const step = (n, s) => say(`\n[${n}] ${s}`);

/** wrangler 실행. capture: 출력 받기 · interactive: 사용자 입력 · input: 표준입력으로 값 전달 · mutating: dry-run 이면 건너뜀 */
function wrangler(args, { capture = false, interactive = false, input, mutating = false } = {}) {
  if (dry && mutating) {
    say(`   (dry-run) npx wrangler ${args.join(' ')}`);
    return { status: 0, out: '' };
  }
  // Windows 는 npx 가 .cmd 라 셸로 실행 (인자는 이 스크립트가 정한 고정 문자열뿐)
  const r = spawnSync(win ? `npx --yes wrangler@4 ${args.join(' ')}` : 'npx', win ? [] : ['--yes', 'wrangler@4', ...args], {
    cwd: proxyDir,
    shell: win,
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    input,
    stdio: interactive ? 'inherit' : input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (!capture && !interactive && out.trim()) say(out.trim().split('\n').map((l) => `   ${l}`).join('\n'));
  return { status: r.status ?? 1, out };
}

async function ask(q, def = '') {
  const a = (await rl.question(`   ${q}${def ? ` [${def}]` : ''}: `)).trim();
  return a || def;
}

function githubPagesOrigin() {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
  const m = /github\.com[/:]([^/]+)\/[^/]+?(?:\.git)?\s*$/.exec(r.stdout ?? '');
  return m ? `https://${m[1].toLowerCase()}.github.io` : '';
}

async function main() {
  say(`중계 서버(Cloudflare Worker) 설정${dry ? ' — dry-run (바꾸는 명령은 실행하지 않음)' : ''}`);

  step(1, 'Cloudflare 로그인 확인');
  const who = wrangler(['whoami'], { capture: true });
  if (/not authenticated|wrangler login/i.test(who.out)) {
    say('   로그인이 필요합니다. 브라우저가 열리면 로그인하고 Allow 를 누르세요.');
    if (!dry && wrangler(['login'], { interactive: true }).status !== 0) throw new Error('Cloudflare 로그인에 실패했습니다');
  } else {
    say('   로그인됨');
  }

  step(2, 'proxy/wrangler.toml 준비');
  if (!existsSync(toml)) {
    if (!dry) copyFileSync(resolve(proxyDir, 'wrangler.example.toml'), toml);
    say(dry ? '   (dry-run) wrangler.example.toml 을 wrangler.toml 로 복사할 예정' : '   wrangler.example.toml 을 wrangler.toml 로 복사했습니다');
  }
  let conf = existsSync(toml) ? readFileSync(toml, 'utf8') : readFileSync(resolve(proxyDir, 'wrangler.example.toml'), 'utf8');
  const curOrigins = /ALLOWED_ORIGINS\s*=\s*"([^"]*)"/.exec(conf)?.[1] ?? '';
  if (!curOrigins || curOrigins.includes('YOUR_GITHUB_ID')) {
    const site = await ask('대시보드 주소 (내 GitHub Pages)', githubPagesOrigin());
    if (!/^https:\/\/[^/]+$/.test(site)) throw new Error('대시보드 주소는 https://아이디.github.io 형태로 입력하세요');
    conf = conf.replace(/ALLOWED_ORIGINS\s*=\s*"[^"]*"/, `ALLOWED_ORIGINS = "${site},http://localhost:5173"`);
    say(`   허용 출처: ${site}`);
  } else {
    say(`   허용 출처: ${curOrigins}`);
  }
  if (/REPLACE_WITH_KV_ID/.test(conf)) {
    say('   KV(토큰 · 배당 장부 · 종목 목록 저장소) 만드는 중…');
    const kv = wrangler(['kv', 'namespace', 'create', 'TOKENS'], { capture: true, mutating: true });
    const id = /id\s*=\s*"([0-9a-f]{32})"/.exec(kv.out)?.[1];
    if (!dry) {
      if (!id) throw new Error(`KV 를 만들지 못했습니다:\n${kv.out}`);
      conf = conf.replace('REPLACE_WITH_KV_ID', id);
    }
  } else {
    say('   KV 는 이미 설정되어 있습니다');
  }
  if (!dry) writeFileSync(toml, conf);

  step(3, '배포');
  const dep = wrangler(['deploy'], { capture: true, mutating: true });
  if (/workers\.dev subdomain/i.test(dep.out)) {
    const url = /https:\/\/dash\.cloudflare\.com\/\S+/.exec(dep.out)?.[0] ?? 'https://dash.cloudflare.com → Workers';
    say(`   workers.dev 하위 도메인을 먼저 정해야 합니다: ${url}`);
    say('   등록한 뒤 이 스크립트를 다시 실행하세요.');
    return;
  }
  if (!dry && dep.status !== 0) throw new Error(`배포 실패:\n${dep.out}`);
  const workerUrl = /https:\/\/[^\s]+\.workers\.dev/.exec(dep.out)?.[0] ?? '(배포 후 표시되는 https://…workers.dev 주소)';
  say(`   중계 서버 주소: ${workerUrl}`);

  step(4, '비밀값');
  const list = wrangler(['secret', 'list'], { capture: true });
  const has = (n) => list.out.includes(`"${n}"`);
  for (const name of ['NH_APP_KEY', 'NH_APP_SECRET']) {
    if (has(name)) {
      say(`   ${name}: 이미 있음 (바꾸려면 proxy 폴더에서 npx wrangler secret put ${name})`);
      continue;
    }
    say(`   ${name}: NH PLUG 포털(nhplug.com)에서 받은 값을 붙여 넣으세요 (화면에 보이지 않음)`);
    wrangler(['secret', 'put', name], { interactive: true, mutating: true });
  }
  let token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
  if (!has('PROXY_TOKEN') || newToken || !token) {
    token = randomBytes(32).toString('hex');
    wrangler(['secret', 'put', 'PROXY_TOKEN'], { input: token, mutating: true });
    if (!dry) {
      mkdirSync(dirname(tokenFile), { recursive: true });
      writeFileSync(tokenFile, token);
    }
    say(`   PROXY_TOKEN: 새로 만들어 등록했습니다 (local-data/worker-token.txt 에 저장, git 제외)`);
  } else {
    say('   PROXY_TOKEN: 이미 있음 (local-data/worker-token.txt)');
  }

  step(5, "엑셀 '설정' 시트에 넣을 값");
  say('   A열                | B열');
  say(`   중계 서버 주소       | ${workerUrl}`);
  say(`   접속 토큰           | ${dry ? '(local-data/worker-token.txt 내용)' : token}`);
  say('   NH 계좌 ####       | (첫 동기화 후 ③ 엑셀 업데이트가 줄을 만들어 줌 — B열에 계좌 이름을 적기)');
  say('\n   접속 토큰은 내 잔고를 조회할 수 있는 열쇠입니다. 엑셀을 다른 사람과 공유하지 마세요.');
}

main()
  .catch((e) => {
    console.error(`\n설정을 마치지 못했습니다: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
