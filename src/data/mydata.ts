import type { DataProvider } from './provider';
import type { Account, FxSeries, Instrument, PriceSeries, Transaction } from '../types';

/**
 * 마이데이터(금융투자) API 연동 자리.
 *
 * 연동 시 유의사항
 * - 마이데이터 API 는 접근토큰(Bearer)과 사업자 인증이 필요하다. GitHub Pages 는 정적 사이트라
 *   토큰을 브라우저 코드에 넣을 수 없으므로, 토큰을 보관하는 중계 서버(proxy)를 두고
 *   이 클래스는 그 서버의 엔드포인트만 호출하도록 만든다.
 * - 계좌 목록 · 보유 상품 · 거래내역 응답을 types.ts 의 Account / Instrument / Transaction 으로 변환한다.
 * - 마이데이터는 과거 일별 종가를 주지 않으므로 자산추이용 가격은 시세 API 나
 *   매일 저장한 평가 스냅샷으로 채운다.
 */
export class MyDataProvider implements DataProvider {
  readonly name = 'mydata';

  constructor(private readonly baseUrl: string) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`마이데이터 중계 서버 오류 (${res.status}): ${path}`);
    return (await res.json()) as T;
  }

  getAccounts(): Promise<Account[]> {
    return this.get('/accounts');
  }
  getInstruments(): Promise<Instrument[]> {
    return this.get('/instruments');
  }
  getTransactions(): Promise<Transaction[]> {
    return this.get('/transactions');
  }
  getPriceHistory(): Promise<PriceSeries[]> {
    return this.get('/prices');
  }
  getFxHistory(): Promise<FxSeries> {
    return this.get('/fx');
  }
}
