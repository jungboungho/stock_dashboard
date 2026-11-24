import { describe, expect, it } from 'vitest';
import {
  addMarketItems,
  DISCOVER_GROUP,
  MARKET_ITEMS,
  marketKind,
  missingMarketItems,
  addWatchGroup,
  addWatchItem,
  applyWatchQuotes,
  deleteWatchGroup,
  emptyWatchlist,
  moveWatchItem,
  removeWatchItem,
  renameWatchGroup,
  WATCH_UNGROUPED,
  watchItemsIn,
  watchQuoteTargets,
} from '../src/data/watchlist';
import { marketClock, NhClient, pickClose, quoteMarket, signedPct } from '../proxy/src/nh';
import { parseWatchlist } from '../src/data/excel/parse';

const sample = () => {
  let w = addWatchGroup(addWatchGroup(emptyWatchlist(), '반도체'), '빅테크');
  w = addWatchItem(w, { code: '005930', name: '삼성전자', currency: 'KRW' }, '반도체');
  w = addWatchItem(w, { code: 'NVDA', name: '엔비디아', currency: 'USD' }, '반도체');
  w = addWatchItem(w, { code: 'NVDA', name: '엔비디아', currency: 'USD' }, '빅테크');
  w = addWatchItem(w, { code: 'SCHD', name: 'SCHD', currency: 'USD' }, WATCH_UNGROUPED);
  return w;
};

describe('관심 종목', () => {
  it('그룹별 · 여러 그룹 · 전체로 본다', () => {
    const w = sample();
    expect(watchItemsIn(w, []).map((i) => i.code)).toEqual(['005930', 'NVDA', 'NVDA', 'SCHD']);
    expect(watchItemsIn(w, ['빅테크']).map((i) => i.code)).toEqual(['NVDA']);
    expect(watchItemsIn(w, ['빅테크', WATCH_UNGROUPED]).map((i) => i.code)).toEqual(['NVDA', 'SCHD']);
    expect(watchQuoteTargets(w)).toEqual([
      { code: '005930', currency: 'KRW' },
      { code: 'NVDA', currency: 'USD' },
      { code: 'SCHD', currency: 'USD' },
    ]);
  });

  it('같은 그룹에 두 번 · 없는 그룹 · 미분류 이름은 막는다', () => {
    const w = sample();
    expect(() => addWatchItem(w, { code: 'NVDA', name: '엔비디아', currency: 'USD' }, '빅테크')).toThrow('이미');
    expect(() => addWatchItem(w, { code: 'AAPL', name: '애플', currency: 'USD' }, '없음')).toThrow('없는 그룹');
    expect(() => addWatchGroup(w, WATCH_UNGROUPED)).toThrow();
    expect(() => addWatchGroup(w, ' 반도체 ')).toThrow('이미');
  });

  it('이름 바꾸기 · 옮기기 · 빼기 · 그룹 지우기(종목은 미분류로, 겹치면 하나로)', () => {
    let w = renameWatchGroup(sample(), '빅테크', '미국 빅테크');
    expect(w.groups).toEqual(['반도체', '미국 빅테크']);
    expect(watchItemsIn(w, ['미국 빅테크']).map((i) => i.code)).toEqual(['NVDA']);
    w = moveWatchItem(w, 'SCHD', '', '미국 빅테크');
    expect(watchItemsIn(w, [WATCH_UNGROUPED])).toEqual([]);
    w = moveWatchItem(w, 'NVDA', '반도체', '미국 빅테크'); // 이미 거기 있으면 하나만 남김
    expect(w.items.filter((i) => i.code === 'NVDA')).toHaveLength(1);
    w = removeWatchItem(w, 'SCHD', '미국 빅테크');
    w = deleteWatchGroup(w, '미국 빅테크');
    expect(w.groups).toEqual(['반도체']);
    expect(watchItemsIn(w, [WATCH_UNGROUPED]).map((i) => i.code)).toEqual(['NVDA']);
  });

  it('동기화 시세를 넣는다 (받지 못한 종목은 예전 값 유지)', () => {
    const w = applyWatchQuotes(sample(), {
      asOf: '2026-11-24T08:00:00Z',
      prices: { NVDA: 180, '005930': 70000 },
      changes: { NVDA: 0.01 },
      closes: { NVDA: { close: 178, date: '20261121', change: -0.02 } },
    });
    expect(w.quotedAt).toBe('2026-11-24T08:00:00Z');
    expect(w.items[1]).toMatchObject({ price: 180, change: 0.01, close: 178, closeChange: -0.02 });
    expect(w.items[0]).toMatchObject({ price: 70000, change: null, close: null });
    const again = applyWatchQuotes(w, { asOf: 'x', prices: {}, changes: {}, closes: {} });
    expect(again.items[1]).toMatchObject({ price: 180, close: 178, closeChange: -0.02 });
  });

});

