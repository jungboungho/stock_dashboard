import { describe, expect, it } from 'vitest';
import type { Position } from '../src/data/model';
import {
  addManualStock,
  applyStore,
  assignStock,
  createGroup,
  customGroupRows,
  deleteGroup,
  deleteManualStock,
  emptyStore,
  moveGroup,
  renameGroup,
  seedStore,
  setPrice,
  UNGROUPED_ID,
  updateManualStock,
} from '../src/domain/groups';

const pos = (key: string, valueKRW: number, costKRW = valueKRW, extra: Partial<Position> = {}): Position => ({
  key,
  name: key,
  currency: 'KRW',
  quantity: 10,
  avgPrice: costKRW / 10,
  price: valueKRW / 10,
  costKRW,
  valueKRW,
  attrs: {},
  ...extra,
});

describe('그룹 CRUD', () => {
  it('만들기 · 이름 변경 · 순서 · 삭제', () => {
    let s = emptyStore();
    const a = createGroup(s, ' 배당주 ');
    s = a.store;
    expect(s.groups).toEqual([{ id: a.id, name: '배당주' }]);
    const b = createGroup(s, '채권');
    s = b.store;
    expect(() => createGroup(s, '배당주')).toThrow('이미 있습니다');
    expect(() => createGroup(s, '  ')).toThrow('이름을 입력');
    expect(() => createGroup(s, '미분류')).toThrow();

    s = renameGroup(s, a.id, '고배당');
    expect(s.groups[0].name).toBe('고배당');
    expect(() => renameGroup(s, a.id, '채권')).toThrow('이미 있습니다');

    s = moveGroup(s, b.id, -1);
    expect(s.groups.map((g) => g.name)).toEqual(['채권', '고배당']);

    s = assignStock(s, 'SCHD', a.id);
    s = deleteGroup(s, a.id);
    expect(s.groups.map((g) => g.name)).toEqual(['채권']);
    expect(s.members.SCHD).toBeUndefined(); // 종목은 미분류로
  });

  it('원본 데이터는 바꾸지 않는다 (불변)', () => {
    const s = emptyStore();
    createGroup(s, '배당주');
    expect(s.groups).toHaveLength(0);
  });
});

describe('그룹 안의 종목 CRUD', () => {
  it('종목 지정 · 이동 · 빼기', () => {
    let s = createGroup(emptyStore(), '배당주').store;
    const g = s.groups[0].id;
    s = assignStock(s, 'SCHD', g);
    expect(s.members.SCHD).toBe(g);
    s = assignStock(s, 'SCHD', null);
    expect(s.members.SCHD).toBeUndefined();
    expect(() => assignStock(s, 'SCHD', 'nope')).toThrow('없는 그룹');
  });

  it('직접 추가 · 수정 · 삭제', () => {
    let s = createGroup(emptyStore(), '배당주').store;
    const g = s.groups[0].id;
    const res = addManualStock(s, { name: 'TIGER 미국배당다우존스', currency: 'KRW', quantity: 100, avgPrice: 12000, price: null }, g, ['SCHD']);
    s = res.store;
    expect(s.members[res.key]).toBe(g);
    expect(() => addManualStock(s, { name: 'SCHD', currency: 'USD', quantity: 1, avgPrice: 1, price: null }, null, ['SCHD'])).toThrow('이미 있습니다');
    expect(() => addManualStock(s, { name: 'X', currency: 'KRW', quantity: 0, avgPrice: 1, price: null }, null)).toThrow('수량');

    s = updateManualStock(s, res.key, { quantity: 150, price: 13000 });
    expect(s.manual[0]).toMatchObject({ quantity: 150, price: 13000 });
    expect(() => updateManualStock(s, 'SCHD', { quantity: 1 })).toThrow('직접 추가한 종목만');

    s = deleteManualStock(s, res.key);
    expect(s.manual).toHaveLength(0);
    expect(s.members[res.key]).toBeUndefined();
  });

  it('현재가 직접 입력이 평가금에 반영된다', () => {
    const base = [pos('A', 1000, 1000, { price: null })];
    let s = setPrice(emptyStore(), 'A', 120);
    const [a] = applyStore(base, s, 1400);
    expect(a.valueKRW).toBe(1200);
    expect(a.priceOverridden).toBe(true);
    s = setPrice(s, 'A', null);
    expect(applyStore(base, s, 1400)[0].valueKRW).toBe(1000);
    expect(() => setPrice(s, 'A', -1)).toThrow();
  });

  it('직접 추가한 달러 종목은 환율로 환산', () => {
    const s = addManualStock(emptyStore(), { name: 'JEPQ', currency: 'USD', quantity: 10, avgPrice: 50, price: 55 }, null).store;
    const [m] = applyStore([], s, 1400);
    expect(m.costKRW).toBe(700_000);
    expect(m.valueKRW).toBe(770_000);
    expect(m.manual).toBe(true);
  });
});

describe('그룹별 비중', () => {
  it('그룹 · 미분류 · 현금 비중 합 = 100%, 그룹 안 비중 합 = 100%', () => {
    let s = createGroup(emptyStore(), '배당주').store;
    const g = s.groups[0].id;
    s = assignStock(s, 'SCHD', g);
    s = assignStock(s, 'DGRO', g);
    const rows = customGroupRows([pos('SCHD', 600, 500), pos('DGRO', 200, 250), pos('TSLA', 100)], s, 100);
    expect(rows.map((r) => r.name)).toEqual(['배당주', '미분류', '현금']);
    const div = rows[0];
    expect(div.value).toBe(800);
    expect(div.weight).toBeCloseTo(0.8);
    expect(div.profit).toBe(50);
    expect(div.members.map((m) => m.key)).toEqual(['SCHD', 'DGRO']);
    expect(div.members[0].groupWeight).toBeCloseTo(0.75);
    expect(rows.reduce((t, r) => t + r.weight, 0)).toBeCloseTo(1);
  });

  it('같은 종목은 계좌가 달라도 합친다', () => {
    const rows = customGroupRows([pos('SCHD', 100, 100, { accountId: 'A' }), pos('SCHD', 300, 200, { accountId: 'B' })], emptyStore());
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(UNGROUPED_ID);
    expect(rows[0].members).toHaveLength(1);
    expect(rows[0].members[0]).toMatchObject({ quantity: 20, valueKRW: 400, costKRW: 300 });
  });

  it('비어 있는 사용자 그룹도 표에 남고, 빈 미분류는 빠진다', () => {
    const s = createGroup(emptyStore(), '채권').store;
    const rows = customGroupRows([], s);
    expect(rows.map((r) => r.name)).toEqual(['채권']);
  });

  it('기본 그룹 자동 생성', () => {
    const s = seedStore([pos('SCHD', 1), pos('TSLA', 1), pos('SGOV', 1)], [
      { name: '배당주', match: (p) => p.key === 'SCHD' },
      { name: '채권', match: (p) => p.key === 'SGOV' },
      { name: '리츠', match: () => false },
    ]);
    expect(s.groups.map((g) => g.name)).toEqual(['배당주', '채권']);
    expect(Object.keys(s.members).sort()).toEqual(['SCHD', 'SGOV']);
  });

  it('종목이 없으면 빈 기본 그룹을 만들어 둔다 (keepEmpty)', () => {
    const s = seedStore([], [{ name: '배당주', match: () => true }, { name: '채권', match: () => true }], true);
    expect(s.groups.map((g) => g.name)).toEqual(['배당주', '채권']);
    expect(s.members).toEqual({});
  });
});
