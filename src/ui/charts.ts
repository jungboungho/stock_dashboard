import { Chart, registerables, type Plugin, type TooltipItem } from 'chart.js';
import type { DailySnapshot } from '../types';
import { monthLabel, pctSigned, shortDate, won, wonCompact, wonSigned } from '../format';

Chart.register(...registerables);

/** CSS 변수에서 현재 테마 색을 읽는다 */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function applyChartDefaults() {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 11;
  Chart.defaults.color = token('--text-muted');
  Chart.defaults.borderColor = token('--grid');
  Chart.defaults.animation = false;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.plugins.legend.display = false; // 범례는 HTML 로 직접 그림
  Object.assign(Chart.defaults.plugins.tooltip, {
    backgroundColor: token('--surface'),
    titleColor: token('--text-primary'),
    bodyColor: token('--text-secondary'),
    footerColor: token('--text-primary'),
    borderColor: token('--border'),
    borderWidth: 1,
    padding: 10,
    cornerRadius: 8,
    displayColors: false,
    titleFont: { weight: 600 },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyChart = Chart<any, any, any>;
type CrossChart = AnyChart & { $hoverIndex?: number | null };

/** 세로 기준선 (crosshair) */
const crosshair: Plugin = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const idx = (chart as CrossChart).$hoverIndex;
    if (idx == null) return;
    const x = chart.scales.x.getPixelForValue(idx);
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = token('--text-muted');
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

const dateTicks = (labels: string[]) => ({
  maxTicksLimit: window.innerWidth < 640 ? 4 : 7,
  maxRotation: 0,
  autoSkip: true,
  autoSkipPadding: 16,
  callback: (_: unknown, i: number) => shortDate(labels[i] ?? ''),
});

// ─── 자산 추이: 금액 패널 + 수익률 패널 (x축 공유, 기준선 · 툴팁 동기화) ──────────

export interface TrendCharts {
  value: AnyChart;
  ret: AnyChart;
}

export type ReturnMode = 'simple' | 'twr';

export function renderTrend(
  valueCanvas: HTMLCanvasElement,
  returnCanvas: HTMLCanvasElement,
  snaps: DailySnapshot[],
  mode: ReturnMode,
  prev?: TrendCharts,
): TrendCharts {
  prev?.value.destroy();
  prev?.ret.destroy();

  const labels = snaps.map((s) => s.date);
  const returns = snaps.map((s) => (mode === 'twr' ? s.twr : s.simpleReturn));
  const left = 64; // 두 패널의 y축 폭을 맞춰서 x 좌표를 정렬

  const tooltipLines = (i: number) => {
    const s = snaps[i];
    return [
      `평가금   ${won(s.value)}`,
      `원금      ${won(s.principal)}`,
      `수익금   ${wonSigned(s.profit)}`,
      `수익률   ${pctSigned(s.simpleReturn)} (단순) · ${pctSigned(s.twr)} (TWR)`,
      ...(s.netFlow ? [`입출금   ${wonSigned(s.netFlow)}`] : []),
    ];
  };

  const value = new Chart(valueCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '원금',
          data: snaps.map((s) => s.principal),
          borderColor: token('--principal'),
          backgroundColor: token('--principal-fill'),
          borderWidth: 2,
          stepped: true,
          pointRadius: 0,
          fill: 'origin',
          order: 2,
        },
        {
          label: '평가금',
          data: snaps.map((s) => s.value),
          borderColor: token('--value-line'),
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBorderWidth: 2,
          pointHoverBorderColor: token('--surface'),
          pointHoverBackgroundColor: token('--value-line'),
          fill: { target: 0, above: token('--up-fill'), below: token('--down-fill') },
          tension: 0,
          order: 1,
        },
      ],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 4 } },
      scales: {
        x: { ticks: { display: false }, grid: { display: false }, border: { display: false } },
        y: {
          afterFit: (s) => (s.width = left),
          ticks: { callback: (v) => wonCompact(Number(v)), maxTicksLimit: 5 },
          border: { display: false },
        },
      },
      plugins: {
        tooltip: {
          filter: (item: TooltipItem<'line'>) => item.datasetIndex === 1,
          callbacks: {
            title: (items) => labels[items[0].dataIndex],
            label: (item) => tooltipLines(item.dataIndex),
          },
        },
      },
    },
    plugins: [crosshair as Plugin<'line'>],
  });

  const ret = new Chart(returnCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: mode === 'twr' ? '시간가중수익률' : '단순 수익률',
          data: returns,
          borderColor: token('--text-secondary'),
          borderWidth: 2,
          pointRadius: 0,
          fill: { target: { value: 0 }, above: token('--up-fill'), below: token('--down-fill') },
        },
      ],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: dateTicks(labels), grid: { display: false }, border: { display: false } },
        y: {
          afterFit: (s) => (s.width = left),
          ticks: { callback: (v) => pctSigned(Number(v), 0), maxTicksLimit: 4 },
          border: { display: false },
          grid: { color: (c) => (c.tick.value === 0 ? token('--text-muted') : token('--grid')) },
        },
      },
      plugins: { tooltip: { enabled: false } },
    },
    plugins: [crosshair as Plugin<'line'>],
  });

  // 동기화: 어느 패널에 마우스를 올려도 두 패널에 기준선, 위 패널에 툴팁
  const sync = (src: AnyChart, e: MouseEvent) => {
    const rect = src.canvas.getBoundingClientRect();
    const raw = src.scales.x.getValueForPixel(e.clientX - rect.left);
    if (raw == null) return;
    const idx = Math.max(0, Math.min(labels.length - 1, Math.round(raw)));
    for (const c of [value, ret] as AnyChart[]) {
      (c as CrossChart).$hoverIndex = idx;
    }
    const meta = value.getDatasetMeta(1).data[idx];
    value.tooltip?.setActiveElements([{ datasetIndex: 1, index: idx }], { x: meta.x, y: meta.y });
    value.setActiveElements([{ datasetIndex: 1, index: idx }]);
    value.update('none');
    ret.update('none');
  };
  const clear = () => {
    for (const c of [value, ret] as AnyChart[]) (c as CrossChart).$hoverIndex = null;
    value.tooltip?.setActiveElements([], { x: 0, y: 0 });
    value.setActiveElements([]);
    value.update('none');
    ret.update('none');
  };
  for (const c of [value, ret] as AnyChart[]) {
    c.canvas.onmousemove = (e) => sync(c, e);
    c.canvas.onmouseleave = clear;
  }

  return { value, ret };
}