describe('종가 고르기', () => {
  const days = [
    { date: '20261124', close: 105 },
    { date: '20261121', close: 100 },
    { date: '20261120', close: 80 },
  ];
  it('장중이면 오늘 줄은 진행 중 값이라 건너뛴다', () => {
    const clock = marketClock(new Date('2026-11-24T02:00:00Z'), 'Asia/Seoul'); // 서울 11:00 (화)
    expect(clock).toEqual({ date: '20261124', minutes: 660, weekday: 2 });
    const r = pickClose(days, clock, 540, 930);
    expect(r.close).toBe(100);
    expect(r.closeChange).toBeCloseTo(100 / 80 - 1, 10);
  });
  it('장이 끝났으면 오늘 종가', () => {
    const clock = marketClock(new Date('2026-11-24T07:00:00Z'), 'Asia/Seoul'); // 서울 16:00
    const r = pickClose(days, clock, 540, 930);
    expect(r).toMatchObject({ close: 105, closeDate: '20261124' });
    expect(r.closeChange).toBeCloseTo(0.05, 10);
  });
  it('뉴욕 시간으로 판단한다', () => {
    const clock = marketClock(new Date('2026-11-24T15:00:00Z'), 'America/New_York'); // 뉴욕 10:00
    expect(clock.minutes).toBe(600);
    expect(pickClose(days, clock, 570, 960).close).toBe(100);
  });
});

describe('시장 지표 (발견 그룹)', () => {
  it('발견 그룹을 맨 앞에 만들고, 빠진 지표만 채운다', () => {
    let w = addWatchGroup(emptyWatchlist(), '반도체');
    w = addWatchItem(w, { code: '005930', name: '삼성전자', currency: 'KRW' }, '반도체');
    w = addMarketItems(w);
    expect(w.groups).toEqual([DISCOVER_GROUP, '반도체']);
    expect(w.items.slice(0, MARKET_ITEMS.length).map((i) => i.code)).toEqual(MARKET_ITEMS.map((m) => m.code));
    expect(missingMarketItems(w)).toBe(0);
    w = removeWatchItem(w, 'GOLD:KRX', DISCOVER_GROUP);
    expect(missingMarketItems(w)).toBe(1);
    expect(addMarketItems(w).items.filter((i) => i.group === DISCOVER_GROUP)).toHaveLength(MARKET_ITEMS.length);
    expect(marketKind('IDX:SPX')).toBe('index');
    expect(marketKind('SOXX')).toBeNull();
  });

  it("엑셀에 '관심종목' 시트가 없으면 발견 그룹으로 시작", () => {
    const w = parseWatchlist({} as never);
    expect(w.groups).toEqual([DISCOVER_GROUP]);
    expect(w.items).toHaveLength(MARKET_ITEMS.length);
  });
});

