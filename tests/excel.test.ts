import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import { readWorkbook, type Workbook } from '../src/data/excel/xlsx';
import { parseStockBook, serialToIso, toDate } from '../src/data/excel/parse';
import { excelSnapshots, makeExcelModel } from '../src/data/excelModel';
import { yearlyReturns } from '../src/domain/yearly';

// 실제 파일과 같은 구조의 작은 가상 통합문서 (금액은 임의 값, 단위 만원)
const BOOK: Workbook = {
  Summary: {
    A1: '개인계좌', B1: 1100, C1: '목표', D1: 0.1,
    A2: 'ISA', B2: 500, C2: '단위', D2: 10000,
    A3: '연금', B3: 300,
    A7: '년도', B7: '자산', C7: '연금자산', D7: '총자산', E7: '변경', F7: '이익',
    A8: 2024, D8: 1000, E8: 400,
    A9: 2025, D9: 1500, E9: 500,
    A10: 2026,
    A16: '날짜', B16: '종합', C16: 'ISA', D16: '연금', E16: '월투자금', F16: '투자원금', G16: '기말자산',
    A17: '2024-01', B17: 900, D17: 100, G17: 1000,
    A18: '2024-06', B18: 200, C18: 200,
    A19: '2024-12', G19: 1500,
    A20: '2025-01', C20: 300, G20: 1900,
    A21: '2025-02', B21: 0, G21: 1850,
    A22: '2025-12', C22: 0, G22: 2100,
    A23: '2026-01', D23: 200, G23: 2400,
    A24: '2026-02',
  },
  입금내역: {
    A1: '날짜', B1: '종합', C1: 'ISA', D1: '연금1', E1: '연금2',
    A2: '~24 / 1 / 5', B2: 900, D2: 100,
    A3: 45460, B3: 200, C3: 200,
    A4: 45677, B4: -300, C4: 300,
    A5: 45700,
    A6: '2026-01-10', E6: 200,
  },
  // 최신이 아닌 시트 — 읽지 않아야 한다
  투자내역: { A3: '종목', B3: '개수', C3: '구매가격', A4: 'SCHD', B4: 10, C4: 25 },
  해외주식리스트: { A1: '미국주식 리스트', F1: '환율', A2: '테슬라', A3: 'SCHD', A4: '쿠팡', F2: 1400 },
};

