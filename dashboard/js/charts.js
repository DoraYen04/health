// Chart.js 包裝：細線、圓點 ≥8px、單一 Y 軸、hover 提示（index 模式＝十字準線式）

const charts = new Map();

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function baseOptions(unit, { legend = false, yMin } = {}) {
  const grid = css('--grid');
  const ink = css('--text-secondary');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: legend, position: 'top', align: 'start', labels: { color: ink, boxWidth: 12, boxHeight: 3, usePointStyle: false } },
      tooltip: {
        callbacks: {
          label: (c) => (c.parsed.y === null ? null : `${c.dataset.label}：${c.parsed.y}${unit ? ` ${unit}` : ''}`),
        },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: ink, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
      y: { grid: { color: grid }, border: { display: false }, ticks: { color: ink }, suggestedMin: yMin },
    },
  };
}

export function lineChart(canvasId, { labels, datasets, unit, legend }) {
  destroy(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx || !window.Chart) return;
  const chart = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map((d) => ({
        label: d.label,
        data: d.data,
        borderColor: d.color,
        backgroundColor: d.color,
        borderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBorderColor: css('--surface-1'),
        pointBorderWidth: 2,
        spanGaps: true,
        tension: 0.25,
        borderDash: d.dash || [],
        ...(d.dash ? { pointRadius: 0, pointHoverRadius: 0 } : {}),
      })),
    },
    options: baseOptions(unit, { legend: legend ?? datasets.length > 1 }),
  });
  charts.set(canvasId, chart);
}

export function barChart(canvasId, { labels, datasets, unit, legend, refLine }) {
  destroy(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx || !window.Chart) return;
  const ds = datasets.map((d) => ({
    type: 'bar',
    label: d.label,
    data: d.data,
    backgroundColor: d.color,
    borderRadius: { topLeft: 4, topRight: 4 },
    borderSkipped: 'bottom',
    maxBarThickness: 22,
  }));
  if (refLine) {
    ds.push({
      type: 'line', label: refLine.label, data: labels.map(() => refLine.value),
      borderColor: css('--text-muted'), borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 0,
    });
  }
  const chart = new window.Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: ds },
    options: baseOptions(unit, { legend: legend ?? ds.length > 1, yMin: 0 }),
  });
  charts.set(canvasId, chart);
}

export function destroy(id) {
  if (charts.has(id)) { charts.get(id).destroy(); charts.delete(id); }
}

export function destroyAll() {
  for (const id of [...charts.keys()]) destroy(id);
}

export function color(n) {
  return css(`--series-${n}`);
}
