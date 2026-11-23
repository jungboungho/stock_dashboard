import './style.css';
import { DummyProvider } from './data/dummy';
import { loadPortfolio } from './data/provider';
import { makeDummyModel } from './data/dummyModel';
import { makeExcelModel } from './data/excelModel';
import { parseStockBook, type ExcelBook } from './data/excel/parse';
import { readWorkbook } from './data/excel/xlsx';
import type { DashboardData, Position } from './data/model';
import { periodStats, rebasedReturns, summarizeDividends, type PeriodStats } from './domain/portfolio';
import { lastYearRange, presetRange, previousRange, PRESETS, type DateRange, type Preset } from './domain/period';
import {
  addManualStock,
  aggregateByKey,
  applyStore,
  assignStock,
  CASH_ID,
  createGroup,
  customGroupRows,
  deleteGroup,
  deleteManualStock,
  loadStore,
  moveGroup,
  renameGroup,
  saveStore,
  seedStore,
  setPrice,
  UNGROUPED,
  UNGROUPED_ID,
  updateManualStock,
  type CustomGroupRow,
  type GroupStore,
  type MemberRow,
} from './domain/groups';
import { yearlyReturns } from './domain/yearly';
import type { Currency, DailySnapshot } from './types';
import { arrow, escapeHtml, number, pct, pctSigned, tone, won, wonShort, wonSigned } from './format';
import {
  applyChartDefaults,
  renderCompare,
  renderDividends,
  renderDonut,
  renderTrend,
  renderYtd,
  token,
  type AnyChart,
  type ReturnMode,
  type TrendCharts,
} from './ui/charts';
import { openConfirm, openForm, parseNumber } from './ui/dialog';

// ─── 상태 ────────────────────────────────────────────────────

const EXCEL_KEY = 'stock-dashboard:excel:v1';
const SOURCE_KEY = 'stock-dashboard:source';
const CUSTOM = 'custom';

interface State {
  accountKey: string;
  preset: Preset | null;
  rangeA: DateRange;
  compare: boolean;
  rangeB: DateRange;
  mode: ReturnMode;
  groupDim: string;
  selectedGroup: string | null;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let dummyModel: DashboardData;
let excelBook: ExcelBook | null = null;
let model: DashboardData;
let store: GroupStore;
let state: State;
let snaps: DailySnapshot[] = [];
let dimColorOrder: Record<string, string[]> = {};
const charts: { trend?: TrendCharts; compare?: AnyChart; donut?: AnyChart; div?: AnyChart; ytd?: AnyChart } = {};

const allIds = () => model.accounts.map((a) => a.id);
const accountIds = () => (state.accountKey === 'ALL' ? allIds() : [state.accountKey]);
const accountName = (id: string) => model.accounts.find((a) => a.id === id)?.name ?? id;
const lastDate = () => snaps.at(-1)?.date ?? model.asOf;
const firstActiveDate = () => snaps.find((s) => s.principal > 0)?.date ?? snaps[0]?.date ?? model.asOf;
const cashTotal = () => Object.values(model.cash(accountIds())).reduce((a, b) => a + b, 0);
const dividends = () => model.dividends(accountIds());

/** 원본 종목 + 직접 추가 종목 (계좌 하나만 볼 때는 직접 추가 종목 제외) */
function positions(): Position[] {
  const ps = applyStore(model.positions(accountIds()), store, model.usdKrw);
  return state.accountKey === 'ALL' ? ps : ps.filter((p) => !p.manual);
}

function persist() {
  saveStore(model.source, store);
}

// ─── 시작 ────────────────────────────────────────────────────

async function main() {
  restoreTheme();
  dummyModel = makeDummyModel(await loadPortfolio(new DummyProvider()));
  excelBook = loadExcel();
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(SOURCE_KEY);
  } catch {
    /* 무시 */
  }
  buildControls();
  setSource(excelBook && saved !== 'dummy' ? 'excel' : 'dummy');
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderAll);
}

function loadExcel(): ExcelBook | null {
  try {
    const raw = localStorage.getItem(EXCEL_KEY);
    const book = raw ? (JSON.parse(raw) as ExcelBook) : null;
    return book?.version === 1 ? book : null;
  } catch {
    return null;
  }
}

function setSource(src: 'dummy' | 'excel') {
  model = src === 'excel' && excelBook ? makeExcelModel(excelBook) : dummyModel;
  try {
    localStorage.setItem(SOURCE_KEY, model.source);
  } catch {
    /* 무시 */
  }
  const all = model.positions(model.accounts.map((a) => a.id));
  store = loadStore(model.source) ?? seedStore(all, model.defaultGroups);
  persist();

  // 기본 그룹 기준의 색 순서를 전체 계좌 기준으로 고정 (필터를 바꿔도 같은 그룹은 같은 색)
  dimColorOrder = {};
  for (const d of model.dimensions) {
    const totals = new Map<string, number>();
    for (const p of all) {
      const k = dimKey(p, d.id);
      totals.set(k, (totals.get(k) ?? 0) + p.valueKRW);
    }
    dimColorOrder[d.id] = [...totals].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }

  state = {
    accountKey: 'ALL',
    preset: '1Y',
    rangeA: { start: model.asOf, end: model.asOf },
    compare: false,
    rangeB: { start: model.asOf, end: model.asOf },
    mode: 'simple',
    groupDim: CUSTOM,
    selectedGroup: null,
  };
  $<HTMLInputElement>('compare-toggle').checked = false;
  buildSourceControls();
  recomputeAccount();
  applyPreset(model.source === 'excel' ? 'ALL' : '1Y');
}

