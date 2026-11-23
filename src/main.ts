import './style.css';
import { DummyProvider } from './data/dummy';
import { loadPortfolio, type PortfolioData } from './data/provider';
import {
  CASH_GROUP,
  computeHoldings,
  computeSnapshots,
  groupHoldings,
  periodStats,
  rebasedReturns,
  summarizeDividends,
  type PeriodStats,
} from './domain/portfolio';
import { lastYearRange, presetRange, previousRange, PRESETS, type DateRange, type Preset } from './domain/period';
import type { DailySnapshot, GroupDimension } from './types';
import { arrow, escapeHtml, number, pct, pctSigned, tone, won, wonSigned } from './format';
import { applyChartDefaults, renderCompare, renderDividends, renderDonut, renderTrend, token, type AnyChart, type ReturnMode, type TrendCharts } from './ui/charts';

// ─── 상태 ────────────────────────────────────────────────────

interface State {
  accountKey: string; // 'ALL' 또는 계좌 id
  preset: Preset | null;
  rangeA: DateRange;
  compare: boolean;
  rangeB: DateRange;
  mode: ReturnMode;
  groupDim: GroupDimension;
}

const GROUP_DIMS: { id: GroupDimension; label: string }[] = [
  { id: 'assetClass', label: '자산유형' },
  { id: 'region', label: '지역' },
  { id: 'sector', label: '섹터' },
  { id: 'account', label: '계좌' },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let data: PortfolioData;
let state: State;
let snaps: DailySnapshot[] = [];
let charts: { trend?: TrendCharts; compare?: AnyChart; donut?: AnyChart; div?: AnyChart } = {};
let groupColorOrder: Record<GroupDimension, string[]>;

const accountIds = () => (state.accountKey === 'ALL' ? data.accounts.map((a) => a.id) : [state.accountKey]);
const accountName = (id: string) => data.accounts.find((a) => a.id === id)?.name ?? id;
const lastDate = () => data.fx.dates.at(-1)!;
const firstActiveDate = () => snaps.find((s) => s.principal > 0)?.date ?? data.fx.dates[0];
const selectedTxs = () => {
  const ids = new Set(accountIds());
  return data.transactions.filter((t) => ids.has(t.accountId));
};

// ─── 시작 ────────────────────────────────────────────────────

async function main() {
  restoreTheme();
  data = await loadPortfolio(new DummyProvider());

  // 색은 그룹(엔티티)에 고정: 필터를 바꿔도 같은 그룹은 같은 색
  const all = computeHoldings(data, data.accounts.map((a) => a.id));
  groupColorOrder = Object.fromEntries(
    GROUP_DIMS.map(({ id }) => [id, groupHoldings(all, id, accountName).map((r) => r.key).filter((k) => k !== CASH_GROUP)]),
  ) as Record<GroupDimension, string[]>;

  state = {
    accountKey: 'ALL',
    preset: '1Y',
    rangeA: { start: data.fx.dates[0], end: lastDate() },
    compare: false,
    rangeB: { start: data.fx.dates[0], end: lastDate() },
    mode: 'simple',
    groupDim: 'assetClass',
  };

  $('source-badge').textContent = data.provider === 'dummy' ? '더미 데이터' : '마이데이터';
  $('asof').textContent = `${lastDate()} 종가 기준 · 계좌 ${data.accounts.length}개`;

  buildControls();
  recomputeAccount();
  applyPreset('1Y');

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderAll);
}

function recomputeAccount() {
  snaps = computeSnapshots(data, accountIds());
}

// ─── 컨트롤 ──────────────────────────────────────────────────

function segButtons(container: HTMLElement, items: { id: string; label: string }[], onClick: (id: string) => void) {
  container.innerHTML = items.map((i) => `<button type="button" data-id="${escapeHtml(i.id)}">${escapeHtml(i.label)}</button>`).join('');
  container.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b?.dataset.id) onClick(b.dataset.id);
  });
}

function pressed(container: HTMLElement, id: string | null, attr = 'id') {
  container.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === id)));
}

