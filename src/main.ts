import './style.css';
import { DummyProvider } from './data/dummy';
import { loadPortfolio } from './data/provider';
import { makeDummyModel } from './data/dummyModel';
import { bookUsdKrw, makeExcelModel } from './data/excelModel';
import { parseStockBook, parseSyncSettings, summaryEndCells, upgradeBook, type ExcelBook, type ExcelGroup } from './data/excel/parse';
import { readWorkbook } from './data/excel/xlsx';
import { upsertSheets } from './data/excel/write';
import { buildExportSheets, groupsForExport, monthlyFromSheets, summaryLinkCells, upsertDaily } from './data/excel/export';
import { accountTotals, applySync, holdingKey, removeHolding, setCash, upsertHolding, type HoldingRow, type HoldingsState } from './data/holdings';
import { checkProxy, fetchSync, loadSyncSettings, normalizeUrl, saveSyncSettings } from './data/sync';
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
  emptyStore,
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
import { arrow, escapeHtml, number, pct, pctSigned, shortDate, tone, won, wonShort, wonSigned } from './format';
import {
  applyChartDefaults,
  renderCompare,
  renderDividends,
  renderDepositChart,
  renderDonut,
  renderTrend,
  renderYtd,
  token,
  type AnyChart,
  type ReturnMode,
  type TrendCharts,
} from './ui/charts';
import { openConfirm, openForm, parseNumber } from './ui/dialog';
import { openPhotoReview, recognizeImages } from './ui/photo';
import { applyPhoto, guessAccountByTotal, matchHoldings, parseAccountScreen } from './data/photo';
import { fillFromInstruments, listInfo, loadInstrumentList, loadInstruments, refreshInstruments, type Instrument } from './data/instruments';
import { dividendsFrom, mergeApiDividends, resolveCode } from './data/dividends';

// ─── 상태 ────────────────────────────────────────────────────

const EXCEL_KEY = 'stock-dashboard:excel:v1';
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
/** 마지막으로 읽은 엑셀 원본 (엑셀 업데이트 때 다른 시트를 그대로 두기 위해) */
let excelBytes: Uint8Array | null = null;
/** PC 크롬 · 엣지: 고른 파일에 바로 저장 */
let excelHandle: FileHandle | null = null;
let pendingPick: 'import' | 'export' = 'import';
/** 보유 종목 표의 계좌 필터 */
let holdAccount = 'ALL';

interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
  createWritable(): Promise<{ write(d: Blob | Uint8Array): Promise<void>; close(): Promise<void> }>;
}
type OpenPicker = (o: unknown) => Promise<FileHandle[]>;
const openPicker = (window as unknown as { showOpenFilePicker?: OpenPicker }).showOpenFilePicker;
let model: DashboardData;
let store: GroupStore;
let state: State;
let snaps: DailySnapshot[] = [];
/** 자산 추이에서 고른 계좌 (비어 있으면 전체) */
let trendAccounts: string[] = [];
let dimColorOrder: Record<string, string[]> = {};
const charts: { trend?: TrendCharts; compare?: AnyChart; donut?: AnyChart; div?: AnyChart; ytd?: AnyChart; dep?: AnyChart } = {};

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

/** 그룹 설정 저장 위치: 내 데이터(엑셀 → 마이데이터로 바뀌어도 유지)와 샘플을 나눈다 */
const MINE = 'mine';
const storeKey = () => (model.source === 'dummy' ? 'dummy' : MINE);

function persist() {
  saveStore(storeKey(), store);
}

// ─── 시작 ────────────────────────────────────────────────────

async function main() {
  restoreTheme();
  dummyModel = makeDummyModel(await loadPortfolio(new DummyProvider()));
  excelBook = loadExcel();
  buildControls();
  instrumentsLabel();
  setModel(excelBook ? makeExcelModel(excelBook) : dummyModel);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderAll);
}

