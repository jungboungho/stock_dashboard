import { describe, expect, it } from 'vitest';
import { defaultPrefs, moveColumn, normalizePrefs, toggleColumn, visibleColumns } from '../src/ui/columns';

describe('보유 종목 컬럼 설정', () => {
  it('기본: 등락률은 현재가와 평가금 사이', () => {
    const v = visibleColumns(defaultPrefs());
    expect(v.slice(v.indexOf('price'), v.indexOf('price') + 3)).toEqual(['price', 'change', 'value']);
  });

  it('숨기기 · 다시 보이기 · 순서 바꾸기', () => {
    let p = toggleColumn(defaultPrefs(), 'avg', false);
    expect(visibleColumns(p)).not.toContain('avg');
    p = moveColumn(p, 'weight', 0);
    expect(p.order[0]).toBe('weight');
    p = toggleColumn(p, 'avg', true);
    expect(visibleColumns(p)).toContain('avg');
    p = moveColumn(p, 'weight', 99);
    expect(p.order.at(-1)).toBe('weight');
  });

  it('예전에 저장한 설정에 새 컬럼(등락률)이 없으면 기본 위치에 끼워 넣고, 모르는 컬럼은 버린다', () => {
    const p = normalizePrefs({ order: ['weight', 'quantity', 'price', 'value', 'bogus' as never], hidden: ['group', 'bogus' as never] });
    // 빠진 계좌 · 그룹은 기본 자리(맨 앞), avg 는 quantity 뒤, change 는 price 뒤
    expect(p.order.slice(0, 7)).toEqual(['account', 'group', 'weight', 'quantity', 'avg', 'price', 'change']);
    expect(p.order.indexOf('change')).toBe(p.order.indexOf('price') + 1);
    expect(p.order).toHaveLength(10);
    expect(p.hidden).toEqual(['group']);
  });
});
