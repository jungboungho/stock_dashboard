import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import { NhClient, buildSync, fxOn, ledgerFrom, mapDividends, mergeLedger, type DividendRow, type LedgerStore, type TokenStore } from '../proxy/src/nh';
import { applyLedger, resolveCode, toTransactions, type DividendEntry } from '../src/data/dividends';
import { emptyHoldings } from '../src/data/holdings';
import { upsertSheets } from '../src/data/excel/write';
import { readWorkbook } from '../src/data/excel/xlsx';
import { parseStockBook } from '../src/data/excel/parse';
import { buildExportSheets } from '../src/data/excel/export';
import { makeExcelModel } from '../src/data/excelModel';

globalThis.DOMParser = new JSDOM().window.DOMParser as unknown as typeof DOMParser;

// 금액 · 환율은 모두 가상 값
describe('NH 종합거래내역 → 배당', () => {
  it("적요에 '배당' · '분배'가 든 입금만, 보유 종목이면 티커로", () => {
    const rows = mapDividends(
      '종합',
      [
        { trd_dt: '20260630', sps_cd_krl_anm: '외화배당금입금', iem_cd: 'US8085247976', iem_nm: '슈왑 미국 배당주 ETF', cur_cd: 'USD', trd_amt: 10.5 },
        { trd_dt: '20260929', sps_cd_krl_anm: '소수점해외배당금', iem_cd: 'US8085247976', iem_nm: '슈왑 미국 배당주 ETF', cur_cd: 'USD', trd_amt: 0.12 },
        { trd_dt: '20260415', sps_cd_krl_anm: '배당금입금', iem_cd: '360750', iem_nm: 'TIGER 미국S&P500', cur_cd: 'KRW', trd_amt: 1200 },
        { trd_dt: '20260601', sps_cd_krl_anm: '외화증권매수', iem_cd: 'US1', iem_nm: 'X', cur_cd: 'USD', trd_amt: 100 },
        { trd_dt: '20260602', sps_cd_krl_anm: '외화제세금환급', iem_cd: '', iem_nm: '', cur_cd: 'USD', trd_amt: 3 },
      ],
      new Map([['슈왑 미국 배당주 ETF', 'SCHD']]),
    );
    expect(rows.map((r) => [r.date, r.code, r.currency, r.amount])).toEqual([
      ['2026-06-30', 'SCHD', 'USD', 10.5],
      ['2026-09-29', 'SCHD', 'USD', 0.12],
      ['2026-04-15', '360750', 'KRW', 1200],
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
    expect(await nh.callAll('/common/inquiry/v1/totalTransaction', {})).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(seen).toEqual([null, 'p2', 'p3']);
  });
});

const row = (o: Partial<DividendRow>): DividendRow => ({ date: '2026-06-30', account: '종합', code: 'SCHD', name: 'SCHD', currency: 'USD', amount: 10, fx: 1300, krw: 13_000, ...o });

describe('중계 서버 배당 장부', () => {
  it('다시 받을 시작일 = 장부 최신일 − 14일 (비어 있으면 2년 전)', () => {
    expect(ledgerFrom([], '2026-11-23')).toBe('2024-11-23');
    expect(ledgerFrom([row({ date: '2026-03-31' }), row({ date: '2026-09-29' })], '2026-11-23')).toBe('2026-09-15');
  });

  it('그날 환율, 휴일이면 직전 영업일', () => {
    const fx = new Map([['2026-06-26', 1380], ['2026-06-29', 1385]]);
    expect(fxOn('2026-06-29', fx)).toBe(1385);
    expect(fxOn('2026-06-28', fx)).toBe(1380); // 일요일 → 금요일
    expect(fxOn('2026-01-01', fx)).toBeNull();
  });

  it('합치기: 기간 밖은 그대로, 다시 온 배당은 처음 정한 환율 유지, 새 배당은 그날 환율로 고정', () => {
    const old = [row({ date: '2026-03-31', amount: 9, fx: 1450, krw: 13_050 }), row({ date: '2026-09-29', amount: 11, fx: 1350, krw: 14_850 })];
    const fresh = [
      { date: '2026-09-29', account: '종합', code: 'SCHD', name: 'SCHD', currency: 'USD' as const, amount: 11 },
      { date: '2026-10-15', account: '종합', code: 'TLT', name: 'TLT', currency: 'USD' as const, amount: 5 },
      { date: '2026-10-16', account: '종합', code: '360750', name: 'TIGER', currency: 'KRW' as const, amount: 3000 },
    ];
    const merged = mergeLedger(old, fresh, ['종합'], '2026-09-15', new Map([['2026-10-15', 1400]]), 1337);
    expect(merged.map((r) => [r.date, r.amount, r.fx, r.krw])).toEqual([
      ['2026-03-31', 9, 1450, 13_050],
      ['2026-09-29', 11, 1350, 14_850],
      ['2026-10-15', 5, 1400, 7000],
      ['2026-10-16', 3000, 1, 3000],
    ]);
  });

  it('동기화: 장부를 읽어 최신일 − 14일부터 받고, 그날 환율로 고정해 저장한 뒤 장부 전체를 돌려준다', async () => {
    let saved: string | null = JSON.stringify({ updatedAt: 'x', rows: [row({ date: '2026-09-29', amount: 11, fx: 1350, krw: 14_850 })] });
    const ledger: LedgerStore = { get: async () => saved, put: async (v) => void (saved = v) };
    const bodies: Record<string, unknown>[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const input = JSON.parse(String(init?.body ?? '{}')).Input_0 ?? {};
      bodies.push({ path, ...input });
      const reply: Record<string, unknown> = {
        '/n2/acctinfo': { rsp_msg: '조회가 완료되었습니다.', Output_0: [{ acct_no: '11100001234', acct_type: '01' }] },
        '/krstock/inquiry/v1/balance': { rsp_msg: '조회가 완료되었습니다.', Output_0: { dca: 0 } },
        '/gbstock/inquiry/v1/balance': { rsp_msg: '조회가 완료되었습니다.', Output_0: { fc_dca: 0 }, Output_1: [{ iem_cd: 'TLT', iem_nm: '아이셰어즈 TLT', cns_bse_bnc_qty: 1, fc_sec_end_pr: 80 }] },
        '/krgold/inquiry/v1/goldDepositAndBalance': { rsp_msg: '조회가 완료되었습니다.', Output_0: { dca: 0 } },
        '/common/inquiry/v1/totalTransaction': {
          rsp_msg: '조회가 완료되었습니다.',
          Output_0: [{ trd_dt: '20261015', sps_cd_krl_anm: '외화배당금입금', iem_cd: 'US4642874329', iem_nm: '아이셰어즈 TLT', cur_cd: 'USD', trd_amt: 5 }],
        },
        '/gbstock/quote/v1/symbolIndexFxPeriod': { rsp_msg: '조회가 완료되었습니다.', Output_1: [{ bsop_date: '20261015', ovrs_prpr: '1400.00' }, { bsop_date: '20260929', ovrs_prpr: '1999.00' }] },
      };
      return new Response(JSON.stringify(reply[path] ?? {}), { status: 200 });
    }) as typeof fetch;
    const tokens: TokenStore = { get: async () => ({ access_token: 't', expires_at: Date.now() / 1000 + 3600 }), set: async () => {} };
    const res = await buildSync({ appKey: 'k', appSecret: 's', accounts: '1234:종합', tokens, fetch: fake, intervalMs: 0 }, [], ledger);
    expect(res.dividendsFrom).toBe('2026-09-15');
    expect(bodies.find((b) => b.path === '/common/inquiry/v1/totalTransaction')).toMatchObject({ iqr_sta_dt: '20260915' });
    expect(bodies.find((b) => b.path === '/gbstock/quote/v1/symbolIndexFxPeriod')).toMatchObject({ iem_cd: 'KRW' });
    // 다시 받은 기간(09-15 이후)은 NH 내역이 기준: 이번 내역에 없는 09-29 기록은 빠지고, 10-15 는 그날 환율 1,400 으로 고정
    expect(res.dividends.map((r) => [r.date, r.code, r.fx, r.krw])).toEqual([['2026-10-15', 'TLT', 1400, 7000]]);
    expect(JSON.parse(saved!).rows).toHaveLength(1);
  });
});

const entry = (o: Partial<DividendEntry>): DividendEntry => ({ date: '2026-06-30', account: '종합', code: 'SCHD', name: 'SCHD', currency: 'USD', amount: 10, fx: 1300, krw: 13_000, source: 'API', ...o });

describe('대시보드: 장부 반영', () => {
  it('장부 계좌의 API 기록은 장부 그대로, 직접 적은 기록은 유지', () => {
    const existing = [
      entry({ date: '2026-03-31', amount: 9, fx: null, krw: 12_000 }), // 예전에 오늘 환율로 넣은 것 → 장부 값으로 바뀜
      entry({ date: '2026-07-15', account: 'ISA', code: '458730', name: 'TIGER 미국배당다우존스', currency: 'KRW', amount: 5000, fx: 1, krw: 5000, source: '직접' }),
    ];
    const ledger = [
      { date: '2026-03-31', account: '종합', code: 'SCHD', name: 'SCHD', currency: 'USD' as const, amount: 9, fx: 1450, krw: 13_050 },
      { date: '2026-09-29', account: '종합', code: 'SCHD', name: 'SCHD', currency: 'USD' as const, amount: 11, fx: 1350, krw: 14_850 },
    ];
    const { rows, added } = applyLedger(existing, ledger, 1337);
    expect(added).toBe(1);
    expect(rows.map((r) => [r.date, r.account, r.fx, r.krw, r.source])).toEqual([
      ['2026-03-31', '종합', 1450, 13_050, 'API'],
      ['2026-07-15', 'ISA', 1, 5000, '직접'],
      ['2026-09-29', '종합', 1350, 14_850, 'API'],
    ]);
  });

  it('ISIN 을 티커로 · 배당 거래로', () => {
    const h = emptyHoldings();
    h.rows = [{ account: '종합', code: 'TLT', name: '아이셰어즈 20+년 미국 국채 ETF', currency: 'USD', quantity: 1, avgPrice: 1, price: 1 }];
    const d = (name: string) => ({ date: '2026-06-01', account: '종합', code: 'US4642874329', name, currency: 'USD' as const, amount: 1 });
    expect(resolveCode(d('아이셰어즈 20+년 미국 국채 ETF'), h, [])).toBe('TLT');
    expect(resolveCode(d('아이셰어즈 0-3개월 미국 국채 ETF'), h, [{ code: 'SGOV', name: '아이셰어즈 0-3개월 미국 국채 ETF', market: 'US' }])).toBe('SGOV');
    expect(resolveCode(d('모름'), h, [])).toBe('US4642874329');
    expect(toTransactions([entry({})])[0]).toMatchObject({ type: 'DIVIDEND', code: 'SCHD', amountKRW: 13_000, fxRate: 1300 });
  });
});

describe("엑셀 '배당' 시트", () => {
  it('읽기(출처가 비면 직접 · 환율 칸) · 쓰기 · 배당 섹션 켜짐', () => {
    const empty = zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'),
      'xl/workbook.xml': strToU8('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
    });
    const src = upsertSheets(empty, [
      { name: 'Summary', rows: [['종합', 100], [], ['날짜', '종합', '기말자산'], ['2026-10', 100, 120]] },
      {
        name: '배당',
        rows: [
          ['날짜', '계좌', '종목코드', '종목명', '통화', '금액', '환율', '원화금액', '출처'],
          ['2026-07-15', 'ISA', '458730', 'TIGER 미국배당다우존스', 'KRW', 5000, null, null, null],
          ['2026-08-01', '연금1', 'SCHD', 'SCHD', 'USD', 2, 1400, null, null],
        ],
      },
    ]);
    const book = parseStockBook(readWorkbook(src), 't.xlsx');
    expect(book.dividends.map((d) => [d.account, d.fx, d.krw, d.source])).toEqual([
      ['ISA', 1, 5000, '직접'],
      ['연금1', 1400, 2800, '직접'],
    ]);
    expect(makeExcelModel(book, '2026-11-30').hasDividends).toBe(true);
    book.dividends.push(entry({ date: '2026-09-29' }));
    const again = parseStockBook(readWorkbook(upsertSheets(src, buildExportSheets(book, [], '2026-11-30'))), 't.xlsx');
    expect(again.dividends.map((d) => [d.date, d.account, d.fx, d.krw, d.source])).toEqual([
      ['2026-07-15', 'ISA', 1, 5000, '직접'],
      ['2026-08-01', '연금1', 1400, 2800, '직접'],
      ['2026-09-29', '종합', 1300, 13_000, 'API'],
    ]);
  });
});
