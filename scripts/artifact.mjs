// vite build 결과(dist/index.html)를 Claude 아티팩트용 페이지(dist/artifact.html)로 바꾼다.
// 아티팩트는 게시할 때 <!doctype>/<html>/<head>/<body> 골격을 직접 씌우므로 그 태그와
// charset·viewport meta 를 빼고, 머리 요소(title, link, script)와 본문만 남긴다.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? '';
const body = html.match(/<body>([\s\S]*?)<\/body>/i)?.[1] ?? '';

const headKept = head
  .split('\n')
  .filter((l) => !/<meta\s+(charset|name="viewport")/i.test(l))
  .join('\n')
  .trim();

const out = `<title>자산 대시보드</title>
<meta name="claude:viewport-fit-sides" content="cover">
${headKept.replace(/<title>[\s\S]*?<\/title>\s*/i, '')}
${body.trim()}
`;
writeFileSync('dist/artifact.html', out);

const assets = readdirSync('dist/assets');
console.log('dist/artifact.html written; assets:', assets.join(', '));