function recomputeAccount() {
  snaps = model.snapshots(accountIds());
}

// ─── 컨트롤 ──────────────────────────────────────────────────

function segButtons(container: HTMLElement, items: { id: string; label: string }[], onClick: (id: string) => void) {
  container.innerHTML = items.map((i) => `<button type="button" data-id="${escapeHtml(i.id)}">${escapeHtml(i.label)}</button>`).join('');
  container.onclick = (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b?.dataset.id) onClick(b.dataset.id);
  };
}

function pressed(container: HTMLElement, id: string | null, attr = 'id') {
  container.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === id)));
}

function buildControls() {
  segButtons($('preset-seg'), PRESETS, (id) => applyPreset(id as Preset));

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
      /* 무시 */
    }
    renderAll();
  });

  $<HTMLInputElement>('excel-input').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const label = $('excel-label');
    label.textContent = '읽는 중…';
    try {
      const book = parseStockBook(readWorkbook(new Uint8Array(await file.arrayBuffer())), file.name);
      excelBook = book;
      try {
        localStorage.setItem(EXCEL_KEY, JSON.stringify(book));
      } catch {
        showNote('브라우저 저장 공간에 저장하지 못해 새로고침하면 다시 가져와야 합니다.');
      }
      setSource('excel');
    } catch (ex) {
      showNote(`엑셀을 읽지 못했습니다: ${ex instanceof Error ? ex.message : String(ex)}`, true);
    } finally {
      label.textContent = excelBook ? '엑셀 다시 가져오기' : '엑셀 가져오기';
    }
  });

  // 그룹 도구
  $('group-add').addEventListener('click', () => dialogNewGroup());
  $('stock-add').addEventListener('click', () => dialogManualStock(null));

  // 그룹 표 줄 클릭 → 상세 펼치기
  $('group-table').addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-group]');
    if (!tr) return;
    const id = tr.dataset.group!;
    state.selectedGroup = state.selectedGroup === id ? null : id;
    renderAllocation();
  });
  $('group-table').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).matches('tr[data-group]')) {
      e.preventDefault();
      (e.target as HTMLElement).click();
    }
  });

  // 상세 · 보유종목 표의 버튼들 (이벤트 위임)
  document.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (!b) return;
    const { act, key, group } = b.dataset;
    if (act === 'edit-stock' && key) dialogEditStock(key);
    if (act === 'ungroup' && key) mutate(() => assignStock(store, key, null));
    if (act === 'delete-stock' && key) confirmDeleteStock(key);
    if (act === 'rename-group' && group) dialogRenameGroup(group);
    if (act === 'delete-group' && group) confirmDeleteGroup(group);
    if (act === 'up-group' && group) mutate(() => moveGroup(store, group, -1));
    if (act === 'down-group' && group) mutate(() => moveGroup(store, group, 1));
    if (act === 'add-to-group' && group) dialogAddToGroup(group);
    if (act === 'new-stock-in-group' && group) dialogManualStock(group);
    if (act === 'clear-excel') confirmClearExcel();
  });
}

function buildSourceControls() {
  const seg = $('source-seg');
  seg.hidden = !excelBook;
  if (excelBook) {
    segButtons(
      seg,
      [
        { id: 'excel', label: '내 엑셀' },
        { id: 'dummy', label: '더미' },
      ],
      (id) => setSource(id as 'dummy' | 'excel'),
    );
    pressed(seg, model.source);
  }
  $('excel-label').textContent = excelBook ? '엑셀 다시 가져오기' : '엑셀 가져오기';

  const accSeg = $('account-seg');
  accSeg.hidden = !model.accountFilter;
  if (model.accountFilter) {
    segButtons(accSeg, [{ id: 'ALL', label: '전체 계좌' }, ...model.accounts.map((a) => ({ id: a.id, label: a.name }))], (id) => {
      state.accountKey = id;
      state.selectedGroup = null;
      recomputeAccount();
      if (state.preset) applyPreset(state.preset);
      else renderAll();
    });
  }
  const chips = $('account-chips');
  const withPrincipal = model.accounts.filter((a) => a.principal !== undefined);
  chips.innerHTML =
    !model.accountFilter && withPrincipal.length
      ? `<span class="hint">계좌별 투자 원금</span>${withPrincipal
          .map((a) => `<span class="chip lg">${escapeHtml(a.name)} <b class="num">${wonShort(a.principal!)}</b></span>`)
          .join('')}`
      : '';

  if (model.source === 'excel' && excelBook) {
    showNote(
      `'${escapeHtml(excelBook.fileName)}' 데이터 (${excelBook.importedAt.slice(0, 10)} 가져옴). 이 브라우저에만 저장되며 어디에도 전송되지 않습니다. ` +
        `<button type="button" class="link" data-act="clear-excel">이 브라우저에서 지우기</button>`,
      false,
      true,
    );
  } else {
    showNote('가상 데이터입니다. 오른쪽 위 "엑셀 가져오기"로 내 엑셀(주식.xlsx)을 불러오면 실제 값으로 바뀝니다 — 파일은 브라우저 안에서만 읽습니다.', false);
  }

  $('foot').textContent =
    model.source === 'excel'
      ? '엑셀에 현재가가 없어 보유 종목은 매입가 기준입니다. 종목의 ✎ 버튼으로 현재가를 입력하면 비중 · 손익에 반영됩니다.'
      : '가상 데이터입니다. 종목 이름만 실제이고 가격 · 거래 · 배당은 모두 임의로 생성했습니다. 투자 판단의 근거로 쓰지 마세요.';
}

