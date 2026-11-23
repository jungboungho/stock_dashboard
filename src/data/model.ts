import type { Currency, DailySnapshot, ISODate, Transaction } from '../types';

/**
 * 화면이 쓰는 데이터 모델. 데이터 출처(더미 · 엑셀 · 마이데이터)마다 어댑터가 이 형태를 만든다.
 * 출처마다 가진 정보가 달라서 지원 여부(accountFilter · hasDividends)를 함께 알려준다.
 */
export interface Position {
  /** 그룹 소속을 저장할 때 쓰는 종목 키 (같은 종목이면 계좌가 달라도 같은 키) */
  key: string;
  name: string;
  code?: string;
  currency: Currency;
  accountId?: string;
  quantity: number;
  /** 평균 매입 단가 (종목 통화) */
  avgPrice: number;
  /** 현재가 (종목 통화). 모르면 null → 평가금 = 매입원가 */
  price: number | null;
  costKRW: number;
  valueKRW: number;
  /** 그룹 기준별 값 (assetClass · region · sector · currency ...) */
  attrs: Record<string, string>;
  /** 사용자가 직접 추가한 종목 */
  manual?: boolean;
  /** 사용자가 현재가를 직접 입력함 */
  priceOverridden?: boolean;
}

export interface YearStart {
  year: number;
  /** 연초 자산 */
  start: number;
  /** 연중 순입금 */
  flow: number;
}

/** 계좌별 입출금 기록 (음수 = 출금 · 계좌 간 이체로 빠져나감) */
export interface DepositData {
  accounts: string[];
  rows: { date: ISODate; amounts: number[] }[];
}

export interface AccountInfo {
  id: string;
  name: string;
  /** 누적 순입금 (알 수 있을 때) */
  principal?: number;
}

export interface Dimension {
  id: string;
  label: string;
}

export interface DashboardData {
  source: 'dummy' | 'excel' | 'mydata';
  sourceLabel: string;
  /** 데이터를 마지막으로 받아온 시각 (ISO) */
  updatedAt?: string;
  asOf: ISODate;
  accounts: AccountInfo[];
  /** 계좌별로 평가금을 나눠 볼 수 있는지 */
  accountFilter: boolean;
  /** 기본 제공 그룹 기준 ('내 그룹' 은 화면에서 항상 추가) */
  dimensions: Dimension[];
  hasDividends: boolean;
  /** 목표 수익률 (연) */
  goal: number | null;
  /** 원화 환산에 쓰는 USD 환율 */
  usdKrw: number;
  snapshots(accountIds: string[]): DailySnapshot[];
  positions(accountIds: string[]): Position[];
  cash(accountIds: string[]): Record<string, number>;
  dividends(accountIds: string[]): Transaction[];
  /** 연도별 연초 자산 · 순입금을 원본이 직접 가지고 있으면 그 값을 쓴다 (엑셀 Summary) */
  yearStarts?: YearStart[];
  deposits?: DepositData;
  /** 그룹 기본값을 만들 때 쓰는 힌트 */
  defaultGroups?: { name: string; match: (p: Position) => boolean }[];
}
