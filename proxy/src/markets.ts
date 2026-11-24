// ─────────────────────────────────────────────────────────────
// 지수 · 환율 · 금 목록 (중계 서버 시세 조회와 사이트 종목 목록이 함께 쓴다)
//  - 코드는 주식 코드와 겹치지 않게 접두어(IDX: · FX: · GOLD:)를 붙인다
//  - 지수 · 환율은 NH '해외 기간별 시세(지수 · 환율)' API 의 iem_cd. NH 가 코드표를 공개하지 않아
//    2026-11-24 실제 응답으로 확인한 것만 넣었다
//  - NH 에 없는 것: 코스닥, TOPIX, 심천 · CSI300, NIFTY, FTSE100, CAC40, 영국 파운드, 인도 루피
//    (NH 'INR' 코드는 인도네시아 루피아를 돌려준다)
// ─────────────────────────────────────────────────────────────

export type MarketRegion = '한국' | '미국' | '일본' | '중국' | '인도' | '유럽' | '기타';

interface Session {
  tz: string;
  /** 정규장 시작 · 끝 (현지 시각, 분) */
  open: number;
  close: number;
}

export type MarketDef =
  | ({ kind: 'index'; iem: string } & Session)
  /**
   * 환율. iem 은 NH 환율 코드 (대부분 '달러당 그 통화', invert 면 '그 통화당 달러').
   * cross: 원화 환산 (원/달러와 곱하거나 나눔), per: 100엔처럼 단위
   */
  | { kind: 'fx'; iem: string; invert?: boolean; cross?: boolean; per?: number }
  | { kind: 'gold'; iem: string };

export interface MarketItem {
  code: string;
  name: string;
  region: MarketRegion;
  /** 값 뒤에 붙일 단위 (지수는 없음) */
  unit: '' | '원' | '엔' | '위안' | '달러';
  /** 검색어 (이름 말고도 이걸로 찾는다) */
  aka: string[];
  def: MarketDef;
}

const h = (hh: number, mm = 0) => hh * 60 + mm;
const SEOUL: Session = { tz: 'Asia/Seoul', open: h(9), close: h(15, 30) };
const NEW_YORK: Session = { tz: 'America/New_York', open: h(9, 30), close: h(16) };
const TOKYO: Session = { tz: 'Asia/Tokyo', open: h(9), close: h(15, 30) };
const SHANGHAI: Session = { tz: 'Asia/Shanghai', open: h(9, 30), close: h(15) };
const HONG_KONG: Session = { tz: 'Asia/Hong_Kong', open: h(9, 30), close: h(16) };
const MUMBAI: Session = { tz: 'Asia/Kolkata', open: h(9, 15), close: h(15, 30) };
const FRANKFURT: Session = { tz: 'Europe/Berlin', open: h(9), close: h(17, 30) };
const TAIPEI: Session = { tz: 'Asia/Taipei', open: h(9), close: h(13, 30) };
const HO_CHI_MINH: Session = { tz: 'Asia/Ho_Chi_Minh', open: h(9), close: h(15) };
const BANGKOK: Session = { tz: 'Asia/Bangkok', open: h(10), close: h(16, 30) };
const TORONTO: Session = { tz: 'America/Toronto', open: h(9, 30), close: h(16) };

const index = (code: string, name: string, region: MarketRegion, iem: string, s: Session, aka: string[] = []): MarketItem => ({
  code: `IDX:${code}`,
  name,
  region,
  unit: '',
  aka: [region, '지수', ...aka],
  def: { kind: 'index', iem, ...s },
});

/** 1(또는 per)단위당 원화 */
const toKrw = (cur: string, name: string, region: MarketRegion, iem: string, opt: { invert?: boolean; per?: number } = {}, aka: string[] = []): MarketItem => ({
  code: `FX:${cur}KRW`,
  name,
  region,
  unit: '원',
  aka: [region, '환율', cur, ...aka],
  def: { kind: 'fx', iem, cross: true, ...opt },
});

