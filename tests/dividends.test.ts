import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import { NhClient, mapDividends, type TokenStore } from '../proxy/src/nh';
import { dividendsFrom, mergeApiDividends, resolveCode, toTransactions, type DividendEntry } from '../src/data/dividends';
import { emptyHoldings } from '../src/data/holdings';
import { upsertSheets } from '../src/data/excel/write';
import { readWorkbook } from '../src/data/excel/xlsx';
import { parseStockBook } from '../src/data/excel/parse';
import { buildExportSheets } from '../src/data/excel/export';
import { makeExcelModel } from '../src/data/excelModel';

globalThis.DOMParser = new JSDOM().window.DOMParser as unknown as typeof DOMParser;

// 금액은 모두 가상 값
describe('NH 종합거래내역 → 배당', () => {
  it("적요에 '배당' · '분배'가 든 입금만, 보유 종목이면 티커로", () => {
    const rows = mapDividends(
      '종합',
      [
        { trd_dt: '20260630', sps_cd_krl_anm: '외화배당금입금', iem_cd: 'US8085247976', iem_nm: '슈왑 미국 배당주 ETF', cur_cd: 'USD', trd_amt: 10.5 },
        { trd_dt: '20260929', sps_cd_krl_anm: '소수점해외배당금', iem_cd: 'US8085247976', iem_nm: '슈왑 미국 배당주 ETF', cur_cd: 'USD', trd_amt: 0.12 },
        { trd_dt: '20260415', sps_cd_krl_anm: '배당금입금', iem_cd: 'KR7360750004', iem_nm: 'TIGER 미국S&P500', cur_cd: 'KRW', trd_amt: 1200 },
        { trd_dt: '20260601', sps_cd_krl_anm: '외화증권매수', iem_cd: 'US1', iem_nm: 'X', cur_cd: 'USD', trd_amt: 100 },
        { trd_dt: '20260602', sps_cd_krl_anm: '외화제세금환급', iem_cd: '', iem_nm: '', cur_cd: 'USD', trd_amt: 3 },
      ],
      new Map([['슈왑 미국 배당주 ETF', 'SCHD']]),
    );
    expect(rows).toEqual([
      { date: '2026-06-30', account: '종합', code: 'SCHD', name: '슈왑 미국 배당주 ETF', currency: 'USD', amount: 10.5 },
      { date: '2026-09-29', account: '종합', code: 'SCHD', name: '슈왑 미국 배당주 ETF', currency: 'USD', amount: 0.12 },
      { date: '2026-04-15', account: '종합', code: 'KR7360750004', name: 'TIGER 미국S&P500', currency: 'KRW', amount: 1200 },
    ]);
  });

  it('연속조회: 헤더 cts 를 실어 끝까지 받고, 같은 cts 면 멈춘다', async () => {
    const seen: (string | null)[] = [];
    const fake = (async (_url: string, init?: RequestInit) => {
      const cts = new Headers(init?.headers).get('cts');
      seen.push(cts);
      const page = cts === null ? 1 : cts === 'p2' ? 2 : 3;
      const headers = page < 3 ? { cts: `p${page + 1}`, cts_flag: 'Y' } : { cts: 'p3', cts_flag: 'N' };
      return new Response(JSON.stringify({ rsp_msg: '조회가 완료되었습니다.', Output_0: [{ n: page }] }), { status: 200, headers });
    }) as typeof fetch;
    const tokens: TokenStore = { get: async () => ({ access_token: 't', expires_at: Date.now() / 1000 + 3600 }), set: async () => {} };
    const nh = new NhClient({ appKey: 'k', appSecret: 's', accounts: '', tokens, fetch: fake, intervalMs: 0 });
    const rows = await nh.callAll('/common/inquiry/v1/totalTransaction', {});
    expect(rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(seen).toEqual([null, 'p2', 'p3']);
  });
});

const entry = (o: Partial<DividendEntry>): DividendEntry => ({ date: '2026-06-30', account: '종합', code: 'SCHD', name: 'SCHD', currency: 'USD', amount: 10, krw: 13_000, source: 'API', ...o });

describe('배당 기록 합치기', () => {
  it('받은 계좌 · 기간의 API 기록만 바꾸고, 직접 적은 기록 · 원화 환산은 유지', () => {
    const existing = [
      entry({ date: '2026-03-31', amount: 9, krw: 12_000 }), // 기간 밖 → 유지
      entry({ date: '2026-06-30', amount: 10, krw: 13_000 }), // 기간 안 · 다시 옴 → 원화값 유지
      entry({ date: '2026-07-15', account: 'ISA', code: '458730', name: 'TIGER 미국배당다우존스', currency: 'KRW', amount: 5000, krw: 5000, source: '직접' }),
    ];
    const incoming = [
      { date: '2026-06-30', account: '종합', code: 'SCHD', name: 'SCHD', currency: 'USD' as const, amount: 10 },
      { date: '2026-09-29', account: '종합', code: 'SCHD', name: 'SCHD', currency: 'USD' as const, amount: 11 },
    ];
    const { rows, added } = mergeApiDividends(existing, incoming, ['종합'], '2026-06-01', 1400);
    expect(added).toBe(1);
    expect(rows.map((r) => [r.date, r.account, r.amount, r.krw, r.source])).toEqual([
      ['2026-03-31', '종합', 9, 12_000, 'API'],
      ['2026-06-30', '종합', 10, 13_000, 'API'],
      ['2026-07-15', 'ISA', 5000, 5000, '직접'],
      ['2026-09-29', '종합', 11, 15_400, 'API'],
    ]);
  });

  it('다음에 받을 시작일 · ISIN 을 티커로 · 배당 거래로', () => {
    expect(dividendsFrom([], new Date('2026-11-23T00:00:00Z'))).toBe('2024-11-23');
    expect(dividendsFrom([entry({ date: '2026-09-29' })])).toBe('2026-09-15');
    const h = emptyHoldings();
    h.rows = [{ account: '종합', code: 'TLT', name: '아이셰어즈 20+년 미국 국채 ETF', currency: 'USD', quantity: 1, avgPrice: 1, price: 1 }];
    const d = (name: string) => ({ date: '2026-06-01', account: '종합', code: 'US4642874329', name, currency: 'USD' as const, amount: 1 });
    expect(resolveCode(d('아이셰어즈 20+년 미국 국채 ETF'), h, [])).toBe('TLT');
    expect(resolveCode(d('아이셰어즈 0-3개월 미국 국채 ETF'), h, [{ code: 'SGOV', name: '아이셰어즈 0-3개월 미국 국채 ETF', market: 'US' }])).toBe('SGOV');
    expect(resolveCode(d('모름'), h, [])).toBe('US4642874329');
    expect(toTransactions([entry({})])[0]).toMatchObject({ type: 'DIVIDEND', code: 'SCHD', amountKRW: 13_000 });
  });
});

describe("엑셀 '배당' 시트", () => {
  it('읽기(출처가 비면 직접) · 쓰기 · 배당 섹션 켜짐', () => {
    const empty = zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'),
      'xl/workbook.xml': strToU8('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
    });
    const src = upsertSheets(empty, [
      { name: 'Summary', rows: [['종합', 100], [], ['날짜', '종합', '기말자산'], ['2026-10', 100, 120]] },
      { name: '배당', rows: [['날짜', '계좌', '종목코드', '종목명', '통화', '금액', '원화금액', '출처'], ['2026-07-15', 'ISA', '458730', 'TIGER 미국배당다우존스', 'KRW', 5000, null, null]] },
    ]);
    const book = parseStockBook(readWorkbook(src), 't.xlsx');
    expect(book.dividends).toEqual([{ date: '2026-07-15', account: 'ISA', code: '458730', name: 'TIGER 미국배당다우존스', currency: 'KRW', amount: 5000, krw: 5000, source: '직접' }]);
    expect(makeExcelModel(book, '2026-11-30').hasDividends).toBe(true);
    book.dividends.push(entry({ date: '2026-09-29' }));
    const again = parseStockBook(readWorkbook(upsertSheets(src, buildExportSheets(book, [], '2026-11-30'))), 't.xlsx');
    expect(again.dividends.map((d) => [d.date, d.account, d.krw, d.source])).toEqual([
      ['2026-07-15', 'ISA', 5000, '직접'],
      ['2026-09-29', '종합', 13_000, 'API'],
    ]);
  });
});