function showNote(html: string, error = false, raw = false) {
  const el = $('source-note');
  el.hidden = false;
  el.classList.toggle('error', error);
  if (raw) el.innerHTML = html;
  else el.textContent = html;
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

/** 그룹 · 종목 변경 공통 처리: 저장 후 다시 그림 */
function mutate(fn: () => GroupStore) {
  store = fn();
  persist();
  renderAllocation();
  renderHoldings();
}

// ─── 렌더링 ──────────────────────────────────────────────────

function renderAll() {
  applyChartDefaults();
  pressed($('account-seg'), state.accountKey);
  renderKpis();
  renderTrendSection();
  renderYearly();
  renderAllocation();
  renderDividendSection();
  renderHoldings();
}

function signed(n: number, text: string) {
  return `<span class="${tone(n)}">${arrow(n)} ${text}</span>`;
}

function renderKpis() {
  const last = snaps.at(-1);
  if (!last) {
    $('kpis').innerHTML = '<div class="kpi">데이터가 없습니다</div>';
    return;
  }
  const prev = snaps.at(-2) ?? last;
  const change = last.value - prev.value - last.netFlow;
  const days = Math.max(1, (Date.parse(last.date) - Date.parse(firstActiveDate())) / 86_400_000);
  const annual = Math.pow(1 + last.twr, 365 / days) - 1;
  const years = yearlyReturns(snaps, state.accountKey === 'ALL' ? model.yearStarts : undefined, model.asOf);
  const thisYear = years.at(-1);
  const monthly = model.source === 'excel';

  const tiles = [
    { label: monthly ? '총자산' : '총 평가금', value: won(last.value), delta: `${monthly ? '전월' : '전일'} 대비 ${signed(change, wonSigned(change))}` },
    { label: '투자 원금', value: won(last.principal), delta: `${firstActiveDate()}부터` },
    { label: '수익금', value: `<span class="${tone(last.profit)}">${wonSigned(last.profit)}</span>`, delta: `단순 수익률 ${signed(last.simpleReturn, pctSigned(last.simpleReturn))}` },
    { label: '시간가중수익률 (TWR)', value: `<span class="${tone(last.twr)}">${pctSigned(last.twr)}</span>`, delta: `연환산 ${pctSigned(annual)}` },
  ];
  if (thisYear) {
    tiles.push({
      label: `${thisYear.year}년 연초대비`,
      value: `<span class="${tone(thisYear.returnRate)}">${pctSigned(thisYear.returnRate)}</span>`,
      delta: model.goal !== null ? `목표 ${pct(model.goal, 0)} 대비 ${pctSigned(thisYear.returnRate - model.goal).replace('%', '%p')}` : `손익 ${wonSigned(thisYear.profit)}`,
    });
  }
  if (model.hasDividends) {
    const div = summarizeDividends(dividends(), last.date);
    tiles.push({ label: '최근 12개월 배당', value: won(div.trailing12m), delta: `평가금 대비 ${pct(div.trailing12m / last.value)}` });
  }
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
    el.min = id.startsWith('a') ? min : (snaps[0]?.date ?? min);
    el.max = max;
  }
  $<HTMLInputElement>('a-start').value = rangeA.start;
  $<HTMLInputElement>('a-end').value = rangeA.end;
  $<HTMLInputElement>('b-start').value = rangeB.start;
  $<HTMLInputElement>('b-end').value = rangeB.end;
  $('compare-row').hidden = !compare;
  $('compare-panel').hidden = !compare;

  $('trend-legend').innerHTML = [
    `<span class="item"><span class="swatch line" style="background:${token('--value-line')}"></span>${model.source === 'excel' ? '총자산 (월말)' : '평가금'}</span>`,
    `<span class="item"><span class="swatch" style="background:${token('--principal-fill')};border:2px solid ${token('--principal')}"></span>원금</span>`,
    `<span class="item"><span class="swatch" style="background:${token('--up-fill')}"></span>수익금 (+)</span>`,
    `<span class="item"><span class="swatch" style="background:${token('--down-fill')}"></span>손실 (−)</span>`,
    `<span class="item"><span class="swatch line" style="background:${token('--text-secondary')}"></span>${mode === 'twr' ? '시간가중수익률' : '단순 수익률'} (아래)</span>`,
  ].join('');

  const inA = snaps.filter((s) => s.date >= rangeA.start && s.date <= rangeA.end);
  charts.trend = renderTrend($<HTMLCanvasElement>('value-chart'), $<HTMLCanvasElement>('return-chart'), inA, mode, charts.trend);

  const txs = dividends();
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
    ...(model.hasDividends ? [{ label: '기간 배당', value: won(s.dividends) }] : []),
    { label: '자산 변화', value: `${wonShort(s.startValue)} → ${wonShort(s.endValue)}` },
  ];
  return `<div class="stats" style="--cols:${cells.length}">${cells.map((c) => `<div><div class="label">${c.label}</div><div class="value">${c.value}</div></div>`).join('')}</div>`;
}

