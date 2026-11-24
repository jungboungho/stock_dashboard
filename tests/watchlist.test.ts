import { describe, expect, it } from 'vitest';
import {
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
import { marketClock, pickClose } from '../proxy/src/nh';

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
