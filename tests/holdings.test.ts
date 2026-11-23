import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import { applySync, emptyHoldings, holdingsTotal, quoteTargets, removeHolding, setCash, toPositions, upsertHolding, type HoldingRow } from '../src/data/holdings';
import { upsertSheets } from '../src/data/excel/write';
import { readWorkbook } from '../src/data/excel/xlsx';
import { parseStockBook } from '../src/data/excel/parse';
import { buildExportSheets, nextSnapshotLog } from '../src/data/excel/export';
import { excelSnapshots } from '../src/data/excelModel';
import { buildSync, mapGbStock, type TokenStore } from '../proxy/src/nh';

globalThis.DOMParser = new JSDOM().window.DOMParser as unknown as typeof DOMParser;

// 금액 · 종목은 모두 가상 값
const row = (o: Partial<HoldingRow>): HoldingRow => ({ account: 'ISA', code: '360750', name: 'TIGER 미국S&P500', currency: 'KRW', quantity: 10, avgPrice: 20000, price: 22000, ...o });

describe('계좌별 보유 종목', () => {
  it('추가 · 같은 계좌 중복 막기 · 수정 · 삭제', () => {
    let h = upsertHolding(emptyHoldings(), row({}));
    h = upsertHolding(h, row({ account: '연금1' })); // 다른 계좌는 같은 종목 가능
    expect(() => upsertHolding(h, row({ quantity: 5 }))).toThrow('이미 있습니다');
    h = upsertHolding(h, row({ quantity: 12 }), { account: 'ISA', key: '360750' });
    expect(h.rows.find((r) => r.account === 'ISA')!.quantity).toBe(12);
    h = removeHolding(h, '연금1', '360750');
    expect(h.rows).toHaveLength(1);
    expect(() => upsertHolding(h, row({ account: 'IRP', quantity: 0 }))).toThrow('수량');
  });

  it('매입금액이 있으면 원가로 쓰고, 달러 종목은 환율로 환산', () => {
    let h = upsertHolding(emptyHoldings(), row({ costKRW: 150_000 }));
    h = upsertHolding(h, row({ account: '종합', code: 'SCHD', name: 'SCHD', currency: 'USD', quantity: 2, avgPrice: 25, price: 30, costKRW: null }));
    h = setCash(h, 'ISA', 'KRW', 1000);
    h = setCash(h, '종합', 'USD', 10);
    const [isa, schd] = toPositions(h, 1400);
    expect(isa).toMatchObject({ key: '360750', costKRW: 150_000, valueKRW: 220_000, accountId: 'ISA' });
    expect(schd).toMatchObject({ key: 'SCHD', costKRW: 70_000, valueKRW: 84_000 });
    expect(holdingsTotal(h, 1400)).toBe(220_000 + 84_000 + 1000 + 14_000);
  });

  it('동기화: API 계좌는 통째로 바꾸고, 나머지는 현재가만 바꾼다', () => {
    let h = upsertHolding(emptyHoldings(), row({}));
    h = upsertHolding(h, row({ account: '종합', code: 'TSLA', name: '테슬라', currency: 'USD', quantity: 1, avgPrice: 100, price: 100 }));
    expect(quoteTargets(h, ['종합'])).toEqual([{ code: '360750', currency: 'KRW' }]);
    const next = applySync(h, {
      asOf: '2026-11-23T05:00:00Z',
      usdKrw: 1350,
      accounts: [{ name: '종합', rows: [row({ account: '종합', code: 'SCHD', name: 'SCHD', currency: 'USD', quantity: 3, avgPrice: 27, price: 34 })], cash: [{ account: '종합', currency: 'KRW', amount: 500 }] }],
      prices: { '360750': 23_000 },
      warnings: [],
    });
    expect(next.rows.map((r) => `${r.account}:${r.code}:${r.price}`).sort()).toEqual(['ISA:360750:23000', '종합:SCHD:34']);
    expect(next.cash).toEqual([{ account: '종합', currency: 'KRW', amount: 500 }]);
    expect(next).toMatchObject({ usdKrw: 1350, syncedAccounts: ['종합'], asOf: '2026-11-23T05:00:00Z' });
  });
});

