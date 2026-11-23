import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fillFromInstruments, searchInstruments, type Instrument } from '../src/data/instruments';
import type { PhotoRow } from '../src/data/photo';

const LIST: Instrument[] = [
  { code: '133690', name: 'TIGER 미국나스닥100' },
  { code: '448300', name: 'TIGER 미국나스닥100(H)' },
  { code: '418660', name: 'TIGER 미국나스닥100레버리지(합성)' },
  { code: '441680', name: 'TIGER 미국나스닥100커버드콜(합성)' },
  { code: '360750', name: 'TIGER 미국S&P500' },
  { code: '441640', name: 'KODEX 미국배당커버드콜액티브' },
];

const row = (ocrName: string): PhotoRow => ({ name: ocrName, ocrName, code: '', currency: 'KRW', quantity: 1, value: 1000, pnl: null, matched: null });

describe('NH 종목 목록 검색', () => {
  it('앞부분이 같은 종목을 짧은 이름 순으로 (띄어쓰기 · 괄호 무시)', () => {
    expect(searchInstruments(LIST, 'TIGER 미국나스닥100...').map((i) => i.code)).toEqual(['133690', '448300', '418660', '441680']);
    expect(searchInstruments(LIST, 'TIGER 미국나스닥100레버리지. 이').map((i) => i.code)).toEqual(['418660']);
    expect(searchInstruments(LIST, 'KODEX미국배당커버드콜…').map((i) => i.code)).toEqual(['441640']);
  });

  it('앞부분이 맞는 게 없으면 비슷한 이름', () => {
    expect(searchInstruments(LIST, 'TIGER 0|=S&P500')[0].code).toBe('360750');
    expect(searchInstruments(LIST, 'ㅠㅠ')).toEqual([]);
  });

  it('하나면 채우고, 여러 개면 첫 번째로 채우고 후보를 붙인다 · 보유 종목과 맞춘 줄 · 미국 티커는 그대로', () => {
    const rows = fillFromInstruments(
      [row('TIGER 미국나스닥100레버리지...'), row('TIGER 미국나스닥100…'), { ...row('KODEX'), matched: 'name', code: 'X' }, row('SCHD')],
      LIST,
    );
    expect(rows[0]).toMatchObject({ code: '418660', name: 'TIGER 미국나스닥100레버리지(합성)', matched: 'list', candidates: undefined });
    expect(rows[1]).toMatchObject({ code: '133690', matched: 'list' });
    expect(rows[1].candidates?.map((c) => c.code)).toEqual(['133690', '448300', '418660', '441680']);
    expect(rows[2]).toMatchObject({ code: 'X', matched: 'name' });
    expect(rows[3]).toMatchObject({ code: 'SCHD', currency: 'USD' });
  });

  it('실제 목록 파일 (public/instruments.json)', () => {
    const d = JSON.parse(readFileSync('public/instruments.json', 'utf8')) as { items: [string, string][] };
    const list = d.items.map(([code, name]) => ({ code, name }));
    expect(list.length).toBeGreaterThan(3000);
    expect(searchInstruments(list, 'TIGER 미국나스닥100레버리지...')[0]).toEqual({ code: '418660', name: 'TIGER 미국나스닥100레버리지(합성)' });
    expect(list.find((i) => i.code === '005930')?.name).toBe('삼성전자');
  });
});