function compareTable(a: PeriodStats, b: PeriodStats) {
  const rows: { label: string; a: number; b: number; fmt: (n: number) => string; colored?: boolean; diff?: (a: number, b: number) => string }[] = [
    { label: '기간 수익금', a: a.periodProfit, b: b.periodProfit, fmt: wonSigned, colored: true },
    { label: '기간 수익률 (TWR)', a: a.twr, b: b.twr, fmt: pctSigned, colored: true, diff: (x, y) => `${(x - y) * 100 > 0 ? '+' : ''}${((x - y) * 100).toFixed(2)}%p` },
    { label: '기간 순입금', a: a.netFlow, b: b.netFlow, fmt: wonSigned },
    ...(model.hasDividends ? [{ label: '기간 배당', a: a.dividends, b: b.dividends, fmt: won }] : []),
    { label: '시작 원금', a: a.startPrincipal, b: b.startPrincipal, fmt: won },
    { label: '종료 원금', a: a.endPrincipal, b: b.endPrincipal, fmt: won },
    { label: '시작 자산', a: a.startValue, b: b.startValue, fmt: won },
    { label: '종료 자산', a: a.endValue, b: b.endValue, fmt: won },
  ];
  const cell = (n: number, r: (typeof rows)[number]) => (r.colored ? signed(n, r.fmt(n)) : r.fmt(n));
  return `<div class="table-wrap" style="margin-top:14px"><table class="data">
    <thead><tr><th>항목</th><th><span class="tag tag-a">기간 A</span><br>${a.start} ~ ${a.end}</th><th><span class="tag tag-b">기간 B</span><br>${b.start} ~ ${b.end}</th><th>차이 (A − B)</th></tr></thead>
    <tbody>${rows
      .map((r) => `<tr><td>${r.label}</td><td>${cell(r.a, r)}</td><td>${cell(r.b, r)}</td><td>${r.diff ? r.diff(r.a, r.b) : wonSigned(r.a - r.b)}</td></tr>`)
      .join('')}</tbody></table></div>`;
}

// ─── 연도별 수익률 ───────────────────────────────────────────

function renderYearly() {
  const rows = yearlyReturns(snaps, state.accountKey === 'ALL' ? model.yearStarts : undefined, model.asOf);
  const goal = model.goal;
  const maxAbs = Math.max(0.0001, ...rows.map((r) => Math.abs(r.returnRate)));
  $('year-table').innerHTML = `<thead><tr><th>연도</th><th>연초 자산</th><th>연중 순입금</th><th>연말 자산</th><th>손익</th><th>연초대비 수익률</th>${goal !== null ? '<th>목표 대비</th>' : ''}</tr></thead>
    <tbody>${[...rows]
      .reverse()
      .map(
        (r) => `<tr>
          <td><b>${r.year}</b>${r.inProgress ? ' <span class="chip">진행 중</span>' : ''}</td>
          <td>${wonShort(r.start)}</td>
          <td>${r.flow ? (r.flow > 0 ? '+' : '') + wonShort(r.flow) : '-'}</td>
          <td>${wonShort(r.end)}</td>
          <td>${signed(r.profit, wonShort(r.profit))}</td>
          <td>${signed(r.returnRate, pctSigned(r.returnRate))}<span class="bar-cell"><span class="${tone(r.returnRate)}-bg" style="width:${(Math.abs(r.returnRate) / maxAbs) * 100}%"></span></span></td>
          ${goal !== null ? `<td>${r.returnRate >= goal ? '<span class="chip ok">달성</span>' : `<span class="muted">${((r.returnRate - goal) * 100).toFixed(1)}%p</span>`}</td>` : ''}
        </tr>`,
      )
      .join('')}</tbody>`;

  const withMonths = rows.filter((r) => r.months.length);
  const allYears = rows.map((r) => r.year);
  const colorOf = (y: number) => {
    const i = allYears.indexOf(y);
    return i >= 0 && i < 8 ? token(`--series-${i + 1}`) : token('--series-other');
  };
  const series = withMonths.map((r) => ({ year: r.year, color: colorOf(r.year), points: r.months }));
  $('ytd-legend').innerHTML =
    series.map((s) => `<span class="item"><span class="swatch line" style="background:${s.color}"></span>${s.year}년</span>`).join('') +
    (goal !== null ? `<span class="item"><span class="swatch line dashed"></span>목표 ${pct(goal, 0)}</span>` : '');
  charts.ytd = renderYtd($<HTMLCanvasElement>('ytd-chart'), series, goal, charts.ytd);
  const noMonthly = rows.filter((r) => !r.months.length).map((r) => r.year);
  $('ytd-note').textContent = noMonthly.length ? `${noMonthly.join(', ')}년은 월별 자산 기록이 없어 연간 수익률만 표에 표시합니다.` : '';
}

// ─── 그룹별 비중 ─────────────────────────────────────────────

function dimKey(p: Position, dim: string): string {
  if (dim === 'account') return p.accountId ? accountName(p.accountId) : '직접 추가';
  return p.attrs[dim] ?? '기타';
}

interface AllocRow {
  id: string;
  name: string;
  value: number;
  cost: number;
  profit: number;
  returnRate: number;
  weight: number;
  count: number;
  color: string;
  /** 소속 종목 모두 현재가를 모름 → 손익 표시 안 함 */
  unpriced?: boolean;
}

function customColor(id: string): string {
  if (id === CASH_ID) return token('--series-cash');
  if (id === UNGROUPED_ID) return token('--series-other');
  const i = store.groups.findIndex((g) => g.id === id);
  return i >= 0 && i < 8 ? token(`--series-${i + 1}`) : token('--series-other');
}

