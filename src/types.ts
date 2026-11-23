// 도메인 타입. 마이데이터(금융투자) 응답을 이 형태로 변환해서 화면에 넘긴다.

export type Currency = 'KRW' | 'USD';

/** 날짜는 모두 'YYYY-MM-DD' 문자열 */
export type ISODate = string;

export interface Account {
  id: string;
  name: string;
  /** 증권사 이름 */
  institution: string;
  /** 위탁 / ISA / 연금저축 등 */
  type: string;
}

/** 그룹으로 묶을 때 쓰는 기준들 */
export type GroupDimension = 'assetClass' | 'region' | 'sector' | 'account';

export interface Instrument {
  code: string;
  name: string;
  currency: Currency;
  assetClass: string; // 국내주식 / 해외주식 / 국내ETF / 해외ETF / 채권 ...
  region: string; // 한국 / 미국
  sector: string;
}

export type TransactionType = 'DEPOSIT' | 'WITHDRAW' | 'BUY' | 'SELL' | 'DIVIDEND';

export interface Transaction {
  date: ISODate;
  accountId: string;
  type: TransactionType;
  /** BUY / SELL / DIVIDEND 일 때 종목 */
  code?: string;
  /** BUY / SELL 수량 */
  quantity?: number;
  /** BUY / SELL 체결 단가 (종목 통화) */
  price?: number;
  /** 원화 환산 금액. 입금·출금·배당(세후)은 이 값이 전부, 매매는 수수료 포함 정산 금액 */
  amountKRW: number;
  /** 매매·배당 시점 환율 (USD 종목만) */
  fxRate?: number;
  /** 종목 이름 (배당 표시용, 알 때만) */
  name?: string;
}

/** 일별 종가 (종목 통화 기준) */
export interface PriceSeries {
  code: string;
  dates: ISODate[];
  closes: number[];
}

export interface FxSeries {
  pair: 'USDKRW';
  dates: ISODate[];
  rates: number[];
}

/** 하루치 계좌 평가 스냅샷 (계산 결과) */
export interface DailySnapshot {
  date: ISODate;
  /** 누적 순입금 (입금 − 출금) */
  principal: number;
  /** 현금 + 보유 종목 평가금 */
  value: number;
  /** value − principal */
  profit: number;
  /** profit / principal */
  simpleReturn: number;
  /** 그날의 순입금 (입금 − 출금) */
  netFlow: number;
  /** 시작일부터 누적 시간가중수익률 */
  twr: number;
}

export interface Holding {
  accountId: string;
  instrument: Instrument;
  quantity: number;
  /** 평균 매입 단가 (원화, 매수 시점 환율 반영) */
  avgCostKRW: number;
  /** 현재가 (종목 통화) */
  price: number;
  /** 원화 평가금 */
  valueKRW: number;
  /** 원화 매입 원가 */
  costKRW: number;
  profitKRW: number;
  returnRate: number;
}