function loadExcel(): ExcelBook | null {
  try {
    const raw = localStorage.getItem(EXCEL_KEY);
    return raw ? upgradeBook(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function saveExcelLocal(): boolean {
  if (!excelBook) return false;
  try {
    localStorage.setItem(EXCEL_KEY, JSON.stringify(excelBook));
    return true;
  } catch {
    return false;
  }
}

/** 엑셀 '그룹' 시트 → 그룹 설정 */
function storeFromGroups(groups: ExcelGroup[]): GroupStore {
  let st = emptyStore();
  for (const g of groups) {
    try {
      const res = createGroup(st, g.name);
      st = res.store;
      for (const k of g.keys) st = assignStock(st, k, res.id);
    } catch {
      /* 이름이 겹치거나 잘못된 그룹은 건너뜀 */
    }
  }
  return st;
}

function importExcel(bytes: Uint8Array, fileName: string, handle: FileHandle | null) {
  const wb = readWorkbook(bytes);
  const book = parseStockBook(wb, fileName);
  // '설정' 시트에 중계 서버 주소 · 토큰이 있으면 이 브라우저의 동기화 설정으로 저장
  let syncNote = '';
  const sync = parseSyncSettings(wb);
  if (sync) {
    try {
      saveSyncSettings({ url: normalizeUrl(sync.url), token: sync.token });
      syncNote = ' 동기화 설정도 엑셀에서 가져왔습니다.';
    } catch (e) {
      syncNote = ` '설정' 시트의 중계 서버 주소를 쓸 수 없습니다 (${e instanceof Error ? e.message : String(e)}).`;
    }
  }
  excelBook = book;
  excelBytes = bytes;
  excelHandle = handle;
  holdAccount = 'ALL';
  // 엑셀의 그룹 시트가 기준 (샘플 데이터의 그룹과는 따로 저장)
  saveStore(MINE, storeFromGroups(book.groups));
  const saved = saveExcelLocal();
  setModel(makeExcelModel(book));
  instrumentsLabel();
  const n = book.holdings.rows.length;
  showNote(
    `${fileName}을(를) 불러왔습니다 · 보유종목 ${n}개 · 그룹 ${book.groups.length}개. ${n ? '"② 최신 정보 가져오기"로 현재가를 반영하세요.' : '보유 종목 표에서 계좌별로 종목을 추가하거나 "② 최신 정보 가져오기"를 누르세요.'}${syncNote}${saved ? '' : ' (브라우저 저장 공간이 부족해 새로고침하면 다시 불러와야 합니다)'}`,
  );
}

async function pickExcel(mode: 'import' | 'export') {
  pendingPick = mode;
  if (openPicker) {
    try {
      const [h] = await openPicker({ types: [{ description: '엑셀', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }], multiple: false });
      let file: File;
      try {
        file = await h.getFile();
      } catch {
        // 구글 드라이브 같은 동기화 폴더는 브라우저가 '바로 저장' 방식으로 열지 못할 때가 있다 → 일반 파일 선택으로
        showNote(
          `이 위치의 파일은 브라우저가 바로 열 수 없어 일반 방식으로 엽니다. <button type="button" class="btn primary" data-act="pick-excel-fallback">${mode === 'export' ? '업데이트할' : '불러올'} 파일 다시 고르기</button> (이 방식에서는 ③ 엑셀 업데이트가 파일을 내려받습니다)`,
          false,
          true,
        );
        return;
      }
      await onPicked(new Uint8Array(await file.arrayBuffer()), file.name, h);
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') showNote(`엑셀을 열지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, true);
    }
    return;
  }
  $<HTMLInputElement>('excel-input').click();
}

async function onPicked(bytes: Uint8Array, name: string, handle: FileHandle | null) {
  if (pendingPick === 'export') {
    excelBytes = bytes;
    excelHandle = handle;
    await exportExcel();
    return;
  }
  showNote('엑셀을 읽는 중…');
  try {
    importExcel(bytes, name, handle);
  } catch (ex) {
    showNote(`엑셀을 읽지 못했습니다: ${ex instanceof Error ? ex.message : String(ex)}`, true);
  }
}

function setModel(next: DashboardData) {
  model = next;
  const all = model.positions(model.accounts.map((a) => a.id));
  // 샘플은 기본 그룹을 만들어 두고, 내 데이터는 엑셀 '그룹' 시트(없으면 빈 상태)에서 시작
  store = loadStore(storeKey()) ?? (model.source === 'dummy' ? seedStore(all, model.defaultGroups) : storeFromGroups(excelBook?.groups ?? []));
  persist();
  refreshColorOrder();

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

/** 기본 그룹 기준의 색 순서를 전체 계좌 기준으로 고정 (필터를 바꿔도 같은 그룹은 같은 색) */
function refreshColorOrder() {
  const all = model.positions(allIds());
  dimColorOrder = {};
  for (const d of model.dimensions) {
    const totals = new Map<string, number>();
    for (const p of all) {
      const k = dimKey(p, d.id);
      totals.set(k, (totals.get(k) ?? 0) + p.valueKRW);
    }
    dimColorOrder[d.id] = [...totals].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }
}

/** 보유 종목이 바뀜 (편집 · 동기화) → 저장하고 다시 그림 */
function holdingsChanged(next: HoldingsState) {
  if (!excelBook) return;
  excelBook.holdings = next;
  // 오늘(보유종목 기준일) 값을 일별 자산추이에 기록
  if (next.asOf) excelBook.dailyLog = upsertDaily(excelBook.dailyLog, next, bookUsdKrw(excelBook), next.asOf.slice(0, 10));
  saveExcelLocal();
  refreshColorOrder();
  recomputeAccount();
  buildSourceControls();
  if (state.preset) applyPreset(state.preset);
  else renderAll();
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

  // 동기화 메뉴
  const menu = $('sync-menu');
  const btn = $('sync-btn');
  const setMenu = (open: boolean) => {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) (menu.querySelector('button') as HTMLElement | null)?.focus();
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenu(menu.hidden);
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) setMenu(false);
  });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not([hidden])')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      setMenu(false);
      btn.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    }
  });
  $('menu-sync').addEventListener('click', () => {
    setMenu(false);
    void runSync();
  });
  $('menu-excel').addEventListener('click', () => {
    setMenu(false);
    void pickExcel('import');
  });
  $('menu-photo').addEventListener('click', () => {
    setMenu(false);
    pickPhotos();
  });
  $('holding-photo').addEventListener('click', () => pickPhotos());
  $<HTMLInputElement>('photo-input').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) await updateFromPhotos(files);
  });
  $('instruments-btn').addEventListener('click', () => void updateInstrumentList());
  $('menu-export').addEventListener('click', () => {
    setMenu(false);
    void exportExcel();
  });
  $('menu-clear').addEventListener('click', () => {
    setMenu(false);
    confirmClearData();
  });

  $<HTMLInputElement>('excel-input').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    await onPicked(new Uint8Array(await file.arrayBuffer()), file.name, null);
  });

  // 그룹 도구
  $('group-add').addEventListener('click', () => dialogNewGroup());
  $('stock-add').addEventListener('click', () => addStockDialog(null));
  $('holding-add').addEventListener('click', () => dialogHolding(undefined, null));
  $('cash-edit').addEventListener('click', () => dialogCash(holdAccount === 'ALL' ? null : holdAccount));

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
    if (act === 'new-stock-in-group' && group) addStockDialog(group);
    if (act === 'pick-excel-fallback') $<HTMLInputElement>('excel-input').click();
    const { account } = b.dataset;
    if (act === 'edit-holding' && key && account) dialogHolding({ account, key }, null);
    if (act === 'delete-holding' && key && account) confirmDeleteHolding(account, key);
  });
}