function dimensionRows(ps: Position[], dim: string): AllocRow[] {
  const cash = model.cash(accountIds());
  const map = new Map<string, { value: number; cost: number; count: number; priced: number }>();
  const add = (k: string, v: number, c: number, n: number, priced = 0) => {
    const r = map.get(k) ?? { value: 0, cost: 0, count: 0, priced: 0 };
    r.value += v;
    r.cost += c;
    r.count += n;
    r.priced += priced;
    map.set(k, r);
  };
  for (const p of ps) add(dimKey(p, dim), p.valueKRW, p.costKRW, 1, p.price === null ? 0 : 1);
  for (const [id, c] of Object.entries(cash)) if (Math.round(c)) add(dim === 'account' ? accountName(id) : '현금', c, c, 0);
  const total = [...map.values()].reduce((s, r) => s + r.value, 0) || 1;
  const order = dimColorOrder[dim] ?? [];
  return [...map]
    .map(([k, r]) => {
      const i = order.indexOf(k);
      return {
        id: k,
        name: k,
        ...r,
        profit: r.value - r.cost,
        returnRate: r.cost > 0 ? (r.value - r.cost) / r.cost : 0,
        weight: r.value / total,
        unpriced: r.count > 0 && r.priced === 0,
        color: k === '현금' ? token('--series-cash') : i >= 0 && i < 8 ? token(`--series-${i + 1}`) : token('--series-other'),
      };
    })
    .sort((a, b) => b.value - a.value);
}

function renderAllocation() {
  const dims = [{ id: CUSTOM, label: '내 그룹' }, ...model.dimensions];
  if (!dims.some((d) => d.id === state.groupDim)) state.groupDim = CUSTOM;
  segButtons($('group-seg'), dims, (id) => {
    state.groupDim = id;
    state.selectedGroup = null;
    renderAllocation();
  });
  pressed($('group-seg'), state.groupDim);

  const ps = positions();
  const custom = state.groupDim === CUSTOM;
  $('group-toolbar').hidden = !custom;
  const unpriced = ps.filter((p) => p.price === null).length;
  $('alloc-note').textContent =
    model.source === 'excel' ? `투자내역의 보유 종목 기준${unpriced ? ` · 현재가 미입력 ${unpriced}종목은 매입가로 계산` : ''}` : '';

  let rows: AllocRow[];
  let customRows: CustomGroupRow[] = [];
  if (custom) {
    customRows = customGroupRows(ps, store, cashTotal());
    rows = customRows.map((r) => ({
      ...r,
      count: r.members.length,
      color: customColor(r.id),
      unpriced: r.members.length > 0 && r.members.every((m) => m.price === null),
    }));
  } else {
    rows = dimensionRows(ps, state.groupDim);
  }
  const chartRows = rows.filter((r) => r.value > 0);
  charts.donut = renderDonut(
    $<HTMLCanvasElement>('alloc-chart'),
    chartRows.map((r) => r.name),
    chartRows.map((r) => r.value),
    chartRows.map((r) => r.color),
    charts.donut,
  );

  const total = rows.reduce((s, r) => s + r.value, 0);
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const isCashLike = (r: AllocRow) => r.id === CASH_ID || r.name === '현금';
  $('group-table').innerHTML = `<thead><tr><th>그룹</th><th>비중</th><th>평가금</th><th title="보유 종목의 평가금 − 매입원가 (실현손익 · 배당 제외)">평가손익</th><th>수익률</th></tr></thead>
    <tbody>${rows
      .map((r) => {
        const clickable = custom && !isCashLike(r);
        const open = state.selectedGroup === r.id;
        return `<tr ${clickable ? `data-group="${escapeHtml(r.id)}" tabindex="0" class="clickable${open ? ' open' : ''}" aria-expanded="${open}"` : ''}>
          <td><span class="name">${clickable ? `<span class="caret">${open ? '▾' : '▸'}</span>` : ''}<span class="swatch" style="background:${r.color}"></span>${escapeHtml(r.name)}${r.count ? `<span class="code">${r.count}종목</span>` : ''}</span></td>
          <td>${pct(r.weight, 1)}</td><td>${won(r.value)}</td>
          <td>${isCashLike(r) || !r.count || r.unpriced ? '-' : signed(r.profit, wonSigned(r.profit))}</td>
          <td>${isCashLike(r) || !r.count || r.unpriced ? '-' : signed(r.returnRate, pctSigned(r.returnRate))}</td></tr>`;
      })
      .join('')}</tbody>
    <tfoot><tr><td>합계</td><td>100%</td><td>${won(total)}</td><td>${ps.every((p) => p.price === null) ? '-' : signed(total - totalCost, wonSigned(total - totalCost))}</td><td></td></tr></tfoot>`;

  renderGroupDetail(custom ? customRows.find((r) => r.id === state.selectedGroup) : undefined);
}

function priceCell(m: { price: number | null; currency: Currency; priceOverridden?: boolean }) {
  if (m.price === null) return '<span class="chip warn">미입력</span>';
  const t = m.currency === 'USD' ? `$${number(m.price)}` : won(m.price);
  return m.priceOverridden ? `${t} <span class="chip" title="직접 입력한 현재가">입력</span>` : t;
}

const unitPrice = (v: number, c: Currency) => (c === 'USD' ? `$${number(v)}` : won(v));

