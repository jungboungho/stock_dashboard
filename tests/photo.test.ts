import { describe, expect, it } from 'vitest';
import { applyPhoto, guessAccountByTotal, matchHoldings, parseAccountScreen } from '../src/data/photo';
import { emptyHoldings, type HoldingsState } from '../src/data/holdings';

// 실제 OCR 결과의 모양(아이콘 찌꺼기, '주'→'%', 두 줄 이름, 메뉴 줄)을 흉내 낸 가상 값
const ISA_TEXT = `1:25 BW ㆍ all €
J 15&  gaol < =
o
1,000,500&
-3,000%(-0.30%) 일간 수익
계좌      수익      세금      배당      추이      비중
투자
시세 평가                        총수익 ㆍ 직접설정순
KODEX                           400,000
S  미국배당커버드콜액티브          -20,000원 (-4.76%)
40주
S  TIGER 0|2S&P500            350,000
35%                                   +10,000% (+2.94%)
TIGER                            250,000
(er  미국나스닥100레버리지.        이 12.345원(-4.7350)
20주
현금
(w]  원                                     500원
@ 관리
친구와 함께 하는 게임  다운로드`;

const IRP_TEXT = `© 신한투자증권(주) IRP ^ wos
300,100&
투자
시세 평가   총수익 ㆍ 직접설정순
TIGER 미국테크10610                      200,000원
(er  INDXX                       +50,000%! (+33.33%)
80%
현금성자산                               100원
증권사 미제공                                        0.00원 (0.00%)
흔 관리`;

const US_TEXT = `03 종합   gages
1,500,000 v
-1,000원(-0.1%) 일간 수익
투자
시세 평가   총수익 ㆍ 직접설정순
@  TSLA                           900,000원
10주                                       +400,000원 (+80.00%)
숭  ㅠㅠ                             500,000원
5주                                         -10,000원 (-1.96%)
현금
(w]  원                                 60,000원
@  달러                               $10.50`;

function holdings(): HoldingsState {
  const h = emptyHoldings();
  h.rows = [
    { account: 'ISA', code: '441640', name: 'KODEX 미국배당커버드콜액티브', currency: 'KRW', quantity: 30, avgPrice: 10000, price: 10000, costKRW: 300000 },
    { account: 'ISA', code: '360750', name: 'TIGER 미국S&P500', currency: 'KRW', quantity: 35, avgPrice: 9000, price: 9000 },
    { account: 'ISA', code: '418660', name: 'TIGER 미국나스닥100레버리지(합성)', currency: 'KRW', quantity: 20, avgPrice: 15000, price: 12000, costKRW: 300000 },
    { account: 'IRP', code: '381170', name: 'TIGER 미국테크TOP10 INDXX', currency: 'KRW', quantity: 70, avgPrice: 2000, price: 2500 },
    { account: '종합', code: 'TSLA', name: '테슬라', currency: 'USD', quantity: 10, avgPrice: 30, price: 60 },
    { account: '종합', code: 'TLT', name: '아이셰어즈 20+년 미국 국채 ETF', currency: 'USD', quantity: 5, avgPrice: 75, price: 70 },
  ];
  return h;
}

const ACCOUNTS = ['종합', 'ISA', '금계좌', '연금1', '연금2', 'IRP'];

