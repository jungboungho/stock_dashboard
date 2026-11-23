// 처음 쓰는 사람을 위한 엑셀 양식 (public/template.xlsx) — 모든 숫자는 예시 값
//   npx vite-node tools/build_template.ts
import { writeFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { upsertSheets } from '../src/data/excel/write';

const skeleton = zipSync({
  '[Content_Types].xml': strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  ),
  '_rels/.rels': strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  ),
  'xl/workbook.xml': strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets></sheets></workbook>',
  ),
  'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
});

// 월별 표: 2025-01 ~ 2026-11, 예시 입금과 기말자산 (단위 만원)
const months: (string | number | null)[][] = [];
let value = 1200;
for (let y = 2025; y <= 2026; y++) {
  for (let m = 1; m <= 12; m++) {
    if (y === 2026 && m > 11) break;
    const deposit = m % 3 === 1 ? 100 : 0;
    value = Math.round(value * (1 + ((m * 7) % 5) / 100 - 0.01) + deposit);
    months.push([`${y}-${String(m).padStart(2, '0')}`, deposit, m === 6 ? 300 : 0, null, value]);
  }
}

const out = upsertSheets(skeleton, [
  {
    name: '안내',
    widths: [16, 90],
    rows: [
      ['시트', '쓰는 법 (숫자는 모두 예시 — 지우고 내 값으로 바꾸세요)'],
      ['Summary', '맨 위 A열 = 계좌 이름, B열 = 그 계좌 원금. C열 단위(10000 = 만원) · 목표(연 수익률). 년도 표 = 연초 총자산 · 그해 순입금. 날짜 표 = 월별 계좌별 입금(월투자금 열 앞까지가 계좌) · 기말자산'],
      ['입금내역', '날짜별 · 계좌별 입금 (음수 = 출금 · 계좌 간 이체). 머리글 계좌 이름은 대시보드 계좌 이름이 됩니다'],
      ['설정', '중계 서버 주소 · 접속 토큰 (npm run worker:setup 이 알려줌). NH 계좌 줄은 첫 동기화 후 ③ 엑셀 업데이트가 만들어 주니 B열에 계좌 이름만 적으세요'],
      ['(자동)', '보유종목 · 그룹 · 일별 / 월별 자산추이 · 배당 시트는 대시보드의 ③ 엑셀 업데이트가 만듭니다'],
    ],
  },
  {
    name: 'Summary',
    widths: [10, 10, 10, 10, 12],
    rows: [
      ['종합', 1300, '목표', 0.1],
      ['ISA', 600, '단위', 10000],
      [],
      ['년도', '총자산', '변경'],
      [2025, 1200, 700],
      [2026, 1950, 1000],
      [],
      ['날짜', '종합', 'ISA', '월투자금', '기말자산'],
      ...months,
    ],
  },
  {
    name: '입금내역',
    widths: [12, 10, 10],
    rows: [
      ['날짜', '종합', 'ISA'],
      ...months.filter((r) => (r[1] as number) || (r[2] as number)).map((r) => [`${r[0]}-05`, ((r[1] as number) || 0) * 10000 || null, ((r[2] as number) || 0) * 10000 || null]),
    ],
  },
  {
    name: '설정',
    widths: [18, 70, 50],
    rows: [
      ['항목', '값', '설명'],
      ['중계 서버 주소', null, 'npm run worker:setup 이 알려주는 https://…workers.dev 주소'],
      ['접속 토큰', null, 'npm run worker:setup 이 만든 값 (local-data/worker-token.txt) — 이 엑셀을 다른 사람과 공유하지 마세요'],
    ],
  },
]);
writeFileSync('public/template.xlsx', out);
console.log(`public/template.xlsx ${out.length} bytes`);
