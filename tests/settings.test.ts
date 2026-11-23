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