function renderGroupDetail(row: CustomGroupRow | undefined) {
  const el = $('group-detail');
  if (!row) {
    el.innerHTML = '';
    return;
  }
  const isUser = row.id !== UNGROUPED_ID;
  const idx = store.groups.findIndex((g) => g.id === row.id);
  const gid = escapeHtml(row.id);
  const color = customColor(row.id);
  const memberRow = (m: MemberRow) => `<tr>
      <td>${escapeHtml(m.name)}${m.manual ? ' <span class="chip">직접</span>' : ''}</td>
      <td>${pct(m.groupWeight, 1)}<span class="bar-cell"><span style="width:${m.groupWeight * 100}%;background:${color}"></span></span></td>
      <td>${pct(m.weight, 1)}</td>
      <td>${number(m.quantity)}</td>
      <td>${unitPrice(m.avgPrice, m.currency)}</td>
      <td>${priceCell(m)}</td>
      <td>${won(m.valueKRW)}</td>
      <td>${m.price === null ? '-' : signed(m.profitKRW, wonSigned(m.profitKRW))}</td>
      <td>${m.price === null ? '-' : signed(m.returnRate, pctSigned(m.returnRate))}</td>
      <td class="actions">
        <button type="button" class="mini" data-act="edit-stock" data-key="${escapeHtml(m.key)}">✎ 수정</button>
        ${isUser ? `<button type="button" class="mini" data-act="ungroup" data-key="${escapeHtml(m.key)}" title="그룹에서 빼기 (미분류로)">빼기</button>` : ''}
        ${m.manual ? `<button type="button" class="mini danger" data-act="delete-stock" data-key="${escapeHtml(m.key)}">삭제</button>` : ''}
      </td></tr>`;

  el.innerHTML = `<div class="detail" style="border-left-color:${color}">
    <div class="detail-head">
      <div>
        <h3><span class="swatch" style="background:${color}"></span>${escapeHtml(row.name)}</h3>
        <p class="hint">전체의 ${pct(row.weight, 1)} · ${won(row.value)} · ${row.members.length}종목</p>
      </div>
      <div class="detail-actions">
        ${
          isUser
            ? `<button type="button" class="btn primary" data-act="add-to-group" data-group="${gid}">+ 종목 추가</button>
               <button type="button" class="btn" data-act="rename-group" data-group="${gid}">이름 변경</button>
               <button type="button" class="btn icon" data-act="up-group" data-group="${gid}" ${idx <= 0 ? 'disabled' : ''} aria-label="그룹 순서 위로">▲</button>
               <button type="button" class="btn icon" data-act="down-group" data-group="${gid}" ${idx >= store.groups.length - 1 ? 'disabled' : ''} aria-label="그룹 순서 아래로">▼</button>
               <button type="button" class="btn danger" data-act="delete-group" data-group="${gid}">그룹 삭제</button>`
            : '<span class="hint">그룹이 없는 종목입니다. ✎ 수정에서 그룹을 지정하세요.</span>'
        }
      </div>
    </div>
    ${
      row.members.length
        ? `<div class="table-wrap"><table class="data">
            <thead><tr><th>종목</th><th>그룹 내 비중</th><th>전체 비중</th><th>수량</th><th>평균단가</th><th>현재가</th><th>평가금</th><th>평가손익</th><th>수익률</th><th></th></tr></thead>
            <tbody>${row.members.map(memberRow).join('')}</tbody></table></div>`
        : `<p class="empty">아직 종목이 없습니다. <button type="button" class="link" data-act="add-to-group" data-group="${gid}">보유 종목에서 추가</button> 또는 <button type="button" class="link" data-act="new-stock-in-group" data-group="${gid}">새 종목 직접 입력</button></p>`
    }
  </div>`;
}

// ─── 그룹 · 종목 대화상자 ─────────────────────────────────────

const groupOptions = () => [{ value: UNGROUPED_ID, label: UNGROUPED }, ...store.groups.map((g) => ({ value: g.id, label: g.name }))];
const groupNameOf = (key: string) => store.groups.find((g) => g.id === store.members[key])?.name ?? UNGROUPED;

function dialogNewGroup() {
  openForm({
    title: '새 그룹',
    description: '예: 배당주, 성장주, 채권. 만든 뒤 종목을 추가하세요.',
    fields: [{ name: 'name', label: '그룹 이름', placeholder: '배당주', required: true }],
    submitLabel: '만들기',
    onSubmit: (v) => {
      const res = createGroup(store, v.name);
      state.selectedGroup = res.id;
      mutate(() => res.store);
    },
  });
}

function dialogRenameGroup(id: string) {
  const g = store.groups.find((x) => x.id === id);
  if (!g) return;
  openForm({
    title: '그룹 이름 변경',
    fields: [{ name: 'name', label: '그룹 이름', value: g.name, required: true }],
    onSubmit: (v) => mutate(() => renameGroup(store, id, v.name)),
  });
}

function confirmDeleteGroup(id: string) {
  const g = store.groups.find((x) => x.id === id);
  if (!g) return;
  const n = Object.values(store.members).filter((x) => x === id).length;
  openConfirm('그룹 삭제', `'${g.name}' 그룹을 지웁니다. 소속 종목 ${n}개는 지워지지 않고 '${UNGROUPED}'로 옮겨집니다.`, '삭제', () => {
    state.selectedGroup = null;
    mutate(() => deleteGroup(store, id));
  });
}

function dialogAddToGroup(groupId: string) {
  const g = store.groups.find((x) => x.id === groupId);
  if (!g) return;
  const candidates = aggregateByKey(positions())
    .filter((p) => store.members[p.key] !== groupId)
    .sort((a, b) => b.valueKRW - a.valueKRW);
  if (!candidates.length) {
    dialogManualStock(groupId);
    return;
  }
  openForm({
    title: `'${g.name}'에 종목 추가`,
    description: '보유 종목 중에서 고르세요. 다른 그룹에 있던 종목은 이 그룹으로 옮겨집니다. 목록에 없는 종목은 "+ 종목 직접 추가"로 입력하세요.',
    fields: [
      {
        name: 'key',
        label: '종목',
        type: 'select',
        options: candidates.map((p) => ({ value: p.key, label: `${p.name} · ${wonShort(p.valueKRW)} (현재: ${groupNameOf(p.key)})` })),
      },
    ],
    submitLabel: '추가',
    onSubmit: (v) => mutate(() => assignStock(store, v.key, groupId)),
  });
}

