import { describe, expect, it } from 'vitest';
import { parseSyncSettings } from '../src/data/excel/parse';

describe('엑셀 설정 시트', () => {
  it("'중계 서버 주소' · '접속 토큰' 오른쪽 칸을 읽는다", () => {
    const wb = { 설정: { A1: '항목', B1: '값', A2: '중계 서버 주소', B2: ' https://example.workers.dev ', A3: '접속 토큰', B3: 'abc123' } };
    expect(parseSyncSettings(wb)).toEqual({ url: 'https://example.workers.dev', token: 'abc123' });
  });

  it('시트가 없거나 값이 하나라도 비면 null', () => {
    expect(parseSyncSettings({ Summary: {} })).toBeNull();
    expect(parseSyncSettings({ 설정: { A1: '중계 서버 주소', B1: 'https://x.dev' } })).toBeNull();
  });
});
