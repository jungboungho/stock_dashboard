const won0 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 });
const num2 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });

export const won = (n: number) => `${won0.format(Math.round(n))}원`;
export const wonSigned = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${won0.format(Math.abs(Math.round(n)))}원`;
export const wonCompact = (n: number) => compact.format(Math.round(n));
export const number = (n: number) => num2.format(n);
export const pct = (r: number, digits = 2) => `${(r * 100).toFixed(digits)}%`;
export const pctSigned = (r: number, digits = 2) => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r * 100).toFixed(digits)}%`;

/** 한국 증시 관례: 상승 = 빨강(▲), 하락 = 파랑(▼). 색만으로 구분하지 않도록 기호를 함께 붙인다 */
export const tone = (n: number) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
export const arrow = (n: number) => (n > 0 ? '▲' : n < 0 ? '▼' : '');

export const shortDate = (iso: string) => `${iso.slice(2, 4)}.${iso.slice(5, 7)}.${iso.slice(8, 10)}`;
export const monthLabel = (ym: string) => `${ym.slice(2, 4)}.${ym.slice(5, 7)}`;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
