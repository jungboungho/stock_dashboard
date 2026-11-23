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