describe('엑셀 해석', () => {
  const book = parseStockBook(BOOK, 'test.xlsx');

  it('계좌 · 단위 · 목표 · 환율', () => {
    expect(book.unit).toBe(10000);
    expect(book.goal).toBe(0.1);
    expect(book.usdKrw).toBe(1400);
    expect(book.accounts.map((a) => [a.name, a.principal])).toEqual([
      ['개인계좌', 11_000_000],
      ['ISA', 5_000_000],
      ['연금', 3_000_000],
    ]);
  });

  it('년도 표 → 연초 자산 · 순입금 (비어 있는 해는 제외)', () => {
    expect(book.yearStarts).toEqual([
      { year: 2024, start: 10_000_000, flow: 4_000_000 },
      { year: 2025, start: 15_000_000, flow: 5_000_000 },
    ]);
  });

  it('월별 표: 빈 달은 건너뛰고, 기말자산이 빈 달의 입금은 유지', () => {
    expect(book.months.map((m) => m.month)).toEqual(['2024-01', '2024-06', '2024-12', '2025-01', '2025-02', '2025-12', '2026-01']);
    expect(book.months[1]).toEqual({ month: '2024-06', flows: [2_000_000, 2_000_000, 0], endValue: null });
  });

  it('스냅샷: 원금 누적, 기말자산 없는 달 입금은 다음 스냅샷에 합산', () => {
    const s = excelSnapshots(book, '2026-01-20');
    expect(s.map((x) => x.date)).toEqual(['2024-01-31', '2024-12-31', '2025-01-31', '2025-02-28', '2025-12-31', '2026-01-20']);
    expect(s[1]).toMatchObject({ principal: 14_000_000, value: 15_000_000, netFlow: 4_000_000 });
    expect(s.at(-1)!.principal).toBe(19_000_000);
  });

  it('입금내역: 날짜 · 계좌별 금액, 빈 줄은 건너뜀', () => {
    expect(book.depositAccounts).toEqual(['종합', 'ISA', '연금1', '연금2']);
    expect(book.deposits.map((d) => d.date)).toEqual(['2024-01-05', serialToIso(45460), serialToIso(45677), '2026-01-10']);
    expect(book.deposits[0].amounts).toEqual([9_000_000, 0, 1_000_000, 0]);
    expect(book.deposits[2].amounts).toEqual([-3_000_000, 3_000_000, 0, 0]); // 계좌 간 이체
  });

  it('투자내역은 쓰지 않는다 (보유 종목 없음)', () => {
    const m = makeExcelModel(book, '2026-01-20');
    expect(m.positions([])).toEqual([]);
    expect(m.deposits?.rows).toHaveLength(4);
    expect('lots' in book).toBe(false);
  });

  it('날짜 표기', () => {
    expect(toDate('~23 / 2 / 9')).toBe('2023-02-09');
    expect(toDate('2025.3.7')).toBe('2025-03-07');
    expect(toDate(45099)).toBe('2023-06-22');
    expect(toDate('메모')).toBeUndefined();
  });

  it('연초대비 수익률은 엑셀 수식과 같다', () => {
    const m = makeExcelModel(book, '2026-01-20');
    const rows = yearlyReturns(m.snapshots([]), m.yearStarts, m.asOf);
    const y2024 = rows.find((r) => r.year === 2024)!;
    // (1500 − 1000 − 400) / (1000 + 400)
    expect(y2024.returnRate).toBeCloseTo(100 / 1400, 10);
    const y2025 = rows.find((r) => r.year === 2025)!;
    // 연말 = 2025-12 기말자산 2100 (다음 해 연초값 없음)
    expect(y2025.end).toBe(21_000_000);
    expect(y2025.returnRate).toBeCloseTo((2100 - 1500 - 500) / 2000, 10);
    // 월별: 1월 = 1900 / (1500 + 300) − 1
    expect(y2025.months[0]).toMatchObject({ month: 1 });
    expect(y2025.months[0].ytd).toBeCloseTo(1900 / 1800 - 1, 10);
    const y2026 = rows.find((r) => r.year === 2026)!;
    expect(y2026.inProgress).toBe(true);
    expect(y2026.start).toBe(21_000_000);
    expect(y2026.returnRate).toBeCloseTo(2400 / 2300 - 1, 10);
  });

  it('Summary 시트가 없으면 알기 쉬운 오류', () => {
    expect(() => parseStockBook({ Sheet1: {} })).toThrow("'Summary' 시트");
  });
});

describe('xlsx 읽기', () => {
  // 브라우저의 DOMParser 대신 jsdom 것을 빌려 쓴다 (나머지는 Node 환경 그대로)
  globalThis.DOMParser = new JSDOM().window.DOMParser as unknown as typeof DOMParser;
  it('공유 문자열 · 숫자 · 인라인 문자열 · 수식 캐시값을 읽는다', () => {
    const files = {
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
      'xl/workbook.xml': strToU8(
        '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="요약" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/sharedStrings.xml': strToU8('<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>배당주</t></si><si><r><t>미국</t></r><r><t>배당</t></r></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8(
        '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>1234.5</v></c><c r="C1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>메모</t></is></c><c r="B2"><f>B1*2</f><v>2469</v></c><c r="C2"/></row>' +
          '</sheetData></worksheet>',
      ),
    };
    const wb = readWorkbook(zipSync(files));
    expect(wb).toEqual({ 요약: { A1: '배당주', B1: 1234.5, C1: '미국배당', A2: '메모', B2: 2469 } });
  });
});
