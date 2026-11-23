// chart.js — Ichimoku chart (port of build_ichimoku_chart), Plotly finance build

import { aggregateBars, computeIchimoku } from './engine.js';

let plotlyPromise = null;
function loadPlotly() {
  if (window.Plotly) return Promise.resolve(window.Plotly);
  if (!plotlyPromise) {
    plotlyPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/plotly-finance.min.js';
      s.onload = () => resolve(window.Plotly);
      s.onerror = () => reject(new Error('Could not load chart library'));
      document.head.appendChild(s);
    });
  }
  return plotlyPromise;
}

const iso = (day) => new Date(day * 86_400_000).toISOString().slice(0, 10);

function futureBusinessDays(lastDay, count, step) {
  const out = [];
  let d = lastDay, k = 0;
  while (out.length < count) {
    d++;
    const wd = new Date(d * 86_400_000).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    if (++k % step === 0) out.push(iso(d));
  }
  return out;
}

const nn = (x) => (typeof x === 'number' && !Number.isNaN(x) ? x : null);

export async function renderChart(el, daily, tf, params) {
  const Plotly = await loadPlotly();
  const s = aggregateBars(daily, tf, true);
  const ichi = computeIchimoku(s, params);
  const n = s.c.length;
  const disp = params.displacement;
  const x = s.t.map(iso);
  const xf = futureBusinessDays(s.t[n - 1], disp, tf);
  const xAll = x.concat(xf);

  const traces = [];
  let bullish = true;
  if (ichi) {
    // Cloud continues `disp` bars into the future from the unshifted spans.
    const futA = [], futB = [];
    for (let k = 1; k <= disp; k++) {
      futA.push(nn(ichi.senkouARaw[n - 1 - disp + k]));
      futB.push(nn(ichi.senkouBRaw[n - 1 - disp + k]));
    }
    const a = ichi.cloudA.map(nn).concat(futA);
    const b = ichi.cloudB.map(nn).concat(futB);
    bullish = (ichi.futureA ?? 0) >= (ichi.futureB ?? 0);
    const g = 'rgba(0,255,136,', r = 'rgba(239,68,68,';
    traces.push(
      { x: xAll, y: a, name: 'Senkou A', type: 'scatter', mode: 'lines', line: { color: (bullish ? g : r) + '0.55)', width: 1 }, hovertemplate: 'A %{y:$.2f}<extra></extra>' },
      { x: xAll, y: b, name: 'Senkou B', type: 'scatter', mode: 'lines', line: { color: (bullish ? r : g) + '0.55)', width: 1 }, fill: 'tonexty', fillcolor: (bullish ? g : r) + '0.10)', hovertemplate: 'B %{y:$.2f}<extra></extra>' },
      { x, y: ichi.tenkanSen.map(nn), name: 'Tenkan', type: 'scatter', mode: 'lines', line: { color: '#38bdf8', width: 1.5 }, hovertemplate: 'T %{y:$.2f}<extra></extra>' },
      { x, y: ichi.kijunSen.map(nn), name: 'Kijun', type: 'scatter', mode: 'lines', line: { color: '#f97316', width: 1.5 }, hovertemplate: 'K %{y:$.2f}<extra></extra>' },
    );
    if (n > disp) {
      traces.push({ x: x.slice(0, n - disp), y: s.c.slice(disp), name: 'Chikou', type: 'scatter', mode: 'lines', line: { color: '#c084fc', width: 1, dash: 'dot' }, hovertemplate: 'Ch %{y:$.2f}<extra></extra>' });
    }
  }
  traces.push({
    x, open: s.o, high: s.h, low: s.l, close: s.c, name: 'Price', type: 'candlestick',
    increasing: { line: { color: '#00ff88', width: 1 }, fillcolor: '#00ff88' },
    decreasing: { line: { color: '#ef4444', width: 1 }, fillcolor: '#ef4444' },
  });

  const avg20 = s.v.map((_, i) => (i < 19 ? null : s.v.slice(i - 19, i + 1).reduce((p, q) => p + q, 0) / 20));
  traces.push(
    { x, y: s.v, type: 'bar', name: 'Volume', yaxis: 'y2', showlegend: false, marker: { color: s.c.map((c, i) => (c >= s.o[i] ? 'rgba(0,255,136,0.5)' : 'rgba(239,68,68,0.5)')) }, hovertemplate: 'Vol %{y:,.0f}<extra></extra>' },
    { x, y: avg20, type: 'scatter', mode: 'lines', yaxis: 'y2', showlegend: false, line: { color: 'rgba(251,191,36,0.7)', width: 1.2, dash: 'dot' }, hovertemplate: 'Avg %{y:,.0f}<extra></extra>' },
  );

  // Start zoomed to roughly the last 6 months (in bars of this timeframe) plus the future cloud
  const show = Math.min(n, Math.round(126 / tf));
  const startX = x[n - show];
  const visible = s.l.slice(n - show).concat(s.h.slice(n - show));
  if (ichi) {
    for (let i = n - show; i < n; i++) {
      if (nn(ichi.cloudA[i])) visible.push(ichi.cloudA[i]);
      if (nn(ichi.cloudB[i])) visible.push(ichi.cloudB[i]);
    }
  }
  const lo = Math.min(...visible), hi = Math.max(...visible), pad = (hi - lo) * 0.06;

  const layout = {
    paper_bgcolor: '#0a0e1a', plot_bgcolor: '#0a0e1a',
    font: { color: '#94a3b8', family: 'system-ui, Roboto, sans-serif', size: 10 },
    margin: { l: 44, r: 8, t: 54, b: 28 },
    showlegend: true,
    legend: { orientation: 'h', x: 0, y: 1.0, yanchor: 'bottom', font: { size: 9 }, bgcolor: 'rgba(0,0,0,0)' },
    hovermode: 'x unified',
    hoverlabel: { bgcolor: '#0d1424', bordercolor: '#1e293b', font: { size: 11 } },
    dragmode: 'pan',
    bargap: 0.1,
    xaxis: {
      type: 'date', range: [startX, xAll[xAll.length - 1]], rangeslider: { visible: false },
      showgrid: false, color: '#475569', tickfont: { size: 9 }, anchor: 'y2', fixedrange: false,
      rangeselector: {
        x: 0, y: 1.1, yanchor: 'bottom',
        bgcolor: '#0d1424', activecolor: '#1e3a5f', bordercolor: 'rgba(255,255,255,0.08)', font: { size: 10, color: '#94a3b8' },
        buttons: [
          { count: 3, label: '3M', step: 'month', stepmode: 'backward' },
          { count: 6, label: '6M', step: 'month', stepmode: 'backward' },
          { count: 1, label: '1Y', step: 'year', stepmode: 'backward' },
          { count: 2, label: '2Y', step: 'year', stepmode: 'backward' },
          { step: 'all', label: 'All' },
        ],
      },
    },
    yaxis: { domain: [0.24, 1], range: [lo - pad, hi + pad], gridcolor: 'rgba(255,255,255,0.05)', color: '#475569', tickfont: { size: 9 }, tickprefix: '$', autorange: false, fixedrange: false },
    yaxis2: { domain: [0, 0.18], showgrid: false, color: '#475569', tickfont: { size: 8 }, tickformat: '.2s', fixedrange: true },
  };

  el.innerHTML = '';
  await Plotly.newPlot(el, traces, layout, {
    displayModeBar: false, responsive: true, scrollZoom: true, doubleClick: 'reset',
  });

  // Re-fit the price axis to whatever date window is visible after pan/zoom/range buttons
  const cloudLo = ichi ? ichi.cloudA.map((a, i) => { const b = ichi.cloudB[i]; return nn(a) && nn(b) ? Math.min(a, b) : nn(a) ?? nn(b); }) : [];
  const cloudHi = ichi ? ichi.cloudA.map((a, i) => { const b = ichi.cloudB[i]; return nn(a) && nn(b) ? Math.max(a, b) : nn(a) ?? nn(b); }) : [];
  let busy = false;
  el.on('plotly_relayout', (ev) => {
    if (busy) return;
    let r0 = ev['xaxis.range[0]'], r1 = ev['xaxis.range[1]'];
    if (ev['xaxis.range']) [r0, r1] = ev['xaxis.range'];
    if (ev['xaxis.autorange']) { r0 = x[0]; r1 = xAll[xAll.length - 1]; }
    if (!r0 || !r1) return;
    const a = String(r0).slice(0, 10), b = String(r1).slice(0, 10);
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) {
      if (x[i] < a || x[i] > b) continue;
      if (s.l[i] < mn) mn = s.l[i];
      if (s.h[i] > mx) mx = s.h[i];
      if (cloudLo[i] != null && cloudLo[i] < mn) mn = cloudLo[i];
      if (cloudHi[i] != null && cloudHi[i] > mx) mx = cloudHi[i];
    }
    if (!Number.isFinite(mn)) return;
    const p = (mx - mn) * 0.06 || mx * 0.02;
    busy = true;
    Plotly.relayout(el, { 'yaxis.range': [mn - p, mx + p] }).finally(() => { busy = false; });
  });
}

export function purgeChart(el) {
  if (window.Plotly) { try { window.Plotly.purge(el); } catch { /* ignore */ } }
  el.innerHTML = '<div class="chart-loading">Loading chart…</div>';
}
