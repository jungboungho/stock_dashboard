import type { Account, FxSeries, Instrument, PriceSeries, Transaction } from '../types';

/**
 * 화면은 이 인터페이스만 사용한다.
 * - DummyProvider : 고정 seed 로 만든 가상 데이터 (현재 사용)
 * (실제 계좌는 엑셀 + NH Open API 중계 서버 → data/holdings · data/sync)
 */
export interface DataProvider {
  readonly name: string;
  getAccounts(): Promise<Account[]>;
  getInstruments(): Promise<Instrument[]>;
  /** 계좌별 거래내역 (입출금 · 매매 · 배당), 날짜 오름차순 */
  getTransactions(): Promise<Transaction[]>;
  /** 종목별 일별 종가 */
  getPriceHistory(): Promise<PriceSeries[]>;
  getFxHistory(): Promise<FxSeries>;
}

export interface PortfolioData {
  provider: string;
  accounts: Account[];
  instruments: Instrument[];
  transactions: Transaction[];
  prices: PriceSeries[];
  fx: FxSeries;
}

export async function loadPortfolio(p: DataProvider): Promise<PortfolioData> {
  const [accounts, instruments, transactions, prices, fx] = await Promise.all([
    p.getAccounts(),
    p.getInstruments(),
    p.getTransactions(),
    p.getPriceHistory(),
    p.getFxHistory(),
  ]);
  return { provider: p.name, accounts, instruments, transactions, prices, fx };
}