function buildControls() {
  segButtons($('account-seg'), [{ id: 'ALL', label: '전체 계좌' }, ...data.accounts.map((a) => ({ id: a.id, label: `${a.name}` }))], (id) => {
    state.accountKey = id;
    recomputeAccount();
    if (state.preset) applyPreset(state.preset);
    else renderAll();
  });

  segButtons($('preset-seg'), PRESETS, (id) => applyPreset(id as Preset));
  segButtons($('group-seg'), GROUP_DIMS, (id) => {
    state.groupDim = id as GroupDimension;
    renderAllocation();
  });

  $('return-mode').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b?.dataset.mode) return;
    state.mode = b.dataset.mode as ReturnMode;
    renderTrendSection();
  });

  const onDate = () => {
    const a = { start: $<HTMLInputElement>('a-start').value, end: $<HTMLInputElement>('a-end').value };
    if (a.start && a.end && a.start <= a.end) {
      state.rangeA = a;
      state.preset = null;
    }
    const b = { start: $<HTMLInputElement>('b-start').value, end: $<HTMLInputElement>('b-end').value };
    if (b.start && b.end && b.start <= b.end) state.rangeB = b;
    renderAll();
  };
  for (const id of ['a-start', 'a-end', 'b-start', 'b-end']) $(id).addEventListener('change', onDate);

  $<HTMLInputElement>('compare-toggle').addEventListener('change', (e) => {
    state.compare = (e.target as HTMLInputElement).checked;
    if (state.compare) state.rangeB = previousRange(state.rangeA);
    renderTrendSection();
  });
  $('b-prev').addEventListener('click', () => {
    state.rangeB = previousRange(state.rangeA);
    renderTrendSection();
  });
  $('b-lastyear').addEventListener('click', () => {
    state.rangeB = lastYearRange(state.rangeA);
    renderTrendSection();
  });

  $('theme-toggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* 저장 불가 환경은 무시 */
    }
    renderAll();
  });
}