function dialogManualStock(groupId: string | null) {
  openForm({
    title: '종목 직접 추가',
    description: '데이터에 없는 종목(연금 · IRP 계좌 종목 등)을 직접 입력합니다. 이 브라우저에만 저장됩니다.',
    fields: [
      { name: 'name', label: '종목 이름', placeholder: 'TIGER 미국배당다우존스', required: true },
      { name: 'currency', label: '통화', type: 'select', value: 'KRW', options: [{ value: 'KRW', label: '원 (KRW)' }, { value: 'USD', label: '달러 (USD)' }] },
      { name: 'quantity', label: '수량', type: 'number', step: 'any', required: true },
      { name: 'avgPrice', label: '평균단가', type: 'number', step: 'any', required: true },
      { name: 'price', label: '현재가 (선택)', type: 'number', step: 'any', hint: '비우면 평균단가로 계산합니다' },
      { name: 'group', label: '그룹', type: 'select', value: groupId ?? UNGROUPED_ID, options: groupOptions() },
    ],
    submitLabel: '추가',
    onSubmit: (v) => {
      const res = addManualStock(
        store,
        {
          name: v.name,
          currency: v.currency as Currency,
          quantity: parseNumber(v.quantity) ?? 0,
          avgPrice: parseNumber(v.avgPrice) ?? 0,
          price: parseNumber(v.price),
        },
        v.group === UNGROUPED_ID ? null : v.group,
        model.positions(allIds()).map((p) => p.key),
      );
      if (v.group !== UNGROUPED_ID) state.selectedGroup = v.group;
      mutate(() => res.store);
    },
  });
}

function dialogEditStock(key: string) {
  const all = aggregateByKey(applyStore(model.positions(allIds()), store, model.usdKrw));
  const p = all.find((x) => x.key === key);
  if (!p) return;
  const manual = store.manual.find((m) => m.key === key);
  const original = aggregateByKey(model.positions(allIds())).find((x) => x.key === key);
  const unit = p.currency === 'USD' ? '달러' : '원';
  const fields = [
    ...(manual
      ? [
          { name: 'name', label: '종목 이름', value: manual.name, required: true },
          { name: 'quantity', label: '수량', type: 'number' as const, step: 'any', value: manual.quantity, required: true },
          { name: 'avgPrice', label: `평균단가 (${unit})`, type: 'number' as const, step: 'any', value: manual.avgPrice, required: true },
        ]
      : []),
    {
      name: 'price',
      label: `현재가 (${unit})`,
      type: 'number' as const,
      step: 'any',
      value: manual ? (store.prices[key] ?? manual.price) : (store.prices[key] ?? original?.price ?? null),
      hint: manual
        ? '비우면 평균단가로 계산합니다'
        : original?.price != null
          ? `비우면 데이터의 현재가(${unitPrice(original.price, p.currency)})로 돌아갑니다`
          : '비우면 매입가로 계산합니다',
    },
    { name: 'group', label: '그룹', type: 'select' as const, value: store.members[key] ?? UNGROUPED_ID, options: groupOptions() },
  ];
  openForm({
    title: `${p.name} 수정`,
    description: manual ? undefined : `수량 ${number(p.quantity)} · 평균단가 ${unitPrice(p.avgPrice, p.currency)} (데이터 값이라 여기서 바꾸지 않습니다)`,
    fields,
    onSubmit: (v) => {
      let next = store;
      const price = parseNumber(v.price);
      if (manual) {
        next = updateManualStock(next, key, { name: v.name, quantity: parseNumber(v.quantity) ?? 0, avgPrice: parseNumber(v.avgPrice) ?? 0, price });
        next = setPrice(next, key, null);
      } else if (price === null || (original?.price != null && Math.abs(price - original.price) < 1e-9)) {
        next = setPrice(next, key, null);
      } else {
        next = setPrice(next, key, price);
      }
      next = assignStock(next, key, v.group === UNGROUPED_ID ? null : v.group);
      mutate(() => next);
    },
  });
}

function confirmDeleteStock(key: string) {
  const m = store.manual.find((x) => x.key === key);
  if (!m) return;
  openConfirm('종목 삭제', `직접 추가한 '${m.name}'을(를) 지웁니다.`, '삭제', () => mutate(() => deleteManualStock(store, key)));
}

function confirmClearExcel() {
  openConfirm('엑셀 데이터 지우기', '이 브라우저에 저장된 엑셀 데이터와 엑셀용 그룹 설정을 지웁니다. 원본 엑셀 파일은 그대로입니다.', '지우기', () => {
    try {
      localStorage.removeItem(EXCEL_KEY);
      localStorage.removeItem('stock-dashboard:groups:v1:excel');
    } catch {
      /* 무시 */
    }
    excelBook = null;
    setSource('dummy');
  });
}

// ─── 배당 ────────────────────────────────────────────────────