// ─── 기간 비교 ───────────────────────────────────────────────

export interface ComparePoint {
  day: number;
  date: string;
  value: number;
}

export function renderCompare(canvas: HTMLCanvasElement, a: ComparePoint[], b: ComparePoint[], prev?: AnyChart): AnyChart {
  prev?.destroy();
  const n = Math.max(a.length, b.length);
  const labels = Array.from({ length: n }, (_, i) => i + 1);
  const series = (pts: ComparePoint[], color: string, name: string) => ({
    label: name,
    data: labels.map((_, i) => pts[i]?.value ?? null),
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 4,
    spanGaps: false,
  });
  const chart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets: [series(a, token('--series-1'), '기간 A'), series(b, token('--series-2'), '기간 B')] },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          title: { display: true, text: '경과 영업일' },
          ticks: { maxTicksLimit: 8, maxRotation: 0 },
          grid: { display: false },
          border: { display: false },
        },
        y: {
          ticks: { callback: (v) => pctSigned(Number(v), 0), maxTicksLimit: 5 },
          border: { display: false },
          grid: { color: (c) => (c.tick.value === 0 ? token('--text-muted') : token('--grid')) },
        },
      },
      plugins: {
        tooltip: {
          displayColors: true,
          callbacks: {
            title: (items) => `${items[0].dataIndex + 1}영업일째`,
            label: (item) => {
              const pts = item.datasetIndex === 0 ? a : b;
              const p = pts[item.dataIndex];
              return p ? `${item.dataset.label} ${pctSigned(p.value)}  (${p.date})` : '';
            },
          },
        },
      },
    },
    plugins: [crosshairFollow as Plugin<'line'>],
  });
  return chart;
}