function restoreTheme() {
  try {
    const t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch {
    /* 무시 */
  }
}

function applyPreset(p: Preset) {
  state.preset = p;
  state.rangeA = presetRange(p, firstActiveDate(), lastDate());
  if (state.compare) state.rangeB = previousRange(state.rangeA);
  renderAll();
}

// ─── 렌더링 ──────────────────────────────────────────────────

function renderAll() {
  applyChartDefaults();
  pressed($('account-seg'), state.accountKey);
  renderKpis();
  renderTrendSection();
  renderAllocation();
  renderDividendSection();
  renderHoldings();
}

function signed(n: number, text: string) {
  return `<span class="${tone(n)}">${arrow(n)} ${text}</span>`;
}

function renderKpis() {
  const last = snaps.at(-1)!;
  const prev = snaps.at(-2) ?? last;
  const dayChange = last.value - prev.value - last.netFlow;
  const days = Math.max(1, (Date.parse(last.date) - Date.parse(firstActiveDate())) / 86_400_000);
  const annual = Math.pow(1 + last.twr, 365 / days) - 1;
  const div = summarizeDividends(selectedTxs(), last.date);
  const deposits = selectedTxs().filter((t) => t.type === 'DEPOSIT').length;

  const tiles = [
    { label: '총 평가금', value: won(last.value), delta: `전일 대비 ${signed(dayChange, wonSigned(dayChange))}` },
    { label: '투자 원금', value: won(last.principal), delta: `입금 ${deposits}회 · ${firstActiveDate()}부터` },
    { label: '수익금', value: `<span class="${tone(last.profit)}">${wonSigned(last.profit)}</span>`, delta: `단순 수익률 ${signed(last.simpleReturn, pctSigned(last.simpleReturn))}` },
    { label: '시간가중수익률 (TWR)', value: `<span class="${tone(last.twr)}">${pctSigned(last.twr)}</span>`, delta: `연환산 ${pctSigned(annual)}` },
    { label: '최근 12개월 배당', value: won(div.trailing12m), delta: `평가금 대비 ${pct(div.trailing12m / last.value)}` },
  ];
  $('kpis').innerHTML = tiles
    .map((t) => `<div class="kpi"><div class="label">${t.label}</div><div class="value">${t.value}</div><div class="delta">${t.delta}</div></div>`)
    .join('');
}

function renderTrendSection() {
  const { rangeA, rangeB, compare, mode } = state;
  pressed($('preset-seg'), state.preset);
  pressed($('return-mode'), mode, 'mode');
  const min = firstActiveDate();
  const max = lastDate();
  for (const id of ['a-start', 'a-end', 'b-start', 'b-end']) {
    const el = $<HTMLInputElement>(id);
    el.min = id.startsWith('a') ? min : data.fx.dates[0];
    el.max = max;
  }
  $<HTMLInputElement>('a-start').value = rangeA.start;
  $<HTMLInputElement>('a-end').value = rangeA.end;
  $<HTMLInputElement>('b-start').value = rangeB.start;
  $<HTMLInputElement>('b-end').value = rangeB.end;
  $('compare-row').hidden = !compare;
  $('compare-panel').hidden = !compare;

  $('trend-legend').innerHTML = [
    `<span class="item"><span class="swatch line" style="background:${token('--value-line')}"></span>평가금</span>`,
    `<span class="item"><span class="swatch" style="background:${token('--principal-fill')};border:2px solid ${token('--principal')}"></span>원금</span>`,
    `<span class="item"><span class="swatch" style="background:${token('--up-fill')}"></span>수익금 (+)</span>`,
    `<span class="item"><span class="swatch" style="background:${token('--down-fill')}"></span>손실 (−)</span>`,
    `<span class="item"><span class="swatch line" style="background:${token('--text-secondary')}"></span>${mode === 'twr' ? '시간가중수익률' : '단순 수익률'} (아래)</span>`,
  ].join('');

  const inA = snaps.filter((s) => s.date >= rangeA.start && s.date <= rangeA.end);
  charts.trend = renderTrend($<HTMLCanvasElement>('value-chart'), $<HTMLCanvasElement>('return-chart'), inA, mode, charts.trend);

  const txs = selectedTxs();
  const a = periodStats(snaps, txs, rangeA.start, rangeA.end);
  if (!compare) {
    $('period-stats').innerHTML = statsStrip(a);
    charts.compare?.destroy();
    charts.compare = undefined;
    return;
  }
  const b = periodStats(snaps, txs, rangeB.start, rangeB.end);
  $('period-stats').innerHTML = compareTable(a, b);
  $('compare-legend').innerHTML = [
    `<span class="item"><span class="swatch line" style="background:${token('--series-1')}"></span>기간 A ${rangeA.start} ~ ${rangeA.end}</span>`,
    `<span class="item"><span class="swatch line" style="background:${token('--series-2')}"></span>기간 B ${rangeB.start} ~ ${rangeB.end}</span>`,
  ].join('');
  charts.compare = renderCompare(
    $<HTMLCanvasElement>('compare-chart'),
    rebasedReturns(snaps, rangeA.start, rangeA.end),
    rebasedReturns(snaps, rangeB.start, rangeB.end),
    charts.compare,
  );
}

function statsStrip(s: PeriodStats) {
  const cells = [
    { label: '기간 수익금', value: signed(s.periodProfit, wonSigned(s.periodProfit)) },
    { label: '기간 수익률 (TWR)', value: signed(s.twr, pctSigned(s.twr)) },
    { label: '기간 순입금', value: wonSigned(s.netFlow) },
    { label: '기간 배당', value: won(s.dividends) },
    { label: '평가금 변화', value: `${won(s.startValue)} → ${won(s.endValue)}` },
  ];
  return `<div class="stats">${cells.map((c) => `<div><div class="label">${c.label}</div><div class="value">${c.value}</div></div>`).join('')}</div>`;
}

function compareTable(a: PeriodStats, b: PeriodStats) {
  const rows: { label: string; a: number; b: number; fmt: (n: number) => string; colored?: boolean; diff?: (a: number, b: number) => string }[] = [
    { label: '기간 수익금', a: a.periodProfit, b: b.periodProfit, fmt: wonSigned, colored: true },
    { label: '기간 수익률 (TWR)', a: a.twr, b: b.twr, fmt: pctSigned, colored: true, diff: (x, y) => `${((x - y) * 100 > 0 ? '+' : '')}${((x - y) * 100).toFixed(2)}%p` },
    { label: '기간 순입금', a: a.netFlow, b: b.netFlow, fmt: wonSigned },
    { label: '기간 배당', a: a.dividends, b: b.dividends, fmt: won },
    { label: '시작 원금', a: a.startPrincipal, b: b.startPrincipal, fmt: won },
    { label: '종료 원금', a: a.endPrincipal, b: b.endPrincipal, fmt: won },
    { label: '시작 평가금', a: a.startValue, b: b.startValue, fmt: won },
    { label: '종료 평가금', a: a.endValue, b: b.endValue, fmt: won },
  ];
  const cell = (n: number, r: (typeof rows)[number]) => (r.colored ? signed(n, r.fmt(n)) : r.fmt(n));
  return `<div class="table-wrap" style="margin-top:14px"><table class="data">
    <thead><tr><th>항목</th><th><span class="tag tag-a">기간 A</span><br>${a.start} ~ ${a.end}</th><th><span class="tag tag-b">기간 B</span><br>${b.start} ~ ${b.end}</th><th>차이 (A − B)</th></tr></thead>
    <tbody>${rows
      .map((r) => `<tr><td>${r.label}</td><td>${cell(r.a, r)}</td><td>${cell(r.b, r)}</td><td>${r.diff ? r.diff(r.a, r.b) : wonSigned(r.a - r.b)}</td></tr>`)
      .join('')}</tbody></table></div>`;
}

function groupColor(key: string) {
  if (key === CASH_GROUP) return token('--series-cash');
  const i = groupColorOrder[state.groupDim].indexOf(key);
  return i >= 0 && i < 8 ? token(`--series-${i + 1}`) : token('--series-cash');
}

function renderAllocation() {
  pressed($('group-seg'), state.groupDim);
  const res = computeHoldings(data, accountIds());
  const rows = groupHoldings(res, state.groupDim, accountName);
  const colors = rows.map((r) => groupColor(r.key));
  charts.donut = renderDonut($<HTMLCanvasElement>('alloc-chart'), rows.map((r) => r.key), rows.map((r) => r.value), colors, charts.donut);

  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const totalProfit = res.totalValue - totalCost;
  $('group-table').innerHTML = `<thead><tr><th>그룹</th><th>비중</th><th>평가금</th><th title="보유 중인 종목의 평가금 − 매입원가 (실현손익 · 배당 제외)">평가손익</th><th>수익률</th></tr></thead>
    <tbody>${rows
      .map(
        (r, i) => `<tr><td><span class="name"><span class="swatch" style="background:${colors[i]}"></span>${escapeHtml(r.key)}${r.count ? `<span class="code">${r.count}종목</span>` : ''}</span></td>
        <td>${pct(r.weight, 1)}</td><td>${won(r.value)}</td>
        <td>${r.key === CASH_GROUP ? '-' : signed(r.profit, wonSigned(r.profit))}</td>
        <td>${r.key === CASH_GROUP ? '-' : signed(r.returnRate, pctSigned(r.returnRate))}</td></tr>`,
      )
      .join('')}</tbody>
    <tfoot><tr><td>합계</td><td>100%</td><td>${won(res.totalValue)}</td><td>${signed(totalProfit, wonSigned(totalProfit))}</td><td></td></tr></tfoot>`;
}

function renderDividendSection() {
  const txs = selectedTxs();
  const sum = summarizeDividends(txs, lastDate());
  const { rangeA } = state;
  const inRange = (m: string) => m >= rangeA.start.slice(0, 7) && m <= rangeA.end.slice(0, 7);
  const periodTotal = txs.filter((t) => t.type === 'DIVIDEND' && t.date >= rangeA.start && t.date <= rangeA.end).reduce((s, t) => s + t.amountKRW, 0);

  $('div-kpis').innerHTML = [
    ...sum.byYear.map((y) => ({ label: `${y.year}년`, value: won(y.amount) })),
    { label: '선택 기간', value: won(periodTotal) },
  ]
    .map((k) => `<div><div class="label">${k.label}</div><div class="value">${k.value}</div></div>`)
    .join('');

  // 빈 달도 0 으로 채워 시간축을 고르게
  const months: string[] = [];
  const first = sum.byMonth[0]?.month ?? lastDate().slice(0, 7);
  for (let d = new Date(`${first}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= lastDate().slice(0, 7); d.setUTCMonth(d.getUTCMonth() + 1)) {
    months.push(d.toISOString().slice(0, 7));
  }
  const byMonth = new Map(sum.byMonth.map((m) => [m.month, m.amount]));
  charts.div = renderDividends($<HTMLCanvasElement>('div-chart'), months, months.map((m) => byMonth.get(m) ?? 0), inRange, charts.div);

  const names = new Map(data.instruments.map((i) => [i.code, i.name]));
  const top = sum.byInstrument.slice(0, 6);
  const total = sum.byInstrument.reduce((s, r) => s + r.amount, 0) || 1;
  $('div-table').innerHTML = `<thead><tr><th>종목 (누적 상위)</th><th>횟수</th><th>누적 배당</th><th>비중</th></tr></thead>
    <tbody>${top
      .map(
        (r) => `<tr><td>${escapeHtml(names.get(r.code) ?? r.code)}<span class="code">${escapeHtml(r.code)}</span></td><td>${r.count}</td><td>${won(r.amount)}</td>
        <td>${pct(r.amount / total, 1)}<span class="bar-cell"><span style="width:${(r.amount / top[0].amount) * 100}%"></span></span></td></tr>`,
      )
      .join('')}</tbody>`;
}

function renderHoldings() {
  const res = computeHoldings(data, accountIds());
  const multi = accountIds().length > 1;
  const max = res.holdings[0]?.valueKRW ?? 1;
  $('hold-count').textContent = `${res.holdings.length}개 종목 · 현금 ${won(Object.values(res.cashByAccount).reduce((a, b) => a + b, 0))}`;
  $('hold-table').innerHTML = `<thead><tr><th>종목</th>${multi ? '<th class="left">계좌</th>' : ''}<th class="left">유형</th><th>수량</th><th>평균단가</th><th>현재가</th><th>평가금</th><th>평가손익</th><th>수익률</th><th>비중</th></tr></thead>
    <tbody>${res.holdings
      .map((h) => {
        const usd = h.instrument.currency === 'USD';
        const w = h.valueKRW / res.totalValue;
        return `<tr>
          <td>${escapeHtml(h.instrument.name)}<span class="code">${escapeHtml(h.instrument.code)}</span></td>
          ${multi ? `<td class="left"><span class="chip">${escapeHtml(accountName(h.accountId))}</span></td>` : ''}
          <td class="left"><span class="chip">${escapeHtml(h.instrument.assetClass)}</span></td>
          <td>${number(h.quantity)}</td>
          <td>${won(h.avgCostKRW)}</td>
          <td>${usd ? `$${h.price.toFixed(2)}` : won(h.price)}</td>
          <td>${won(h.valueKRW)}</td>
          <td>${signed(h.profitKRW, wonSigned(h.profitKRW))}</td>
          <td>${signed(h.returnRate, pctSigned(h.returnRate))}</td>
          <td>${pct(w, 1)}<span class="bar-cell"><span style="width:${(h.valueKRW / max) * 100}%"></span></span></td>
        </tr>`;
      })
      .join('')}</tbody>`;
}

main().catch((e) => {
  console.error(e);
  document.getElementById('app')!.insertAdjacentHTML('afterbegin', `<p class="card">데이터를 불러오지 못했습니다: ${escapeHtml(String(e))}</p>`);
});