function renderDividendSection() {
  const card = $('div-card');
  card.hidden = !model.hasDividends;
  $('grid-2').classList.toggle('single', !model.hasDividends);
  if (!model.hasDividends) {
    charts.div?.destroy();
    charts.div = undefined;
    return;
  }
  const txs = dividends();
  const sum = summarizeDividends(txs, lastDate());
  const { rangeA } = state;
  const inRange = (m: string) => m >= rangeA.start.slice(0, 7) && m <= rangeA.end.slice(0, 7);
  const periodTotal = txs.filter((t) => t.date >= rangeA.start && t.date <= rangeA.end).reduce((s, t) => s + t.amountKRW, 0);

  $('div-kpis').innerHTML = [...sum.byYear.map((y) => ({ label: `${y.year}년`, value: won(y.amount) })), { label: '선택 기간', value: won(periodTotal) }]
    .map((k) => `<div><div class="label">${k.label}</div><div class="value">${k.value}</div></div>`)
    .join('');

  const months: string[] = [];
  const first = sum.byMonth[0]?.month ?? lastDate().slice(0, 7);
  for (let d = new Date(`${first}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= lastDate().slice(0, 7); d.setUTCMonth(d.getUTCMonth() + 1)) {
    months.push(d.toISOString().slice(0, 7));
  }
  const byMonth = new Map(sum.byMonth.map((m) => [m.month, m.amount]));
  charts.div = renderDividends($<HTMLCanvasElement>('div-chart'), months, months.map((m) => byMonth.get(m) ?? 0), inRange, charts.div);

  const names = new Map(model.positions(allIds()).map((p) => [p.key, p.name]));
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

// ─── 보유 종목 ───────────────────────────────────────────────

function renderHoldings() {
  const ps = positions().sort((a, b) => b.valueKRW - a.valueKRW);
  const multi = model.accountFilter && accountIds().length > 1;
  const cash = cashTotal();
  const total = ps.reduce((s, p) => s + p.valueKRW, 0) + cash || 1;
  const max = ps[0]?.valueKRW ?? 1;
  $('hold-count').textContent = `${aggregateByKey(ps).length}개 종목${cash ? ` · 현금 ${won(cash)}` : ''} · 합계 ${wonShort(total)}`;
  $('hold-table').innerHTML = `<thead><tr><th>종목</th>${multi ? '<th class="left">계좌</th>' : ''}<th class="left">그룹</th><th>수량</th><th>평균단가</th><th>현재가</th><th>평가금</th><th>평가손익</th><th>수익률</th><th>비중</th><th></th></tr></thead>
    <tbody>${ps
      .map((p) => {
        const profit = p.valueKRW - p.costKRW;
        const rate = p.costKRW > 0 ? profit / p.costKRW : 0;
        return `<tr>
          <td>${escapeHtml(p.name)}${p.code && p.code !== p.name ? `<span class="code">${escapeHtml(p.code)}</span>` : ''}${p.manual ? ' <span class="chip">직접</span>' : ''}</td>
          ${multi ? `<td class="left"><span class="chip">${p.accountId ? escapeHtml(accountName(p.accountId)) : '-'}</span></td>` : ''}
          <td class="left"><span class="name"><span class="swatch sm" style="background:${customColor(store.members[p.key] ?? UNGROUPED_ID)}"></span>${escapeHtml(groupNameOf(p.key))}</span></td>
          <td>${number(p.quantity)}</td>
          <td>${unitPrice(p.avgPrice, p.currency)}</td>
          <td>${priceCell(p)}</td>
          <td>${won(p.valueKRW)}</td>
          <td>${p.price === null ? '-' : signed(profit, wonSigned(profit))}</td>
          <td>${p.price === null ? '-' : signed(rate, pctSigned(rate))}</td>
          <td>${pct(p.valueKRW / total, 1)}<span class="bar-cell"><span style="width:${(p.valueKRW / max) * 100}%"></span></span></td>
          <td class="actions"><button type="button" class="mini" data-act="edit-stock" data-key="${escapeHtml(p.key)}" aria-label="${escapeHtml(p.name)} 수정">✎</button></td>
        </tr>`;
      })
      .join('')}</tbody>`;

  const trades = model.closedTrades ?? [];
  const det = $<HTMLDetailsElement>('trades');
  det.hidden = !trades.length;
  if (!trades.length) return;
  const realized = trades.reduce((s, t) => s + t.profitKRW, 0);
  $('trades-summary').innerHTML = `매도 기록 ${trades.length}건 · 실현손익 합계 ${signed(realized, wonSigned(realized))}`;
  $('trades-table').innerHTML = `<thead><tr><th>매도일</th><th class="left">종목</th><th>수량</th><th>매수가</th><th>매도가</th><th>수익률</th><th>실현손익</th><th class="left">메모</th></tr></thead>
    <tbody>${trades
      .map(
        (t) => `<tr>
          <td>${t.sellDate ?? '-'}</td>
          <td class="left">${escapeHtml(t.name)}</td>
          <td>${number(t.quantity)}</td>
          <td>${unitPrice(t.buyPrice, t.currency)}</td>
          <td>${unitPrice(t.sellPrice, t.currency)}</td>
          <td>${signed(t.returnRate, pctSigned(t.returnRate))}</td>
          <td>${signed(t.profitKRW, wonSigned(t.profitKRW))}</td>
          <td class="left memo" title="${escapeHtml([t.buyNote, t.sellNote].filter(Boolean).join(' / '))}">${escapeHtml(t.sellNote ?? t.buyNote ?? '')}</td>
        </tr>`,
      )
      .join('')}</tbody>`;
}

main().catch((e) => {
  console.error(e);
  document.getElementById('app')!.insertAdjacentHTML('afterbegin', `<p class="card">데이터를 불러오지 못했습니다: ${escapeHtml(String(e))}</p>`);
});
