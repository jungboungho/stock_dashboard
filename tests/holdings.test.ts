import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import { applySync, emptyHoldings, holdingsTotal, quoteTargets, removeHolding, setCash, toPositions, upsertHolding, type HoldingRow } from '../src/data/holdings';
import { upsertSheets } from '../src/data/excel/write';
import { readWorkbook } from '../src/data/excel/xlsx';
import { parseStockBook, summaryEndCells } from '../src/data/excel/parse';
import { buildExportSheets, monthlyFromSheets, summaryLinkCells, upsertDaily } from '../src/data/excel/export';
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

describe('엑셀 업데이트 (보유종목 · 그룹 · 일별 / 월별 자산추이 시트)', () => {
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
    book.dailyLog = upsertDaily([{ date: '2026-11-01', total: 1, accounts: { ISA: 1 } }], h, 1400, '2026-11-23');
    book.watchlist = { groups: ['반도체', '빈 그룹'], items: [{ code: 'NVDA', name: '엔비디아', currency: 'USD', group: '반도체', price: 180, change: 0.01, close: 178, closeChange: -0.02 }, { code: '005930', name: '삼성전자', currency: 'KRW', group: '' }], quotedAt: null };
    const out1 = upsertSheets(src, buildExportSheets(book, groups, '2026-11-30'));
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
    expect(again.watchlist.groups).toEqual(['반도체', '빈 그룹']); // 종목 없는 그룹도 순서대로 남음
    expect(again.watchlist.items).toEqual(book.watchlist.items.map((i) => ({ price: null, change: null, close: null, closeChange: null, ...i })));
    expect(again.dailyLog.map((d) => [d.date, d.total, d.accounts['종합'] ?? null])).toEqual([
      ['2026-11-01', 1, null],
      ['2026-11-23', 220_000 + 84_000 + 14_000, 98_000],
    ]);
    expect(again.monthlyValues).toEqual({ '2026-09': 160, '2026-10': 170, '2026-11': 318_000 });

    // 두 번째 업데이트: 시트가 늘지 않고 내용만 바뀜
    book.holdings = removeHolding(h, 'ISA', '360750');
    const out2 = upsertSheets(out1, buildExportSheets(book, groups, '2026-11-30'));
    const wb2 = readWorkbook(out2);
    expect(Object.keys(wb2)).toEqual(['Summary', '입금내역', '보유종목', '그룹', '일별 자산추이', '관심종목', '배당', '월별 자산추이']);
    expect(parseStockBook(wb2).holdings.rows).toHaveLength(1);
  });

  it("예전 '자산스냅샷' 시트는 같은 자리에서 '일별 자산추이'로 바뀐다", () => {
    const old = upsertSheets(baseXlsx(), [{ name: '자산스냅샷', rows: [['기준일', '계좌', '평가금액(원)'], ['2026-11-20', 'ISA', 100], ['2026-11-20', '합계', 100]] }, { name: '설정', rows: [['중계 서버 주소', 'https://x.dev']] }]);
    const book = parseStockBook(readWorkbook(old), 'test.xlsx');
    expect(book.dailyLog).toEqual([{ date: '2026-11-20', total: 100, accounts: { ISA: 100 } }]);
    const out = upsertSheets(old, buildExportSheets(book, [], '2026-11-30'));
    expect(Object.keys(readWorkbook(out))).toEqual(['Summary', '입금내역', '일별 자산추이', '설정', '보유종목', '그룹', '관심종목', '배당', '월별 자산추이']);
  });

  it('Summary 기말자산은 일별 기록이 시작된 달부터 월별 자산추이와 수식으로 연결', () => {
    const src = baseXlsx();
    const book = parseStockBook(readWorkbook(src), 'test.xlsx');
    book.unit = 1;
    book.dailyLog = [{ date: '2026-11-20', total: 300, accounts: { ISA: 300 } }];
    const sheets = buildExportSheets(book, [], '2026-11-30');
    const target = summaryEndCells(readWorkbook(src))!;
    expect(target).toMatchObject({ sheet: 'Summary', col: 'E', rows: { '2026-09': 5, '2026-11': 7 } });
    const links = summaryLinkCells(book, target, monthlyFromSheets(sheets), '2026-11');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ ref: 'E7', value: 300 });
    expect(links[0].formula).toContain("INDEX('월별 자산추이'!$B:$B,MATCH(");
    const out = upsertSheets(src, sheets, { sheet: target.sheet, updates: links });
    const again = parseStockBook(readWorkbook(out), 'test.xlsx');
    expect(again.months.map((m) => m.endValue)).toEqual([160, 170, 300]); // 이전 달은 그대로, 11월은 연결된 값
    const xml = new TextDecoder().decode(unzipSync(out)['xl/worksheets/sheet1.xml']);
    expect(xml).toContain('<c r="E7"><f>IFERROR(INDEX(');
    expect(xml).toContain('<c r="E5"><v>160</v></c>');
  });

  it('일별 기록이 있는 달은 날짜별로, 원금은 그달 입금내역을 날짜까지 더한다', () => {
    const book = parseStockBook(readWorkbook(baseXlsx()), 'test.xlsx');
    book.dailyLog = [
      { date: '2026-11-01', total: 172, accounts: {} },
      { date: '2026-11-05', total: 190, accounts: {} },
    ];
    const s = excelSnapshots(book, '2026-11-30');
    expect(s.map((x) => [x.date, x.value, x.principal, x.netFlow])).toEqual([
      ['2026-09-30', 160, 150, 150],
      ['2026-10-31', 170, 150, 0],
      ['2026-11-01', 172, 150, 0],
      ['2026-11-05', 190, 160, 10], // 11-02 입금 10
    ]);
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
      Output_0: { fc_dca: 112.5, fc_ny_stl_xcl_amt: -100 }, // 결제 전 매수 대금 100달러
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
        // 국내 현재가 · 등락률: 최근 2일 종가 (현재가 시세의 등락률은 부호가 없어서 쓰지 않음)
        '/krstock/quote/v1/currentDaily': { rsp_msg: '조회가 완료되었습니다.', Output_0: [{ bsop_date: '26/11/24', stck_clpr: 23680 }, { bsop_date: '26/11/23', stck_clpr: 24000 }] },
        '/gbstock/quote/v1/current': { rsp_msg: '조회완료', Output_0: { iem_cd: body.iem_cd, trdprc: 81, pctchng: -0.16 } },
        // 미국 종가: 일별 정규장 종가 (최신 먼저)
        '/gbstock/quote/v1/period': { rsp_msg: '조회완료', Output_1: [{ trade_date: '20261120', close_prc: '80.00' }, { trade_date: '20261119', close_prc: '78.00' }] },
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
    expect(res.prices).toEqual({ '360750': 23680 }); // NH 계좌 종목(TLT)은 잔고 값을 쓰므로 현재가는 안 돌려줌
    expect(res.changes['360750']).toBeCloseTo(23680 / 24000 - 1, 10); // 내린 날도 음수로
    expect(res.changes.TLT).toBeCloseTo(-0.0016, 10);
    expect(res.closes.TLT).toMatchObject({ close: 80, date: '20261120' });
    expect(res.closes.TLT.change).toBeCloseTo(80 / 78 - 1, 10);
    expect(res.usdKrw).toBe(1337);
    expect(res.warnings[0]).toContain('금계좌');
  });
});