function buildSourceControls() {
  const synced = excelBook?.holdings.syncedAt;
  const updated = model.updatedAt ? (synced ? `${timeLabel(synced)} 동기화` : `${model.updatedAt.slice(0, 10)} 불러옴`) : '';
  $('asof').textContent = [
    model.source === 'dummy' ? '샘플 데이터' : model.sourceLabel,
    `${model.asOf} 기준`,
    updated,
  ]
    .filter(Boolean)
    .join(' · ');
  $('menu-clear').hidden = model.source === 'dummy';
  $('sync-state').textContent = loadSyncSettings()
    ? `NH 계좌 잔고 · 모든 종목 현재가${synced ? ` · 마지막 ${timeLabel(synced)}` : ''}`
    : '엑셀 "설정" 시트에 중계 서버 주소 · 접속 토큰이 필요합니다';
  $('export-state').textContent = excelHandle ? `${excelHandle.name}에 바로 저장` : '보유종목 · 그룹 · 일별 / 월별 자산추이 시트를 넣은 엑셀 파일 저장';

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

  if (model.source === 'dummy') {
    showNote('샘플 데이터입니다. 오른쪽 위 "마이데이터 동기화 → ① 엑셀 불러오기"로 내 데이터를 불러오면 실제 값으로 바뀝니다.');
  } else {
    $('source-note').hidden = true;
  }

  $('foot').textContent =
    model.source === 'dummy'
      ? '샘플 데이터는 종목 이름만 실제이고 가격 · 거래 · 배당은 모두 임의 값입니다.'
      : '불러온 엑셀 값과 그룹 설정은 이 브라우저에만 저장됩니다. 동기화는 설정한 내 중계 서버로만 요청합니다.';
}

function timeLabel(iso: string) {
  if (/T00:00(:00)?$/.test(iso) || /^\d{4}-\d{2}-\d{2}$/.test(iso)) return shortDate(iso.slice(0, 10)); // 엑셀 기준일 (시각 없음)
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  renderDeposits();
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
    { label: monthly ? '총자산' : '총 평가금', value: won(last.value), delta: `${monthly ? shortDate(prev.date) : '전일'} 대비 ${signed(change, wonSigned(change))}` },
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

/** 자산 추이용 스냅샷: 전체, 또는 고른 계좌들의 합 */
function trendSnaps(): DailySnapshot[] {
  if (!trendAccounts.length || !model.accountSnapshots) return snaps;
  return model.accountSnapshots(trendAccounts);
}

function renderTrendAccounts() {
  const list = model.trendAccounts ?? [];
  const row = $('trend-accounts-row');
  row.hidden = !list.length || !model.accountSnapshots;
  trendAccounts = trendAccounts.filter((a) => list.includes(a));
  if (row.hidden) {
    $('trend-accounts-note').hidden = true;
    return;
  }
  const box = $('trend-accounts');
  box.innerHTML = [{ id: '', label: '전체 계좌' }, ...list.map((a) => ({ id: a, label: a }))]
    .map((i) => `<button type="button" data-acc="${escapeHtml(i.id)}" aria-pressed="${i.id ? trendAccounts.includes(i.id) : !trendAccounts.length}">${escapeHtml(i.label)}</button>`)
    .join('');
  box.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-acc]');
    if (!b) return;
    const a = b.dataset.acc!;
    if (!a) trendAccounts = [];
    else trendAccounts = trendAccounts.includes(a) ? trendAccounts.filter((x) => x !== a) : [...trendAccounts, a];
    // 모든 계좌를 고르면 '전체'와 같으므로 전체로
    if (trendAccounts.length === list.length) trendAccounts = [];
    renderTrendSection();
  };
}

