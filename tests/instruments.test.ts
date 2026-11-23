import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fillFromInstruments, parseDomesticMaster, parseOverseasMaster, searchInstruments, type Instrument } from '../src/data/instruments';
import type { PhotoRow } from '../src/data/photo';

const LIST: Instrument[] = [
  { code: '133690', name: 'TIGER 미국나스닥100', market: 'KR' },
  { code: '448300', name: 'TIGER 미국나스닥100(H)', market: 'KR' },
  { code: '418660', name: 'TIGER 미국나스닥100레버리지(합성)', market: 'KR' },
  { code: '441680', name: 'TIGER 미국나스닥100커버드콜(합성)', market: 'KR' },
  { code: '360750', name: 'TIGER 미국S&P500', market: 'KR' },
  { code: '441640', name: 'KODEX 미국배당커버드콜액티브', market: 'KR' },
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
    const list = d.items.map(([code, name]) => ({ code, name, market: 'KR' as const }));
    expect(list.length).toBeGreaterThan(3000);
    expect(searchInstruments(list, 'TIGER 미국나스닥100레버리지...')[0]).toEqual({ code: '418660', name: 'TIGER 미국나스닥100레버리지(합성)', market: 'KR' });
    expect(list.find((i) => i.code === '005930')?.name).toBe('삼성전자');
  });
});

describe('NH 종목 마스터 파일 해석 (CP949 · 고정 길이)', () => {
  const cp949 = (bytes: number[], len: number) => [...bytes, ...Array(len - bytes.length).fill(0x20)];
  const ascii = (t: string, len: number) => cp949([...t].map((c) => c.charCodeAt(0)), len);
  const 삼성 = [0xbb, 0xef, 0xbc, 0xba]; // '삼성' (CP949)

  it('국내: 코드 · 이름 (지수 표시 *, # 제거)', () => {
    const rec = [...ascii('005930', 6), ...ascii('1', 1), ...cp949([0x2a, ...삼성], 41), ...Array(237 - 48).fill(0x20)];
    expect(parseDomesticMaster(new Uint8Array([...rec, ...rec]))).toEqual([
      { code: '005930', name: '삼성', market: 'KR' },
      { code: '005930', name: '삼성', market: 'KR' },
    ]);
    expect(() => parseDomesticMaster(new Uint8Array(rec.slice(1)))).toThrow('레코드 크기');
  });

  it('해외: 미국(USA)만, 한글 이름 없으면 영문 이름', () => {
    const rec = (nation: string, sym: string, kor: number[], eng: string) => [...ascii('', 15), ...cp949(kor, 40), ...ascii(eng, 40), ...ascii(nation, 3), ...ascii(sym, 12), ...Array(164 - 110).fill(0x20)];
    const bytes = new Uint8Array([...rec('USA', 'SCHD', [], 'SCHWAB US DIVIDEND'), ...rec('JPN', '1301', 삼성, 'X'), ...rec('USA', 'SSNG', 삼성, 'SAMSUNG')]);
    expect(parseOverseasMaster(bytes)).toEqual([
      { code: 'SCHD', name: 'SCHWAB US DIVIDEND', market: 'US' },
      { code: 'SSNG', name: '삼성', market: 'US' },
    ]);
  });

  it('미국 종목: 한글 이름으로 찾으면 달러 · 티커로 채운다', () => {
    const list: Instrument[] = [...LIST, { code: 'TSLA', name: '테슬라', market: 'US' }];
    const [r] = fillFromInstruments([row('테슬라')], list);
    expect(r).toMatchObject({ code: 'TSLA', currency: 'USD', matched: 'list' });
    const [t] = fillFromInstruments([row('TSLA')], list);
    expect(t).toMatchObject({ code: 'TSLA', name: '테슬라', currency: 'USD', matched: 'list' });
  });
});