describe('계좌 화면 사진 읽기', () => {
  it('두 줄 이름 · 수량 표기 오류 · 부호 없는 손익을 읽고, 합계가 화면 총액과 맞는다', () => {
    const r = parseAccountScreen(ISA_TEXT, ACCOUNTS);
    expect(r.account).toBeNull(); // 'ISA' 제목을 못 읽음
    expect(r.total).toBe(1_000_500);
    expect(r.rows.map((x) => [x.quantity, x.value, x.pnl])).toEqual([
      [40, 400_000, -20_000],
      [35, 350_000, 10_000],
      [20, 250_000, null], // 손익 부호를 못 읽음 → 비움
    ]);
    expect(r.cashKRW).toBe(500);
    expect(r.rows[0].ocrName).toContain('미국배당커버드콜액티브'); // '배당'이 들어간 이름도 메뉴로 오인하지 않음
  });

  it('계좌 이름(IRP) · 현금성자산', () => {
    const r = parseAccountScreen(IRP_TEXT, ACCOUNTS);
    expect(r).toMatchObject({ account: 'IRP', total: 300_100, cashKRW: 100 });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ quantity: 80, value: 200_000, pnl: 50_000 });
    expect(r.rows[0].ocrName).toContain('INDXX');
  });

  it('달러 현금 · 이름을 못 읽은 종목은 같은 수량으로 맞춘다', () => {
    const r = matchHoldings(parseAccountScreen(US_TEXT, ACCOUNTS), holdings());
    expect(r).toMatchObject({ account: '종합', cashKRW: 60_000, cashUSD: 10.5 });
    expect(r.rows.map((x) => [x.code, x.matched])).toEqual([
      ['TSLA', 'name'],
      ['TLT', 'quantity'],
    ]);
    expect(r.rows[1].currency).toBe('USD');
  });

  it('계좌를 못 읽으면 총액이 가까운 계좌, 이름은 비슷한 보유 종목으로', () => {
    const h = holdings();
    const parsed = parseAccountScreen(ISA_TEXT, ACCOUNTS);
    parsed.account = guessAccountByTotal(parsed.total, { ISA: 1_010_000, 종합: 5_000_000 });
    expect(parsed.account).toBe('ISA');
    const r = matchHoldings(parsed, h);
    expect(r.rows.map((x) => x.code)).toEqual(['441640', '360750', '418660']);
  });

  it('적용: 그 계좌만 바뀌고, 손익을 못 읽은 종목은 예전 매입금액(수량 비례) 유지', () => {
    const h = holdings();
    const parsed = matchHoldings({ ...parseAccountScreen(ISA_TEXT, ACCOUNTS), account: 'ISA' }, h);
    const next = applyPhoto(h, 'ISA', parsed.rows, parsed.cashKRW, parsed.cashUSD, 1400);
    const isa = next.rows.filter((r) => r.account === 'ISA');
    expect(isa.map((r) => [r.code, r.quantity, r.costKRW, r.price])).toEqual([
      ['441640', 40, 420_000, 10_000],
      ['360750', 35, 340_000, 10_000],
      ['418660', 20, 300_000, 12_500],
    ]);
    expect(next.rows.filter((r) => r.account !== 'ISA')).toEqual(h.rows.filter((r) => r.account !== 'ISA'));
    expect(next.cash).toEqual([{ account: 'ISA', currency: 'KRW', amount: 500 }]);
  });
});

describe('OCR 오류 대응', () => {
  it("'원'을 숫자로 읽은 금액(21,833,1208)과 '…'로 줄인 이름", () => {
    const text = `ISA
1,000,500원
투자
시세 평가   총수익 ㆍ 직접설정순
KODEX                           400,0008
S  미국배당커버드콜액티브          -20,000원 (-4.76%)
40주
TIGER                            350,000원
(er  미국나스닥100레버리지...        -10,000원(-2.8%)
35주
현금
(w]  원                                     250,500원`;
    const r = matchHoldings(parseAccountScreen(text, ACCOUNTS), holdings());
    expect(r.rows.map((x) => [x.code, x.quantity, x.value, x.pnl])).toEqual([
      ['441640', 40, 400_000, -20_000],
      ['418660', 35, 350_000, -10_000],
    ]);
    expect(r.rows[1].matched).toBe('name');
  });
});

describe('다른 계좌 종목과의 오인 방지', () => {
  it("이 계좌에 없는 종목이 다른 계좌의 'TIGER 미국…' 종목과 맞춰지지 않는다", () => {
    const h = holdings();
    h.rows = h.rows.filter((r) => r.code !== '418660'); // ISA 에서 레버리지 ETF 없음
    h.rows.push({ account: '연금1', code: '360750', name: 'TIGER 미국S&P500', currency: 'KRW', quantity: 7, avgPrice: 9000, price: 9000 });
    const parsed = { account: 'ISA', total: null, cashKRW: null, cashUSD: null, rows: [{ name: 'TIGER 미국나스닥100레버리지.', ocrName: 'TIGER 미국나스닥100레버리지.', code: '', currency: 'KRW' as const, quantity: 20, value: 250_000, pnl: null, matched: null }] };
    expect(matchHoldings(parsed, h).rows[0].matched).toBeNull();
  });
});