// 작은 엑셀 파일: Summary · 입금내역 시트만 있는 상태에서 시작
function baseXlsx(): Uint8Array {
  const empty = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
  });
  return upsertSheets(empty, [
    {
      name: 'Summary',
      rows: [
        ['종합', 100],
        ['ISA', 50],
        [],
        ['날짜', '종합', 'ISA', '월투자금', '기말자산'],
        ['2026-09', 100, 50, null, 160],
        ['2026-10', 0, 0, null, 170],
        ['2026-11', 10, 0, null, 175],
      ],
    },
    { name: '입금내역', rows: [['날짜', '종합', 'ISA'], ['2026-09-01', 100, 50], ['2026-11-02', 10, null]] },
  ]);
}

describe('엑셀 업데이트 (보유종목 · 그룹 · 자산스냅샷 시트)', () => {
  it('시트를 추가하고, 다시 쓰면 같은 시트를 바꾼다 (다른 시트는 유지)', () => {
    const src = baseXlsx();
    const book = parseStockBook(readWorkbook(src), 'test.xlsx');
    expect(book.holdings.rows).toEqual([]);

    let h = upsertHolding(emptyHoldings(), row({ costKRW: 180_000 }));
    h = upsertHolding(h, row({ account: '종합', code: 'SCHD', name: 'SCHD', currency: 'USD', quantity: 2, avgPrice: 25, price: 30, costKRW: 66_000 }));
    h = setCash(h, '종합', 'USD', 10);
    h = { ...h, asOf: '2026-11-23T10:00:00', usdKrw: 1400 };
    book.holdings = h;
    const groups = [{ name: '배당주', keys: ['SCHD'] }, { name: '채권', keys: [] }];
    const log = nextSnapshotLog([{ date: '2026-11-01', account: '합계', value: 1 }], h, 1400, '2026-11-23');
    const out1 = upsertSheets(src, buildExportSheets(book, groups, log));
    const again = parseStockBook(readWorkbook(out1), 'test.xlsx');
    expect(again.months).toEqual(book.months); // Summary 그대로
    expect(again.deposits).toEqual(book.deposits);
    expect(again.holdings.rows.map((r) => [r.account, r.code, r.quantity, r.price, r.costKRW]).sort()).toEqual([
      ['ISA', '360750', 10, 22000, 180000],
      ['종합', 'SCHD', 2, 30, 66000],
    ]);
    expect(again.holdings.cash).toEqual([{ account: '종합', currency: 'USD', amount: 10 }]);
    expect(again.holdings.usdKrw).toBe(1400);
    expect(again.holdings.asOf?.slice(0, 10)).toBe('2026-11-23');
    expect(again.groups).toEqual(groups);
    expect(again.snapshotLog.map((r) => r.account).sort()).toEqual(['ISA', '종합', '합계', '합계'].sort());

    // 두 번째 업데이트: 시트가 늘지 않고 내용만 바뀜
    book.holdings = removeHolding(h, 'ISA', '360750');
    const out2 = upsertSheets(out1, buildExportSheets(book, groups, log));
    const wb2 = readWorkbook(out2);
    expect(Object.keys(wb2)).toEqual(['Summary', '입금내역', '보유종목', '그룹', '자산스냅샷']);
    expect(parseStockBook(wb2).holdings.rows).toHaveLength(1);
  });

  it('보유종목이 있으면 그 합계가 이번 달 값이 된다', () => {
    const book = parseStockBook(readWorkbook(baseXlsx()), 'test.xlsx');
    book.holdings = { ...setCash(upsertHolding(emptyHoldings(), row({ quantity: 100, price: 20_000 })), 'ISA', 'KRW', 50_000), asOf: '2026-11-23T10:00:00' };
    const s = excelSnapshots(book, '2026-11-30');
    expect(s.map((x) => x.date)).toEqual(['2026-09-30', '2026-10-31', '2026-11-23']);
    expect(s.at(-1)).toMatchObject({ value: 2_050_000, principal: 160, netFlow: 10 }); // 단위 없음 → 원 그대로
  });
});