/** 마우스 위치를 따라가는 기준선 (단일 차트용) */
const crosshairFollow: Plugin = {
  id: 'crosshairFollow',
  afterEvent(chart, args) {
    const c = chart as CrossChart;
    const e = args.event;
    if (e.type === 'mouseout') c.$hoverIndex = null;
    else if (e.x != null && args.inChartArea) {
      const raw = chart.scales.x.getValueForPixel(e.x);
      c.$hoverIndex = raw == null ? null : Math.round(raw);
    }
    args.changed = true;
  },
  afterDatasetsDraw: crosshair.afterDatasetsDraw,
};

// ─── 그룹 비중 도넛 ──────────────────────────────────────────

export function renderDonut(canvas: HTMLCanvasElement, labels: string[], values: number[], colors: string[], prev?: AnyChart): AnyChart {
  prev?.destroy();
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const chart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors,
          borderColor: token('--surface'),
          borderWidth: 2,
          hoverOffset: 4,
        },
      ],
    },
    options: {
      cutout: '64%',
      plugins: {
        tooltip: {
          displayColors: true,
          callbacks: { label: (item) => `${item.label}  ${won(Number(item.raw))} · ${((Number(item.raw) / total) * 100).toFixed(1)}%` },
        },
      },
    },
  });
  return chart;
}

// ─── 월별 배당 ───────────────────────────────────────────────

export function renderDividends(canvas: HTMLCanvasElement, months: string[], amounts: number[], highlight: (m: string) => boolean, prev?: AnyChart): AnyChart {
  prev?.destroy();
  const on = token('--series-1');
  const off = token('--grid');
  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [
        {
          label: '배당금',
          data: amounts,
          backgroundColor: months.map((m) => (highlight(m) ? on : off)),
          hoverBackgroundColor: months.map((m) => (highlight(m) ? on : token('--text-muted'))),
          borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: 'bottom',
          maxBarThickness: 18,
          categoryPercentage: 0.8,
          barPercentage: 0.9,
        },
      ],
    },
    options: {
      scales: {
        x: { ticks: { callback: (_, i) => monthLabel(months[i]), maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false }, border: { display: false } },
        y: { ticks: { callback: (v) => wonCompact(Number(v)), maxTicksLimit: 4 }, border: { display: false } },
      },
      plugins: {
        tooltip: { callbacks: { title: (items) => `${months[items[0].dataIndex].replace('-', '년 ')}월`, label: (item) => won(Number(item.raw)) } },
      },
    },
  });
  return chart;
}

// ─── 연초 대비 수익률 (연도별 곡선) ─────────────────────────────

export interface YtdSeries {
  year: number;
  color: string;
  points: { month: number; ytd: number; date: string }[];
}

export function renderYtd(canvas: HTMLCanvasElement, series: YtdSeries[], goal: number | null, prev?: AnyChart): AnyChart {
  prev?.destroy();
  const labels = Array.from({ length: 12 }, (_, i) => `${i + 1}월`);
  const datasets: any[] = series.map((s) => ({
    label: `${s.year}년`,
    data: labels.map((_, i) => s.points.find((p) => p.month === i + 1)?.ytd ?? null),
    borderColor: s.color,
    backgroundColor: s.color,
    borderWidth: 2,
    pointRadius: 3,
    pointHoverRadius: 5,
    pointBorderColor: token('--surface'),
    pointBorderWidth: 1.5,
    spanGaps: true,
  }));
  if (goal !== null) {
    datasets.push({
      label: `목표 ${pctSigned(goal, 0)}`,
      data: labels.map(() => goal),
      borderColor: token('--text-muted'),
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 0,
      pointHoverRadius: 0,
    });
  }
  const chart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, border: { display: false } },
        y: {
          ticks: { callback: (v) => pctSigned(Number(v), 0), maxTicksLimit: 6 },
          border: { display: false },
          grid: { color: (c) => (c.tick.value === 0 ? token('--text-muted') : token('--grid')) },
        },
      },
      plugins: {
        tooltip: {
          displayColors: true,
          filter: (item) => item.raw !== null,
          callbacks: { label: (item) => `${item.dataset.label}  ${pctSigned(Number(item.raw))}` },
        },
      },
    },
    plugins: [crosshairFollow as Plugin<'line'>],
  });
  return chart;
}
