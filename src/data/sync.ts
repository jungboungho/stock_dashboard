import type { DashboardData } from './model';
import { MyDataProvider } from './mydata';
import { loadPortfolio } from './provider';
import { makePortfolioModel } from './dummyModel';

/**
 * 마이데이터 동기화.
 * 마이데이터 접근토큰은 브라우저에 둘 수 없으므로, 토큰을 가진 중계 서버 주소를
 * 빌드 환경변수 VITE_MYDATA_PROXY_URL 로 넣는다. 주소가 없으면 '준비 중' 상태.
 */
export interface MyDataStatus {
  configured: boolean;
  endpoint?: string;
}

export function mydataStatus(): MyDataStatus {
  const endpoint = (import.meta.env.VITE_MYDATA_PROXY_URL as string | undefined)?.trim();
  return endpoint ? { configured: true, endpoint } : { configured: false };
}

export async function syncMyData(): Promise<DashboardData> {
  const status = mydataStatus();
  if (!status.configured) throw new Error('마이데이터 중계 서버가 아직 연결되지 않았습니다.');
  const data = await loadPortfolio(new MyDataProvider(status.endpoint!));
  return makePortfolioModel(data, { source: 'mydata', sourceLabel: '마이데이터', updatedAt: new Date().toISOString() });
}