describe('NH 토큰 무효 응답', () => {
  it('HTTP 400 + IGW40043 이면 토큰을 한 번 새로 받아 다시 부른다', async () => {
    const calls: string[] = [];
    let issued = 0;
    const fake = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === '/oauth2/token') {
        issued += 1;
        return new Response(JSON.stringify({ access_token: 'new', expires_in: 86400 }), { status: 200 });
      }
      const auth = new Headers(init?.headers).get('Authorization');
      if (auth !== 'Bearer new') return new Response(JSON.stringify({ rsp_cd: 'IGW40043', rsp_msg: '유효하지 않은 token 입니다.' }), { status: 400 });
      return new Response(JSON.stringify({ rsp_msg: '조회가 완료되었습니다.', Output_0: [] }), { status: 200 });
    }) as typeof fetch;
    let saved: unknown = null;
    const tokens: TokenStore = { get: async () => ({ access_token: 'old', expires_at: Date.now() / 1000 + 3600 }), set: async (t) => void (saved = t) };
    const res = await buildSync({ appKey: 'k', appSecret: 's', accounts: '', tokens, fetch: fake, intervalMs: 0 }, []);
    expect(issued).toBe(1);
    expect(calls).toEqual(['/n2/acctinfo', '/oauth2/token', '/n2/acctinfo']);
    expect(saved).toMatchObject({ access_token: 'new' });
    expect(res.accounts).toEqual([]);
  });
});

describe('계좌별 자산 추이', () => {
  it('고른 계좌의 일별 평가금 합 · 입금내역 원금 · 수익률', async () => {
    const { excelAccountSnapshots } = await import('../src/data/excelModel');
    const book = parseStockBook(readWorkbook(baseXlsx()), 'test.xlsx');
    book.dailyLog = [
      { date: '2026-11-01', total: 300, accounts: { 종합: 120, ISA: 60, 연금1: 120 } },
      { date: '2026-11-05', total: 330, accounts: { 종합: 140, ISA: 70, 연금1: 120 } },
    ];
    const s = excelAccountSnapshots(book, ['종합', 'ISA'], '2026-11-30');
    // 원금: 입금내역 종합 100(9/1) + 10(11/2), ISA 50(9/1)
    expect(s.map((x) => [x.date, x.value, x.principal, x.netFlow])).toEqual([
      ['2026-11-01', 180, 150, 150],
      ['2026-11-05', 210, 160, 10],
    ]);
    expect(s[1].twr).toBeCloseTo(210 / (180 + 10) - 1, 10);
    expect(excelAccountSnapshots(book, ['IRP'], '2026-11-30')).toEqual([]); // 기록 없는 계좌
  });
});

describe('등락률', () => {
  it('동기화하면 모든 종목(API 계좌 · 직접 계좌)에 전일 대비 등락률이 붙는다', () => {
    let h = upsertHolding(emptyHoldings(), row({}));
    h = upsertHolding(h, row({ account: '연금1', code: '458730', name: 'TIGER 미국배당다우존스', quantity: 3 }));
    const next = applySync(h, {
      asOf: '2026-11-24T05:00:00Z',
      usdKrw: 1350,
      accounts: [{ name: '종합', rows: [row({ account: '종합', code: 'TLT', name: 'TLT', currency: 'USD', quantity: 1, avgPrice: 80, price: 81 })], cash: [] }],
      prices: { '360750': 24140 },
      changes: { '360750': 0.0235, TLT: -0.0016 },
      warnings: [],
    });
    const by = Object.fromEntries(next.rows.map((r) => [`${r.account}:${r.code}`, r.change ?? null]));
    expect(by).toEqual({ 'ISA:360750': 0.0235, '연금1:458730': null, '종합:TLT': -0.0016 });
    expect(toPositions(next, 1350).find((p) => p.key === 'TLT')?.change).toBe(-0.0016);
  });
});