describe('NH 중계 서버 응답 변환', () => {
  it('해외주식 잔고 → 종목 · 달러 예수금 · 환율', () => {
    const r = mapGbStock('종합', {
      Output_0: { fc_dca: 12.5 },
      Output_1: [{ iem_cd: 'schd', iem_nm: '슈왑 미국 배당주 ETF', cns_bse_bnc_qty: 4, fc_abk_amt: 100, fc_sec_end_pr: 30, krw_abk_amt1: 140000, cur_cd: 'USD', tdt_sby_bse_xcg_rt: 1350 }],
    });
    expect(r).toEqual({
      rows: [{ account: '종합', code: 'SCHD', name: '슈왑 미국 배당주 ETF', currency: 'USD', quantity: 4, avgPrice: 25, price: 30, costKRW: 140000 }],
      cashUsd: 12.5,
      usdKrw: 1350,
    });
  });

  it('토큰은 캐시를 쓰고, 계좌 끝자리로 찾고, 주문 API 는 부르지 않는다', async () => {
    const calls: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(path);
      const body = JSON.parse(String(init?.body ?? '{}')).Input_0 ?? {};
      const reply: Record<string, unknown> = {
        '/n2/acctinfo': { rsp_msg: '조회가 완료되었습니다.', Output_0: [{ acct_no: '11100001234', acct_type: '01' }, { acct_no: '99900000000', acct_type: '03' }] },
        '/krstock/inquiry/v1/balance': { rsp_msg: '조회가 완료되었습니다.', Output_0: { dca: 1000 } },
        '/gbstock/inquiry/v1/balance': { rsp_msg: '조회가 완료되었습니다.', Output_0: { fc_dca: 3 }, Output_1: [{ iem_cd: 'TLT', iem_nm: 'TLT', cns_bse_bnc_qty: 1, fc_abk_amt: 80, fc_sec_end_pr: 81, krw_abk_amt1: 110000, tdt_sby_bse_xcg_rt: 1337 }] },
        '/krgold/inquiry/v1/goldDepositAndBalance': { rsp_msg: '조회가 완료되었습니다.', Output_0: { dca: 1000 } },
        '/krstock/quote/v1/currentPrice': { rsp_msg: '조회가 완료되었습니다.', Output_0: { iem_cd: body.iem_cd, stck_prpr: 23680 } },
      };
      return new Response(JSON.stringify(reply[path] ?? {}), { status: 200 });
    }) as typeof fetch;
    const tokens: TokenStore = { get: async () => ({ access_token: 't', expires_at: Date.now() / 1000 + 3600 }), set: async () => {} };
    const res = await buildSync({ appKey: 'k', appSecret: 's', accounts: '1234:종합,5678:금계좌', tokens, fetch: fake, intervalMs: 0 }, [{ code: '360750', currency: 'KRW' }]);
    expect(calls).not.toContain('/oauth2/token');
    expect(calls.every((c) => !c.includes('order'))).toBe(true);
    expect(res.accounts).toHaveLength(1);
    expect(res.accounts[0].rows[0]).toMatchObject({ code: 'TLT', quantity: 1, price: 81 });
    expect(res.accounts[0].cash).toEqual([{ account: '종합', currency: 'KRW', amount: 1000 }, { account: '종합', currency: 'USD', amount: 3 }]);
    expect(res.prices).toEqual({ '360750': 23680 });
    expect(res.usdKrw).toBe(1337);
    expect(res.warnings[0]).toContain('금계좌');
  });
});
