// 보유 종목 표의 컬럼 표시 · 순서 (이 브라우저에 저장)
//  - '종목' 열은 항상 맨 앞, 수정 · 삭제 버튼 열은 항상 맨 뒤
//  - 새 컬럼이 생기면 기본 위치에 끼워 넣는다

export const HOLD_COLUMN_IDS = ['account', 'group', 'quantity', 'avg', 'price', 'change', 'close', 'closeChange', 'value', 'pnl', 'rate', 'weight'] as const;
export type HoldColumn = (typeof HOLD_COLUMN_IDS)[number];

export interface ColumnDef {
  id: HoldColumn;
  label: string;
  /** 글자 왼쪽 정렬 */
  left?: boolean;
  /** 설정 창에 보일 설명 */
  note?: string;
}

/** 기본 순서 */
export const HOLD_COLUMNS: ColumnDef[] = [
  { id: 'account', label: '계좌', left: true, note: '전체 계좌를 볼 때만' },
  { id: 'group', label: '그룹', left: true },
  { id: 'quantity', label: '수량' },
  { id: 'avg', label: '평균단가' },
  { id: 'price', label: '현재가' },
  { id: 'change', label: '등락률', note: '현재가의 전일 대비 · 동기화 때 받음' },
  { id: 'close', label: '종가', note: '마지막으로 끝난 정규장 종가' },
  { id: 'closeChange', label: '종가 등락률', note: '그 종가의 전일 대비' },
  { id: 'value', label: '평가금' },
  { id: 'pnl', label: '평가손익' },
  { id: 'rate', label: '수익률' },
  { id: 'weight', label: '비중' },
];

export interface ColumnPrefs {
  order: HoldColumn[];
  hidden: HoldColumn[];
}

const KEY = 'stock-dashboard:hold-columns:v1';
const ALL: HoldColumn[] = [...HOLD_COLUMN_IDS];

export const defaultPrefs = (): ColumnPrefs => ({ order: [...ALL], hidden: [] });

/** 저장된 값을 정리: 모르는 컬럼은 빼고, 없는 컬럼은 기본 위치(앞 컬럼 바로 뒤)에 넣는다 */
export function normalizePrefs(raw: Partial<ColumnPrefs> | null | undefined): ColumnPrefs {
  const order = (raw?.order ?? []).filter((c): c is HoldColumn => ALL.includes(c as HoldColumn));
  const uniq = [...new Set(order)];
  for (const [i, c] of ALL.entries()) {
    if (uniq.includes(c)) continue;
    const before = ALL.slice(0, i).reverse().find((p) => uniq.includes(p));
    uniq.splice(before ? uniq.indexOf(before) + 1 : 0, 0, c);
  }
  const hidden = [...new Set((raw?.hidden ?? []).filter((c): c is HoldColumn => ALL.includes(c as HoldColumn)))];
  return { order: uniq, hidden };
}

export function loadPrefs(): ColumnPrefs {
  try {
    return normalizePrefs(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return defaultPrefs();
  }
}

export function savePrefs(p: ColumnPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 이번 화면에서만 */
  }
}

export function moveColumn(p: ColumnPrefs, id: HoldColumn, to: number): ColumnPrefs {
  const order = p.order.filter((c) => c !== id);
  order.splice(Math.max(0, Math.min(order.length, to)), 0, id);
  return { ...p, order };
}

export function toggleColumn(p: ColumnPrefs, id: HoldColumn, show: boolean): ColumnPrefs {
  const hidden = p.hidden.filter((c) => c !== id);
  if (!show) hidden.push(id);
  return { ...p, hidden };
}

export const visibleColumns = (p: ColumnPrefs): HoldColumn[] => p.order.filter((c) => !p.hidden.includes(c));