export const MARKETS: MarketItem[] = [
  // 한국
  index('KOSPI', '코스피', '한국', 'KOSPI', SEOUL, ['KOSPI']),
  // 미국
  index('SPX', 'S&P500', '미국', 'SPX', NEW_YORK, ['SNP', '에스앤피']),
  index('COMP', '나스닥', '미국', 'COMP', NEW_YORK, ['NASDAQ', '나스닥종합']),
  index('NDX', '나스닥100', '미국', 'NDX', NEW_YORK, ['NASDAQ100']),
  index('DJI', '다우존스', '미국', '.DJI', NEW_YORK, ['DOW', '다우']),
  index('DJT', '다우존스 운송', '미국', '.DJT', NEW_YORK, ['DOW', '다우']),
  index('NYA', 'NYSE 종합', '미국', 'NYA', NEW_YORK, ['뉴욕']),
  index('SOX', '필라델피아 반도체', '미국', 'SOXX', NEW_YORK, ['SOX', '반도체']),
  index('XAU', '필라델피아 금/은', '미국', 'XAU', NEW_YORK, ['금', '은']),
  // 일본
  index('N225', '니케이225', '일본', 'N225', TOKYO, ['NIKKEI', '닛케이']),
  // 중국 · 홍콩
  index('SHANG', '상해종합', '중국', 'SHANG', SHANGHAI, ['상하이', 'SHANGHAI']),
  index('HSI', '항셍', '중국', 'HSI', HONG_KONG, ['홍콩', 'HANGSENG']),
  index('HSCE', '홍콩 H지수', '중국', 'HSCE', HONG_KONG, ['홍콩', 'H지수', 'HSCEI']),
  // 인도
  index('SENSEX', '인도 SENSEX', '인도', 'BSESN', MUMBAI, ['센섹스', 'SENSEX']),
  // 유럽
  index('DAX', '독일 DAX', '유럽', 'DAX', FRANKFURT, ['독일', 'DAX']),
  index('SX5E', '유로STOXX50', '유럽', 'SX5E', FRANKFURT, ['유로', 'STOXX', '스톡스']),
  // 기타
  index('TWI', '대만 가권', '기타', 'TWI', TAIPEI, ['대만', 'TAIEX']),
  index('VNI', '베트남 VN', '기타', 'VNI', HO_CHI_MINH, ['베트남', '호치민']),
  index('SET', '태국 SET', '기타', 'SET', BANGKOK, ['태국']),
  index('TSX', '캐나다 S&P/TSX', '기타', 'GSPTSE', TORONTO, ['캐나다']),

  // 원화 환율 (1단위당 원)
  { code: 'FX:USDKRW', name: '원/달러 환율', region: '미국', unit: '원', aka: ['미국', '환율', 'USD', '달러'], def: { kind: 'fx', iem: 'KRW' } },
  toKrw('JPY', '원/엔 환율 (100엔)', '일본', 'JPY', { per: 100 }, ['엔화']),
  toKrw('CNY', '원/위안 환율', '중국', 'CNY', {}, ['위안화']),
  toKrw('HKD', '원/홍콩달러 환율', '중국', 'HKD', {}, ['홍콩']),
  toKrw('EUR', '원/유로 환율', '유럽', 'EUR', { invert: true }, ['유로화']),
  toKrw('CHF', '원/스위스프랑 환율', '유럽', 'CHF', {}, ['스위스']),
  toKrw('TWD', '원/대만달러 환율', '기타', 'TWD', {}, ['대만']),
  toKrw('AUD', '원/호주달러 환율', '기타', 'AUD', { invert: true }, ['호주']),
  toKrw('CAD', '원/캐나다달러 환율', '기타', 'CAD', {}, ['캐나다']),
  toKrw('SGD', '원/싱가포르달러 환율', '기타', 'SGD', {}, ['싱가포르']),
  toKrw('THB', '원/태국바트 환율', '기타', 'THB', {}, ['태국']),
  toKrw('IDR', '원/인도네시아루피아 환율 (100루피아)', '기타', 'INR', { per: 100 }, ['인도네시아']),
  // 달러 기준 환율
  { code: 'FX:USDJPY', name: '엔/달러 환율', region: '일본', unit: '엔', aka: ['일본', '환율', 'JPY', '엔화', '달러엔'], def: { kind: 'fx', iem: 'JPY' } },
  { code: 'FX:USDCNY', name: '위안/달러 환율', region: '중국', unit: '위안', aka: ['중국', '환율', 'CNY', '위안화'], def: { kind: 'fx', iem: 'CNY' } },
  { code: 'FX:EURUSD', name: '달러/유로 환율', region: '유럽', unit: '달러', aka: ['유럽', '환율', 'EUR', '유로화'], def: { kind: 'fx', iem: 'EUR' } },

  // 금
  { code: 'GOLD:KRX', name: '금 (KRX 금현물, 1g)', region: '한국', unit: '원', aka: ['한국', '금', 'GOLD', '금현물'], def: { kind: 'gold', iem: 'M04020000' } },
];

export const MARKET_BY_CODE: Record<string, MarketItem> = Object.fromEntries(MARKETS.map((m) => [m.code, m]));
