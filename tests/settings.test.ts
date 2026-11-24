import { describe, expect, it } from 'vitest';
import { parseSyncSettings } from '../src/data/excel/parse';

describe('엑셀 설정 시트', () => {
  it("'중계 서버 주소' · '접속 토큰' 오른쪽 칸을 읽는다", () => {
    const wb = { 설정: { A1: '항목', B1: '값', A2: '중계 서버 주소', B2: ' https://example.workers.dev ', A3: '접속 토큰', B3: 'abc123' } };
    expect(parseSyncSettings(wb)).toEqual({ url: 'https://example.workers.dev', token: 'abc123', accountMap: {} });
  });

  it("'NH 계좌 1234' 줄 = 그 NH 계좌의 대시보드 계좌 이름", () => {
    const wb = { 설정: { A1: '중계 서버 주소', B1: 'https://x.dev', A2: '접속 토큰', B2: 't', A3: 'NH 계좌 4321', B3: 'ISA', A4: 'NH계좌 8765', B4: '연금1', A5: 'NH 계좌 메모', B5: 'x' } };
    expect(parseSyncSettings(wb)?.accountMap).toEqual({ '4321': 'ISA', '8765': '연금1' });
  });

  it('시트가 없거나 값이 하나라도 비면 null', () => {
    expect(parseSyncSettings({ Summary: {} })).toBeNull();
    expect(parseSyncSettings({ 설정: { A1: '중계 서버 주소', B1: 'https://x.dev' } })).toBeNull();
  });
});

describe("③ 엑셀 업데이트: '설정' 시트에 NH 계좌 줄", async () => {
  const { settingsWithNhAccounts } = await import('../src/data/excel/export');
  const wb = { 설정: { A1: '항목', B1: '값', C1: '설명', A2: '중계 서버 주소', B2: 'https://x.dev', A3: '접속 토큰', B3: 't', A4: 'NH 계좌 1234', B4: '종합' } };

  it('없는 계좌만 덧붙이고(새 계좌는 B열 비움), 기존 내용은 그대로', () => {
    const sheet = settingsWithNhAccounts(wb, [
      { suffix: '1234', name: '종합' },
      { suffix: '5678', name: '금계좌' },
      { suffix: '4321', name: null },
    ])!;
    expect(sheet.rows.slice(0, 4)).toEqual([['항목', '값', '설명'], ['중계 서버 주소', 'https://x.dev'], ['접속 토큰', 't'], ['NH 계좌 1234', '종합']]);
    expect(sheet.rows.slice(4).map((r) => [r[0], r[1]])).toEqual([
      ['NH 계좌 5678', '금계좌'],
      ['NH 계좌 4321', null],
    ]);
    // 다시 읽으면: 이름 있는 줄만 매핑, B열 빈 줄은 무시
    const cells: Record<string, string> = {};
    sheet.rows.forEach((r, i) => r.forEach((v, c) => v !== null && v !== undefined && (cells[`${'ABC'[c]}${i + 1}`] = String(v))));
    expect(parseSyncSettings({ 설정: cells })?.accountMap).toEqual({ '1234': '종합', '5678': '금계좌' });
  });

  it('덧붙일 줄이 없으면 시트를 다시 쓰지 않는다 · 설정 시트가 없으면 새로 만든다', () => {
    expect(settingsWithNhAccounts(wb, [{ suffix: '1234', name: '종합' }])).toBeNull();
    expect(settingsWithNhAccounts({}, [{ suffix: '9999', name: null }])?.rows).toEqual([['항목', '값', '설명'], ['NH 계좌 9999', null, expect.stringContaining('B열')]]);
  });
});

describe("보유 종목 컬럼 설정을 '설정' 시트에", async () => {
  const { settingsWithNhAccounts } = await import('../src/data/excel/export');
  const { settingValue } = await import('../src/data/excel/parse');
  const { COLUMNS_SETTING, defaultPrefs, moveColumn, prefsFromText, prefsToText, toggleColumn } = await import('../src/ui/columns');
  const toCells = (rows: unknown[][]) => {
    const cells: Record<string, string> = {};
    rows.forEach((r, i) => r.forEach((v, c) => v !== null && v !== undefined && (cells[`${'ABC'[c]}${i + 1}`] = String(v))));
    return cells;
  };

  it('글로 바꿨다가 되읽으면 같은 설정 (숨김은 앞에 -)', () => {
    const p = toggleColumn(moveColumn(defaultPrefs(), 'weight', 0), 'avg', false);
    const text = prefsToText(p);
    expect(text.startsWith('비중, 계좌, 그룹, 수량, -평균단가, 현재가')).toBe(true);
    expect(prefsFromText(text)).toEqual(p);
    // 손으로 고친 값: 띄어쓰기 · 모르는 이름 · 빠진 컬럼도 받아 준다
    const hand = prefsFromText('종가등락률, -계좌, 없는컬럼, 현재가')!;
    const at = (id: string) => hand.order.indexOf(id as never);
    expect(at('closeChange')).toBeLessThan(at('account'));
    expect(at('account')).toBeLessThan(at('price'));
    expect(hand.hidden).toEqual(['account']);
    expect(hand.order).toHaveLength(12);
    expect(prefsFromText('아무거나')).toBeNull();
  });

  it('없으면 줄을 덧붙이고, 있으면 B열만 바꾸고, 같으면 시트를 다시 쓰지 않는다', () => {
    const value = prefsToText(toggleColumn(defaultPrefs(), 'group', false));
    const wb = { 설정: { A1: '항목', B1: '값', A2: '중계 서버 주소', B2: 'https://x.dev' } };
    const first = settingsWithNhAccounts(wb, [], [{ label: COLUMNS_SETTING, value, note: '설명' }])!;
    expect(first.rows.at(-1)).toEqual([COLUMNS_SETTING, value, '설명']);
    const wb2 = { 설정: toCells(first.rows) };
    expect(settingValue(wb2, COLUMNS_SETTING)).toBe(value);
    expect(settingsWithNhAccounts(wb2, [], [{ label: COLUMNS_SETTING, value, note: '설명' }])).toBeNull();
    const changed = settingsWithNhAccounts(wb2, [], [{ label: COLUMNS_SETTING, value: prefsToText(defaultPrefs()), note: '설명' }])!;
    expect(changed.rows).toHaveLength(first.rows.length);
    expect(changed.rows.at(-1)?.[1]).toBe(prefsToText(defaultPrefs()));
  });
});

describe('처음 쓰는 사람용 엑셀 양식 (public/template.xlsx)', async () => {
  const { readFileSync } = await import('node:fs');
  const { JSDOM } = await import('jsdom');
  const { readWorkbook } = await import('../src/data/excel/xlsx');
  const { parseStockBook } = await import('../src/data/excel/parse');
  const { makeExcelModel } = await import('../src/data/excelModel');
  globalThis.DOMParser = new JSDOM().window.DOMParser as unknown as typeof DOMParser;

  it('대시보드가 그대로 읽고, 설정 시트는 비어 있다', () => {
    const wb = readWorkbook(new Uint8Array(readFileSync('public/template.xlsx')));
    const book = parseStockBook(wb, 'template.xlsx');
    expect(book.depositAccounts).toEqual(['종합', 'ISA']);
    expect(book.months.length).toBeGreaterThan(20);
    expect(book.deposits.length).toBeGreaterThan(0);
    expect(book.unit).toBe(10000);
    expect(parseSyncSettings(wb)).toBeNull(); // 주소 · 토큰은 직접 넣음
    expect(makeExcelModel(book, '2026-11-30').snapshots([]).length).toBeGreaterThan(20);
  });
});
