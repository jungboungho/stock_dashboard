import { MARKET_BY_CODE } from '../../proxy/src/markets';
import { DISCOVER_GROUP, marketWatchItem, type WatchItem, type Watchlist } from './watchlist';

// 샘플 화면의 관심 종목 (값은 모두 임의 값, 화면에서는 읽기 전용)
//  [코드, 현재가, 등락률, 종가, 종가 등락률]
type Vals = [price: number, change: number, close: number, closeChange: number];
type Row = [string, ...Vals];

const DISCOVER: Row[] = [
  ['IDX:KOSPI', 3120.45, 0.0084, 3120.45, 0.0084],
  ['IDX:COMP', 19850.2, -0.0031, 19912.08, 0.0122],
  ['IDX:SPX', 6105.7, -0.0012, 6113.03, 0.0071],
  ['IDX:DJI', 44210.6, 0.0005, 44188.5, 0.0043],
  ['IDX:SOX', 5620.3, -0.0108, 5681.66, 0.0215],
  ['FX:USDKRW', 1388.5, -0.0011, 1390.03, 0.0024],
  ['FX:JPYKRW', 912.4, 0.0016, 910.94, -0.0032],
  ['GOLD:KRX', 148250, 0.0042, 148250, 0.0042],
];

const WORLD: Row[] = [
  ['IDX:N225', 39870.15, 0.0063, 39870.15, 0.0063],
  ['IDX:SHANG', 3352.8, -0.0027, 3352.8, -0.0027],
  ['IDX:HSI', 21480.4, 0.0119, 21480.4, 0.0119],
  ['IDX:SENSEX', 81240.6, 0.0031, 81240.6, 0.0031],
  ['IDX:DAX', 21560.9, -0.0045, 21658.36, 0.0018],
  ['IDX:SX5E', 5320.4, -0.0038, 5340.69, 0.0009],
  ['FX:EURKRW', 1512.3, 0.0007, 1511.24, -0.0015],
];

const STOCKS: (Omit<WatchItem, 'group'> & { row: Vals })[] = [
  { code: '005930', name: '삼성전자', currency: 'KRW', row: [71200, 0.0142, 71200, 0.0142] },
  { code: '000660', name: 'SK하이닉스', currency: 'KRW', row: [198500, -0.0074, 198500, -0.0074] },
  { code: 'NVDA', name: '엔비디아', currency: 'USD', row: [138.4, -0.0062, 139.26, 0.0231] },
];

const item = (base: Omit<WatchItem, 'group'>, group: string, [price, change, close, closeChange]: Vals): WatchItem => ({ ...base, group, price, change, close, closeChange });
const market = (group: string) => ([code, ...rest]: Row) => item(marketWatchItem(MARKET_BY_CODE[code]), group, rest);

export const DUMMY_WATCHLIST: Watchlist = {
  groups: [DISCOVER_GROUP, '해외 지수', '반도체'],
  items: [...DISCOVER.map(market(DISCOVER_GROUP)), ...WORLD.map(market('해외 지수')), ...STOCKS.map(({ row, ...s }) => item(s, '반도체', row))],
  quotedAt: null,
};