describe('중계 서버: 지수 · 환율 · 금 시세', () => {
  const nhFake = (reply: (path: string, body: Record<string, string>) => unknown) =>
    new NhClient({
      appKey: 'k',
      appSecret: 's',
      accounts: '',
      intervalMs: 0,
      tokens: { get: async () => ({ access_token: 't', expires_at: Date.now() / 1000 + 3600 }), set: async () => {} },
      fetch: (async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')).Input_0 ?? {};
        return new Response(JSON.stringify(reply(new URL(url).pathname, body)), { status: 200 });
      }) as typeof fetch,
    });
  const after = new Date('2026-11-24T08:30:00Z'); // 서울 17:30 (화), 뉴욕 03:30

  it('등락 부호로 부호 없는 등락률을 바로잡는다', () => {
    expect(signedPct('0.15', '5')).toBeCloseTo(-0.0015, 10);
    expect(signedPct(6.32, '2')).toBeCloseTo(0.0632, 10);
    expect(signedPct('-0.04', '')).toBeCloseTo(-0.0004, 10);
    expect(signedPct('', '2')).toBeNull();
  });

  it('미국 지수: 다우는 .DJI 로 묻고, 종가는 끝난 정규장', async () => {
    const asked: string[] = [];
    const nh = nhFake((_p, b) => {
      asked.push(b.iem_cd);
      return { rsp_msg: '조회완료', Output_0: { ovrs_prpr: '49595.31', prdy_ctrt: '3.01', prdy_vrss_sign: '2' }, Output_1: [{ bsop_date: '20261123', ovrs_prpr: '49595.31' }, { bsop_date: '20261120', ovrs_prpr: '48147.33' }] };
    });
    const q = await quoteMarket(nh, 'IDX:DJI', after);
    expect(asked).toEqual(['.DJI']);
    expect(q).toMatchObject({ price: 49595.31, close: 49595.31, closeDate: '20261123' });
    expect(q!.change).toBeCloseTo(0.0301, 10);
    expect(q!.closeChange).toBeCloseTo(49595.31 / 48147.33 - 1, 10);
  });

  it('원/엔(100엔) = 원/달러 ÷ 엔/달러 × 100, 종가는 어제 값', async () => {
    const nh = nhFake((_p, b) =>
      b.iem_cd === 'KRW'
        ? { rsp_msg: '조회완료', Output_0: { ovrs_prpr: '1342.1', prdy_ctrt: '-0.04', prdy_vrss_sign: '5' }, Output_1: [{ bsop_date: '20261124', ovrs_prpr: '1342.1' }, { bsop_date: '20261123', ovrs_prpr: '1342.6' }, { bsop_date: '20261120', ovrs_prpr: '1350' }] }
        : { rsp_msg: '조회완료', Output_0: { ovrs_prpr: '159.34', prdy_ctrt: '0.03', prdy_vrss_sign: '2' }, Output_1: [{ bsop_date: '20261124', ovrs_prpr: '159.34' }, { bsop_date: '20261123', ovrs_prpr: '159.29' }, { bsop_date: '20261120', ovrs_prpr: '160' }] },
    );
    const q = await quoteMarket(nh, 'FX:JPYKRW', after);
    expect(q!.price).toBeCloseTo((1342.1 / 159.34) * 100, 8);
    expect(q!.change).toBeCloseTo((1 - 0.0004) / (1 + 0.0003) - 1, 10);
    expect(q!.closeDate).toBe('20261123');
    expect(q!.close).toBeCloseTo((1342.6 / 159.29) * 100, 8);
    expect(q!.closeChange).toBeCloseTo(1342.6 / 159.29 / (1350 / 160) - 1, 10);
  });

  it('금: 내린 날 등락률을 음수로, 종가는 일별 추이', async () => {
    const nh = nhFake((p) =>
      p === '/krgold/quote/v1/goldCurrent'
        ? { rsp_msg: '조회완료', Output_0: { stck_prpr: 156760, prdy_ctrt: 0.15, prdy_vrss_sign: '5' } }
        : { rsp_msg: '조회완료', Output_0: [{ bsop_date: '26/11/24', stck_prpr: 156760 }, { bsop_date: '26/11/23', stck_prpr: 157000 }] },
    );
    const q = await quoteMarket(nh, 'GOLD:KRX', after);
    expect(q!.price).toBe(156760);
    expect(q!.change).toBeCloseTo(-0.0015, 10);
    expect(q).toMatchObject({ close: 156760, closeDate: '20261124' });
    expect(q!.closeChange).toBeCloseTo(156760 / 157000 - 1, 10);
  });
});