function renderTrendSection() {
  const { rangeA, rangeB, compare, mode } = state;
  renderTrendAccounts();
  const snaps = trendSnaps();
  const note = $('trend-accounts-note');
  note.hidden = !trendAccounts.length;
  if (trendAccounts.length) {
    const first = snaps[0]?.date;
    note.textContent = snaps.length < 2
      ? `${trendAccounts.join(' + ')}: 계좌별 기록이 아직 ${snaps.length}일뿐입니다. 동기화 · 사진 업데이트 · 편집할 때마다 그날 값이 쌓입니다 (원금은 입금내역 기준).`
      : `${trendAccounts.join(' + ')}: 계좌별 기록이 있는 ${first}부터 표시합니다 (원금은 입금내역 기준).`;
  }
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
    `<span class="item"><span class="swatch line" style="background:${token('--value-line')}"></span>${model.source === 'excel' && !trendAccounts.length ? '총자산 (월말)' : '평가금'}</span>`,
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

// ─── 계좌별 입금 ─────────────────────────────────────────────

function renderDeposits() {
  const dep = model.deposits;
  const card = $('deposit-card');
  card.hidden = !dep || !dep.rows.length;
  if (!dep || !dep.rows.length) {
    charts.dep?.destroy();
    charts.dep = undefined;
    return;
  }
  const { rangeA } = state;
  const n = dep.accounts.length;
  const sumBy = (rows: typeof dep.rows) => {
    const t = Array(n).fill(0) as number[];
    for (const r of rows) r.amounts.forEach((a, i) => (t[i] += a));
    return t;
  };
  const totals = sumBy(dep.rows);
  const inRange = dep.rows.filter((r) => r.date >= rangeA.start && r.date <= rangeA.end);
  const rangeTotals = sumBy(inRange);
  const year = model.asOf.slice(0, 4);
  const yearTotal = sumBy(dep.rows.filter((r) => r.date.startsWith(year))).reduce((a, b) => a + b, 0);
  const grand = totals.reduce((a, b) => a + b, 0);
  const lastIn = (i: number) => [...dep.rows].reverse().find((r) => r.amounts[i] !== 0)?.date ?? '-';
  const color = (i: number) => (i < 8 ? token(`--series-${i + 1}`) : token('--series-other'));
  const latest = dep.rows.at(-1)!;
  const latestSum = latest.amounts.reduce((a, b) => a + b, 0);

  $('dep-kpis').innerHTML = [
    { label: '누적 순입금', value: won(grand) },
    { label: `${year}년 순입금`, value: wonSigned(yearTotal) },
    { label: '선택 기간 순입금', value: wonSigned(rangeTotals.reduce((a, b) => a + b, 0)) },
    { label: `최근 기록 (${latest.date})`, value: wonSigned(latestSum) },
  ]
    .map((k) => `<div><div class="label">${k.label}</div><div class="value">${k.value}</div></div>`)
    .join('');

  $('dep-table').innerHTML = `<thead><tr><th>계좌</th><th>누적 순입금</th><th>비중</th><th>선택 기간</th><th>마지막 입금</th></tr></thead>
    <tbody>${dep.accounts
      .map(
        (a, i) => `<tr>
          <td><span class="name"><span class="swatch" style="background:${color(i)}"></span>${escapeHtml(a)}</span></td>
          <td>${won(totals[i])}</td>
          <td>${grand ? pct(totals[i] / grand, 1) : '-'}</td>
          <td>${rangeTotals[i] ? wonSigned(rangeTotals[i]) : '-'}</td>
          <td>${lastIn(i)}</td></tr>`,
      )
      .join('')}</tbody>
    <tfoot><tr><td>합계</td><td>${won(grand)}</td><td>100%</td><td>${wonSigned(rangeTotals.reduce((a, b) => a + b, 0))}</td><td></td></tr></tfoot>`;

  // 월별 막대 (선택 기간)
  const months: string[] = [];
  const first = (inRange[0]?.date ?? rangeA.start).slice(0, 7);
  const last = rangeA.end.slice(0, 7);
  for (let d = new Date(`${first}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= last; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
  const byMonth = new Map<string, number[]>();
  for (const r of inRange) {
    const m = r.date.slice(0, 7);
    const row = byMonth.get(m) ?? (Array(n).fill(0) as number[]);
    r.amounts.forEach((a, i) => (row[i] += a));
    byMonth.set(m, row);
  }
  const series = dep.accounts
    .map((name, i) => ({ name, color: color(i), data: months.map((m) => byMonth.get(m)?.[i] ?? 0) }))
    .filter((s) => s.data.some((v) => v !== 0));
  $('dep-legend').innerHTML = series.map((s) => `<span class="item"><span class="swatch" style="background:${s.color}"></span>${escapeHtml(s.name)}</span>`).join('');
  charts.dep = renderDepositChart($<HTMLCanvasElement>('dep-chart'), months, series, charts.dep);

  $('dep-log-summary').textContent = `입금 기록 ${dep.rows.length}건 보기`;
  $('dep-log-table').innerHTML = `<thead><tr><th>날짜</th>${dep.accounts.map((a) => `<th>${escapeHtml(a)}</th>`).join('')}<th>합계</th></tr></thead>
    <tbody>${[...dep.rows]
      .reverse()
      .map((r) => `<tr><td>${r.date}</td>${r.amounts.map((a) => `<td>${a ? wonShort(a) : ''}</td>`).join('')}<td>${wonShort(r.amounts.reduce((x, y) => x + y, 0))}</td></tr>`)
      .join('')}</tbody>`;
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
  $('stock-add').textContent = excelBook ? '+ 종목 추가' : '+ 종목 직접 추가';
  const empty = ps.length === 0;
  $('alloc-body').hidden = empty;
  $('alloc-empty').hidden = !empty;
  $('alloc-empty').textContent = custom
    ? `보유 종목 정보가 아직 없습니다. "② 최신 정보 가져오기"나 보유 종목 표의 "+ 종목 추가"로 채우면 그룹별 비중을 볼 수 있습니다.${store.groups.length ? ` (그룹: ${store.groups.map((g) => g.name).join(', ')})` : ''}`
    : '보유 종목 정보가 아직 없습니다. "② 최신 정보 가져오기" 후 표시됩니다.';
  const unpriced = ps.filter((p) => p.price === null).length;
  $('alloc-note').textContent = unpriced ? `현재가 미입력 ${unpriced}종목은 매입가로 계산` : '';

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
  // 종목 하나는 그룹 하나에만: 아직 어느 그룹에도 없는(미분류) 종목만 고를 수 있다
  const known = new Set(store.groups.map((x) => x.id));
  const candidates = aggregateByKey(positions())
    .filter((p) => !known.has(store.members[p.key]))
    .sort((a, b) => b.valueKRW - a.valueKRW);
  if (!candidates.length) {
    openForm({
      title: `'${g.name}'에 종목 추가`,
      description: '모든 보유 종목이 이미 다른 그룹에 들어 있습니다. 다른 그룹의 종목을 옮기려면 그 그룹에서 "빼기"를 하거나 종목 ✎ 수정에서 그룹을 바꾸세요.',
      fields: [],
      submitLabel: '새 종목 입력',
      onSubmit: () => addStockDialog(groupId),
    });
    return;
  }
  openForm({
    title: `'${g.name}'에 종목 추가`,
    description: '어느 그룹에도 없는 종목만 보입니다 (종목 하나는 그룹 하나에만 속함). 목록에 없는 종목은 보유 종목 표의 "+ 종목 추가"로 먼저 넣으세요.',
    fields: [
      {
        name: 'key',
        label: '종목',
        type: 'select',
        options: candidates.map((p) => ({ value: p.key, label: `${p.name} · ${wonShort(p.valueKRW)}` })),
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
    description: manual
      ? undefined
      : `수량 ${number(p.quantity)} · 평균단가 ${unitPrice(p.avgPrice, p.currency)} (${excelBook ? '수량 · 단가는 보유 종목 표에서 계좌별로 고칩니다' : '데이터 값이라 여기서 바꾸지 않습니다'})`,
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

function confirmClearData() {
  openConfirm('불러온 데이터 지우기', '이 브라우저에 저장된 내 데이터(엑셀에서 불러온 값)와 그룹 설정을 지웁니다. 원본 엑셀 파일은 그대로입니다.', '지우기', () => {
    try {
      localStorage.removeItem(EXCEL_KEY);
      localStorage.removeItem('stock-dashboard:groups:v1:mine');
    } catch {
      /* 무시 */
    }
    excelBook = null;
    excelBytes = null;
    excelHandle = null;
    setModel(dummyModel);
  });
}

async function runSync() {
  if (!excelBook) {
    showNote('먼저 "① 엑셀 불러오기"로 주식.xlsx를 불러오세요. 엑셀의 계좌 · 입금 기록 위에 최신 잔고와 현재가를 반영합니다.', true);
    return;
  }
  const settings = loadSyncSettings();
  if (!settings?.token) {
    dialogSettings(true);
    return;
  }
  showNote('NH 계좌 잔고와 현재가를 가져오는 중…');
  try {
    const book = excelBook;
    const res = await fetchSync(settings, book.holdings, book.holdings.syncedAccounts, dividendsFrom(book.dividends));
    const next = applySync(book.holdings, res);
    // NH 배당 입금: 받은 기간은 새 값으로, 직접 적은 기록은 그대로
    let newDividends = 0;
    if (res.dividends && res.dividendsFrom) {
      const list = await loadInstruments(settings).catch((): Instrument[] => []);
      const merged = mergeApiDividends(book.dividends, res.dividends, res.accounts.map((a) => a.name), res.dividendsFrom, res.usdKrw ?? bookUsdKrw(book), (d) => resolveCode(d, next, list));
      book.dividends = merged.rows;
      newDividends = merged.added;
    }
    holdingsChanged(next);
    const apiNames = res.accounts.map((a) => a.name);
    const priced = new Set(next.rows.filter((r) => !apiNames.includes(r.account) && r.code && res.prices[r.code]).map((r) => r.code)).size;
    const accounts = res.accounts.map((a) => `${a.name} ${a.rows.length}종목`).join(', ');
    showNote(
      `동기화했습니다 · ${accounts || 'NH 계좌 없음'} · 다른 계좌 현재가 ${priced}종목 반영${res.usdKrw ? ` · 환율 ${number(res.usdKrw)}원` : ''}${newDividends ? ` · 새 배당 ${newDividends}건` : ''}.${res.warnings.length ? ` 확인 필요: ${res.warnings.join(' / ')}` : ''} 수정을 마치면 "③ 엑셀 업데이트"로 저장하세요.`,
      res.warnings.length > 0,
    );
  } catch (ex) {
    showNote(`동기화하지 못했습니다: ${ex instanceof Error ? ex.message : String(ex)}`, true);
  }
}

function dialogSettings(thenSync = false) {
  const cur = loadSyncSettings();
  openForm({
    title: '동기화 설정',
    description: 'NH 투자증권 Open API 중계 서버(내 Cloudflare Worker 또는 PC에서 실행한 서버)의 주소와 접속 토큰입니다. 엑셀 \'설정\' 시트에 "중계 서버 주소" · "접속 토큰"을 적어 두면 엑셀을 불러올 때 자동으로 채워집니다. 둘 다 비우면 연결을 끊습니다.',
    fields: [
      { name: 'url', label: '중계 서버 주소', value: cur?.url ?? '', placeholder: 'https://stock-dashboard-proxy.<이름>.workers.dev' },
      { name: 'token', label: '접속 토큰', value: cur?.token ?? '', placeholder: '중계 서버의 PROXY_TOKEN' },
    ],
    submitLabel: thenSync ? '저장하고 동기화' : '저장',
    onSubmit: (v) => {
      if (!v.url.trim() && !v.token.trim()) {
        saveSyncSettings(null);
        buildSourceControls();
        return;
      }
      if (!v.token.trim()) throw new Error('접속 토큰을 입력하세요');
      const next = { url: normalizeUrl(v.url), token: v.token.trim() };
      saveSyncSettings(next);
      buildSourceControls();
      if (thenSync) void runSync();
      else
        checkProxy(next)
          .then((r) => showNote(`중계 서버에 연결했습니다 · NH 계좌: ${r.accounts.join(', ') || '없음'}`))
          .catch((ex) => showNote(`중계 서버 확인 실패: ${ex instanceof Error ? ex.message : String(ex)}`, true));
    },
  });
}

async function exportExcel() {
  if (!excelBook) {
    showNote('먼저 "① 엑셀 불러오기"로 주식.xlsx를 불러오세요.', true);
    return;
  }
  // 저장 직전의 파일을 다시 읽는다 (그사이 입금내역을 고쳤어도 지우지 않도록)
  let bytes = excelBytes;
  if (excelHandle) {
    try {
      bytes = new Uint8Array(await (await excelHandle.getFile()).arrayBuffer());
    } catch {
      /* 못 읽으면 처음 불러온 내용 사용 */
    }
  }
  if (!bytes) {
    showNote('새로고침해서 원본 파일이 메모리에 없습니다. 업데이트할 주식.xlsx를 골라 주세요.');
    void pickExcel('export');
    return;
  }
  try {
    const book = excelBook;
    const h = book.holdings;
    const usdKrw = bookUsdKrw(book);
    const date = (h.asOf ?? new Date().toISOString()).slice(0, 10);
    const groups = groupsForExport(store);
    book.dailyLog = upsertDaily(book.dailyLog, h, usdKrw, date);
    const sheets = buildExportSheets(book, groups);
    const monthly = monthlyFromSheets(sheets);
    // Summary 기말자산: 일별 기록이 시작된 달부터 '월별 자산추이'와 수식으로 연결
    const target = summaryEndCells(readWorkbook(bytes));
    const fromMonth = book.dailyLog[0]?.date.slice(0, 7);
    const links = target && fromMonth ? summaryLinkCells(book, target, monthly, fromMonth) : [];
    const out = upsertSheets(bytes, sheets, target && links.length ? { sheet: target.sheet, updates: links } : undefined);
    parseStockBook(readWorkbook(out), book.fileName); // 다시 읽히는지 확인
    let where: string;
    let saved = false;
    if (excelHandle) {
      try {
        if (excelHandle.requestPermission && (await excelHandle.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('권한 없음');
        const w = await excelHandle.createWritable();
        await w.write(out);
        await w.close();
        saved = true;
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') throw e;
        excelHandle = null; // 이 파일은 바로 저장할 수 없음 → 내려받기
      }
    }
    if (saved && excelHandle) {
      where = `${excelHandle.name}에 저장했습니다`;
    } else {
      const url = URL.createObjectURL(new Blob([out as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: book.fileName });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      where = `${book.fileName}을(를) 내려받았습니다. 구글 드라이브의 원본과 바꿔 주세요`;
    }
    excelBytes = out;
    book.groups = groups;
    book.monthlyValues = monthly;
    saveExcelLocal();
    showNote(
      `${where} · 보유종목 ${h.rows.length}개 · 그룹 ${groups.length}개 · 일별 자산추이 ${book.dailyLog.length}일 · 월별 자산추이 ${Object.keys(monthly).length}개월${links.length ? ` · Summary 기말자산 ${fromMonth}부터 연결` : ''}.`,
    );
  } catch (ex) {
    if ((ex as DOMException)?.name === 'AbortError') return;
    showNote(`엑셀을 저장하지 못했습니다: ${ex instanceof Error ? ex.message : String(ex)}. 엑셀에서 파일을 열어 두었다면 닫고 다시 시도하세요.`, true);
  }
}

// ─── 종목 목록 업데이트 ───────────────────────────────────────

/** 버튼 설명: 지금 쓰는 종목 목록 (공유 목록이면 다른 기기에서 받은 것도 포함) */
function instrumentsLabel() {
  const btn = $('instruments-btn');
  loadInstrumentList(loadSyncSettings())
    .then((l) => {
      const i = listInfo(l);
      const where = { shared: '모든 기기 공유 목록', local: '이 브라우저 저장본', bundled: '사이트 기본 목록 (국내만)' }[i.source];
      btn.title = `${where}: 국내 ${number(i.kr)} · 미국 ${number(i.us)}${i.updatedAt ? ` (${timeLabel(i.updatedAt)})` : ''}. 누르면 NH 최신 목록을 받아 모든 기기에 공유합니다`;
    })
    .catch(() => {
      btn.title = 'NH 국내 · 미국 종목 목록을 최신으로 받아 모든 기기에 공유합니다';
    });
}

async function updateInstrumentList() {
  const settings = loadSyncSettings();
  if (!settings?.token) {
    showNote('종목 목록은 중계 서버를 거쳐 받습니다. 먼저 "① 엑셀 불러오기"로 설정 시트가 있는 엑셀을 불러오세요.', true);
    return;
  }
  const btn = $<HTMLButtonElement>('instruments-btn');
  btn.disabled = true;
  try {
    const r = await refreshInstruments(settings, (msg) => showNote(msg));
    instrumentsLabel();
    showNote(
      r.shared
        ? `종목 목록을 최신으로 바꾸고 모든 기기에 공유했습니다 · 국내 ${number(r.kr)}종목 · 미국 ${number(r.us)}종목. 다른 기기는 다음에 열 때 이 목록을 씁니다.`
        : `종목 목록을 이 브라우저에만 저장했습니다 (공유 실패: ${r.error}) · 국내 ${number(r.kr)} · 미국 ${number(r.us)}`,
      !r.shared,
    );
  } catch (ex) {
    showNote(`종목 목록을 받지 못했습니다: ${ex instanceof Error ? ex.message : String(ex)}`, true);
  } finally {
    btn.disabled = false;
  }
}

// ─── 사진으로 계좌 업데이트 ───────────────────────────────────

function pickPhotos() {
  if (!excelBook) {
    showNote('먼저 "① 엑셀 불러오기"로 주식.xlsx를 불러오세요. 사진에서 읽은 종목은 엑셀의 계좌에 반영됩니다.', true);
    return;
  }
  $<HTMLInputElement>('photo-input').click();
}

async function updateFromPhotos(files: File[]) {
  if (!excelBook) return;
  const book = excelBook;
  const usd = bookUsdKrw(book);
  const accounts = holdingAccounts();
  const totals = Object.fromEntries(Object.entries(accountTotals(book.holdings, usd)).map(([a, t]) => [a, t.value + t.cash]));
  try {
    const listPromise = loadInstruments(loadSyncSettings()).catch((): Instrument[] => []); // 보유 종목에 없는 종목은 NH 종목 목록에서
    const texts = await recognizeImages(files, (msg) => showNote(msg));
    const list = await listPromise;
    const results = texts.map((t) => {
      const r = parseAccountScreen(t, accounts);
      r.account ??= guessAccountByTotal(r.total, totals) ?? (files.length === 1 && holdAccount !== 'ALL' ? holdAccount : null);
      const m = matchHoldings(r, book.holdings);
      return { ...m, rows: fillFromInstruments(m.rows, list) };
    });
    showNote(`사진 ${files.length}장을 읽었습니다. 확인 화면에서 값을 확인하고 적용하세요.`);
    openPhotoReview(results, accounts, usd, (list) => {
      let h = book.holdings;
      for (const r of list) {
        h = applyPhoto(h, r.account, r.rows, r.cashKRW, r.cashUSD, usd);
        // 새로 들어온 종목 키가 그룹에 없으면 그대로 미분류
      }
      holdingsChanged(h);
      holdAccount = list.length === 1 ? list[0].account : 'ALL';
      renderHoldings();
      showNote(`${list.map((r) => r.account).join(', ')} 계좌를 사진 값으로 바꿨습니다. "② 최신 정보 가져오기"로 현재가를 맞추고 "③ 엑셀 업데이트"로 저장하세요.`);
    });
  } catch (ex) {
    showNote(`사진을 읽지 못했습니다: ${ex instanceof Error ? ex.message : String(ex)}`, true);
  }
}

// ─── 계좌별 보유 종목 (엑셀 · 동기화) ─────────────────────────

/** 대시보드에서 쓰는 계좌 목록: 입금내역 계좌 + 보유종목에 있는 계좌 */
function holdingAccounts(): string[] {
  if (!excelBook) return [];
  const h = excelBook.holdings;
  return [...new Set([...excelBook.depositAccounts, ...h.rows.map((r) => r.account), ...h.cash.map((c) => c.account)])];
}

const isApiAccount = (account: string) => !!excelBook?.holdings.syncedAccounts.includes(account);

function addStockDialog(groupId: string | null) {
  if (excelBook) dialogHolding(undefined, groupId);
  else dialogManualStock(groupId);
}

function dialogHolding(original: { account: string; key: string } | undefined, groupId: string | null) {
  if (!excelBook) return;
  const h = excelBook.holdings;
  const cur = original ? h.rows.find((r) => r.account === original.account && holdingKey(r) === original.key) : undefined;
  if (original && !cur) return;
  const account = cur?.account ?? (holdAccount !== 'ALL' ? holdAccount : holdingAccounts()[0] ?? '');
  const accounts = holdingAccounts();
  const group = cur ? (store.members[holdingKey(cur)] ?? UNGROUPED_ID) : (groupId ?? UNGROUPED_ID);
  openForm({
    title: cur ? `${cur.name} 수정` : '종목 추가',
    description: cur && isApiAccount(cur.account)
      ? `${cur.account} 계좌는 NH 동기화로 채워집니다. 여기서 고쳐도 다음 동기화 때 증권사 값으로 바뀝니다.`
      : '증권사 앱의 계좌 화면을 보고 입력하세요. 매입금액 = 평가금 − 평가손익 입니다. 종목코드를 넣으면 동기화 때 현재가가 자동으로 반영됩니다.',
    fields: [
      { name: 'account', label: '계좌', type: 'select', value: account, options: accounts.map((a) => ({ value: a, label: a })) },
      { name: 'name', label: '종목 이름', value: cur?.name ?? '', placeholder: 'TIGER 미국S&P500', required: true },
      { name: 'code', label: '종목코드 (선택)', value: cur?.code ?? '', placeholder: '360750 · SCHD', hint: '국내는 6자리 숫자, 미국은 티커' },
      { name: 'currency', label: '통화', type: 'select', value: cur?.currency ?? 'KRW', options: [{ value: 'KRW', label: '원 (KRW)' }, { value: 'USD', label: '달러 (USD)' }] },
      { name: 'quantity', label: '수량', type: 'number', step: 'any', value: cur?.quantity ?? null, required: true },
      { name: 'costKRW', label: '매입금액 (원)', type: 'number', step: 'any', value: cur?.costKRW ?? null, hint: '비우면 평균단가 × 수량으로 계산' },
      { name: 'avgPrice', label: '평균단가 (종목 통화, 선택)', type: 'number', step: 'any', value: cur?.avgPrice || null },
      { name: 'price', label: '현재가 (종목 통화, 선택)', type: 'number', step: 'any', value: cur?.price ?? null, hint: '종목코드가 있으면 동기화 때 자동으로 바뀝니다' },
      { name: 'group', label: '그룹', type: 'select', value: group, options: groupOptions() },
    ],
    submitLabel: cur ? '저장' : '추가',
    onSubmit: (v) => {
      const qty = parseNumber(v.quantity) ?? 0;
      const cost = parseNumber(v.costKRW);
      const currency = v.currency as Currency;
      let avg = parseNumber(v.avgPrice) ?? 0;
      if (!avg && cost && qty && currency === 'KRW') avg = cost / qty;
      const row: HoldingRow = { account: v.account, code: v.code, name: v.name, currency, quantity: qty, avgPrice: avg, price: parseNumber(v.price), costKRW: cost };
      const next = upsertHolding(h, row, original);
      const key = holdingKey({ code: v.code.trim().toUpperCase(), name: v.name.trim() });
      let st = assignStock(store, key, v.group === UNGROUPED_ID ? null : v.group);
      if (original && original.key !== key && !next.rows.some((r) => holdingKey(r) === original.key)) st = assignStock(st, original.key, null);
      store = st;
      persist();
      holdAccount = v.account;
      holdingsChanged(next);
    },
  });
}

function confirmDeleteHolding(account: string, key: string) {
  if (!excelBook) return;
  const r = excelBook.holdings.rows.find((x) => x.account === account && holdingKey(x) === key);
  if (!r) return;
  openConfirm('종목 삭제', `${account} 계좌의 '${r.name}'을(를) 보유 종목에서 지웁니다. 엑셀에는 "③ 엑셀 업데이트"를 해야 반영됩니다.`, '삭제', () =>
    holdingsChanged(removeHolding(excelBook!.holdings, account, key)),
  );
}

function dialogCash(account: string | null) {
  if (!excelBook) return;
  const h = excelBook.holdings;
  const accounts = holdingAccounts();
  const acc = account ?? accounts[0] ?? '';
  const amount = (a: string, c: Currency) => h.cash.find((x) => x.account === a && x.currency === c)?.amount ?? null;
  openForm({
    title: account ? `${account} 현금` : '계좌 현금',
    description: '예수금 · 현금성자산을 입력합니다.',
    fields: [
      ...(account ? [] : [{ name: 'account', label: '계좌', type: 'select' as const, value: acc, options: accounts.map((a) => ({ value: a, label: a })) }]),
      { name: 'krw', label: '원화 (원)', type: 'number', step: 'any', value: amount(acc, 'KRW') },
      { name: 'usd', label: '달러 (USD)', type: 'number', step: 'any', value: amount(acc, 'USD') },
    ],
    onSubmit: (v) => {
      const a = account ?? v.account;
      let next = setCash(h, a, 'KRW', parseNumber(v.krw) ?? 0);
      next = setCash(next, a, 'USD', parseNumber(v.usd) ?? 0);
      holdAccount = a;
      holdingsChanged({ ...next, asOf: next.asOf ?? new Date().toISOString() });
    },
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
  for (const t of txs) if (t.code && t.name && !names.has(t.code)) names.set(t.code, t.name); // 지금은 없는 종목의 배당
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
  const excel = !!excelBook && model.source === 'excel';
  $('hold-toolbar').hidden = !excel;
  let ps = positions().sort((a, b) => b.valueKRW - a.valueKRW);
  let cashMap = model.cash(accountIds());
  if (excel) {
    const accounts = holdingAccounts();
    if (holdAccount !== 'ALL' && !accounts.includes(holdAccount)) holdAccount = 'ALL';
    const totals = accountTotals(excelBook!.holdings, model.usdKrw);
    segButtons(
      $('hold-account-seg'),
      [{ id: 'ALL', label: '전체' }, ...accounts.map((a) => ({ id: a, label: `${a}${totals[a] ? ` ${wonShort(totals[a].value + totals[a].cash)}` : ''}` }))],
      (id) => {
        holdAccount = id;
        renderHoldings();
      },
    );
    pressed($('hold-account-seg'), holdAccount);
    if (holdAccount !== 'ALL') {
      ps = ps.filter((p) => p.accountId === holdAccount);
      cashMap = { [holdAccount]: cashMap[holdAccount] ?? 0 };
    } else {
      ps.sort((a, b) => accounts.indexOf(a.accountId ?? '') - accounts.indexOf(b.accountId ?? '') || b.valueKRW - a.valueKRW);
    }
    $('cash-edit').textContent = holdAccount === 'ALL' ? '현금 수정' : `${holdAccount} 현금 수정`;
  }
  const multi = excel ? holdAccount === 'ALL' : model.accountFilter && accountIds().length > 1;
  const cash = Object.values(cashMap).reduce((a, b) => a + b, 0);
  const total = ps.reduce((s, p) => s + p.valueKRW, 0) + cash || 1;
  const max = Math.max(1, ...ps.map((p) => p.valueKRW));
  $('hold-empty').hidden = ps.length > 0;
  $('hold-wrap').hidden = ps.length === 0;
  $('hold-empty').textContent = excel
    ? `${holdAccount === 'ALL' ? '' : `${holdAccount} 계좌에 `}보유 종목이 없습니다. "+ 종목 추가"로 입력하거나 "② 최신 정보 가져오기"로 NH 계좌를 채우세요.`
    : '보유 종목 정보는 동기화 후 표시됩니다. 그룹별 비중의 "+ 종목 직접 추가"로 입력한 종목은 여기에도 나옵니다.';
  const asOf = excel && excelBook!.holdings.asOf ? ` · ${timeLabel(excelBook!.holdings.asOf)} 기준` : '';
  $('hold-count').textContent = ps.length || cash ? `${aggregateByKey(ps).length}개 종목${cash ? ` · 현금 ${won(cash)}` : ''} · 합계 ${wonShort(total)}${asOf}` : '';
  $('hold-table').innerHTML = `<thead><tr><th>종목</th>${multi ? '<th class="left">계좌</th>' : ''}<th class="left">그룹</th><th>수량</th><th>평균단가</th><th>현재가</th><th>평가금</th><th>평가손익</th><th>수익률</th><th>비중</th><th></th></tr></thead>
    <tbody>${ps
      .map((p) => {
        const profit = p.valueKRW - p.costKRW;
        const rate = p.costKRW > 0 ? profit / p.costKRW : 0;
        const acc = p.accountId ?? '';
        const api = excel && isApiAccount(acc);
        const actions = excel
          ? `<button type="button" class="mini" data-act="edit-holding" data-account="${escapeHtml(acc)}" data-key="${escapeHtml(p.key)}" aria-label="${escapeHtml(p.name)} 수정">✎</button>
             <button type="button" class="mini danger" data-act="delete-holding" data-account="${escapeHtml(acc)}" data-key="${escapeHtml(p.key)}" aria-label="${escapeHtml(p.name)} 삭제">✕</button>`
          : `<button type="button" class="mini" data-act="edit-stock" data-key="${escapeHtml(p.key)}" aria-label="${escapeHtml(p.name)} 수정">✎</button>`;
        return `<tr>
          <td>${escapeHtml(p.name)}${p.code && p.code !== p.name ? `<span class="code">${escapeHtml(p.code)}</span>` : ''}${p.manual ? ' <span class="chip">직접</span>' : ''}</td>
          ${multi ? `<td class="left"><span class="chip"${api ? ' title="NH 동기화로 채운 계좌"' : ''}>${escapeHtml(excel ? acc : acc ? accountName(acc) : '-')}${api ? ' · API' : ''}</span></td>` : ''}
          <td class="left"><span class="name"><span class="swatch sm" style="background:${customColor(store.members[p.key] ?? UNGROUPED_ID)}"></span>${escapeHtml(groupNameOf(p.key))}</span></td>
          <td>${number(p.quantity)}</td>
          <td>${p.avgPrice ? unitPrice(p.avgPrice, p.currency) : '-'}</td>
          <td>${priceCell(p)}</td>
          <td>${won(p.valueKRW)}</td>
          <td>${p.price === null ? '-' : signed(profit, wonSigned(profit))}</td>
          <td>${p.price === null ? '-' : signed(rate, pctSigned(rate))}</td>
          <td>${pct(p.valueKRW / total, 1)}<span class="bar-cell"><span style="width:${(p.valueKRW / max) * 100}%"></span></span></td>
          <td class="actions">${actions}</td>
        </tr>`;
      })
      .join('')}</tbody>`;
}

main().catch((e) => {
  console.error(e);
  document.getElementById('app')!.insertAdjacentHTML('afterbegin', `<p class="card">데이터를 불러오지 못했습니다: ${escapeHtml(String(e))}</p>`);
});
