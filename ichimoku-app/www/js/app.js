// app.js — UI controller

import { DEFAULT_PARAMS, DEFAULT_FILTERS } from './engine.js';
import { Alpaca } from './alpaca.js';
import { runScan, loadSeries, fullUniverse, sortResults } from './scan.js';
import { load, save, clearBars, countBars } from './store.js';
import { TICKERS, SP500_SUBSET, NASDAQ100_SUBSET } from './tickers.js';
import { renderChart, purgeChart } from './chart.js';

const $ = (id) => document.getElementById(id);
const Cap = window.Capacitor;
const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const plugin = (name) => (Cap && Cap.Plugins ? Cap.Plugins[name] : null);

const PAGE = 60;
const state = {
  keys: load('keys', { key: '', secret: '' }),
  last: load('last_scan', null),   // { at, params, filters, results, stopped, scanned, total }
  running: false,
  stopFlag: false,
  liveResults: [],
  shown: PAGE,
  chart: null,                     // { result, tf }
};

// ─── Settings form <-> object ───────────────────────────────────────────────
const num = (id, d) => { const v = Number($(id).value); return Number.isFinite(v) ? v : d; };
const int = (id, d, lo = 1) => Math.max(lo, Math.round(num(id, d)));

function readForm() {
  const tfs = [...$('tfChips').querySelectorAll('input:checked')].map((i) => Number(i.value));
  const vol = $('f_vol').value;
  return {
    universe: $('universe').value,
    custom: $('custom').value,
    years: Number($('p_years').value),
    params: {
      tenkan: int('p_tenkan', 18), kijun: int('p_kijun', 52),
      senkou_b: int('p_senkou', 104), displacement: int('p_disp', 26),
      timeframes: tfs,
    },
    filters: {
      ...DEFAULT_FILTERS,
      require_tk_cross: $('f_tk').checked,
      require_chikou: $('f_chikou').checked,
      require_fresh: $('f_fresh').checked,
      min_strength_pct: num('f_strength', 0),
      require_reversal: $('f_reversal').checked,
      reversal_lookback: int('f_revlb', 20, 2),
      require_bounce: $('f_bounce').checked,
      bounce_tolerance_pct: num('f_btol', 3),
      bounce_lookback: int('f_blb', 10, 2),
      min_avg_volume: vol === 'custom' ? Math.max(0, num('f_volc', 0)) : Number(vol),
      _vol_preset: vol,
    },
  };
}

function writeForm(s) {
  if (!s) return;
  $('universe').value = s.universe ?? 'full';
  $('custom').value = s.custom ?? '';
  $('p_years').value = String(s.years ?? 3);
  const p = { ...DEFAULT_PARAMS, ...(s.params || {}) };
  $('p_tenkan').value = p.tenkan; $('p_kijun').value = p.kijun;
  $('p_senkou').value = p.senkou_b; $('p_disp').value = p.displacement;
  $('tfChips').querySelectorAll('input').forEach((i) => { i.checked = p.timeframes.includes(Number(i.value)); });
  const f = { ...DEFAULT_FILTERS, ...(s.filters || {}) };
  $('f_tk').checked = f.require_tk_cross; $('f_chikou').checked = f.require_chikou; $('f_fresh').checked = f.require_fresh;
  $('f_strength').value = f.min_strength_pct;
  $('f_reversal').checked = f.require_reversal; $('f_revlb').value = f.reversal_lookback;
  $('f_bounce').checked = f.require_bounce; $('f_btol').value = f.bounce_tolerance_pct; $('f_blb').value = f.bounce_lookback;
  const preset = f._vol_preset ?? String(f.min_avg_volume || 0);
  $('f_vol').value = [...$('f_vol').options].some((o) => o.value === preset) ? preset : 'custom';
  if ($('f_vol').value === 'custom') $('f_volc').value = f.min_avg_volume;
}

function refreshFormLabels() {
  const s = readForm();
  $('o_strength').textContent = `${s.filters.min_strength_pct.toFixed(1)}%`;
  $('o_revlb').textContent = s.filters.reversal_lookback;
  $('o_btol').textContent = `${s.filters.bounce_tolerance_pct.toFixed(1)}%`;
  $('volCustomWrap').hidden = $('f_vol').value !== 'custom';

  const p = s.params;
  const pl = `${p.tenkan} / ${p.kijun} / ${p.senkou_b} / ${p.displacement}`;
  $('paramNote').textContent = `${pl} · ${s.years}y`;
  $('paramLine').textContent = `${pl} · ${p.timeframes.map((t) => t + 'D').join(' ') || 'no timeframe'}`;

  const f = s.filters, on = [];
  if (f.require_tk_cross) on.push('TK');
  if (f.require_chikou) on.push('Chikou');
  if (f.require_fresh) on.push('Fresh');
  if (f.min_strength_pct > 0) on.push(`≥${f.min_strength_pct}%`);
  if (f.require_reversal) on.push('Reversal');
  if (f.require_bounce) on.push('Bounce');
  if (f.min_avg_volume > 0) on.push(`Vol ${fmtVol(f.min_avg_volume)}+`);
  $('filterNote').textContent = on.length ? on.join(' · ') : 'none';
  $('filterNote').classList.toggle('active', on.length > 0);
  $('btnScan').disabled = !p.timeframes.length;
}

function persistForm() {
  save('settings', readForm());
  refreshFormLabels();
}

// ─── Formatting ─────────────────────────────────────────────────────────────
const money = (x) => (x == null ? 'N/A' : '$' + (x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 0 }) : x.toFixed(x < 1 ? 4 : 2)));
const pct = (x, sign = true) => (x == null ? 'N/A' : `${sign && x > 0 ? '+' : ''}${x.toFixed(2)}%`);
function fmtVol(v) {
  if (!v) return 'N/A';
  if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return Math.round(v / 1e3) + 'K';
  return String(Math.round(v));
}
const dayStr = (d) => new Date(d * 86_400_000).toISOString().slice(0, 10);

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// ─── Universe ───────────────────────────────────────────────────────────────
function parseCustom(text) {
  return text.replace(/[\n;\s]+/g, ',').split(',')
    .map((t) => t.trim().toUpperCase())
    .filter((t) => /^[A-Z][A-Z.\-]{0,9}$/.test(t));
}

async function buildTickers(s, alpaca) {
  let base = [];
  if (s.universe === 'full') base = await fullUniverse(alpaca, { load, save });
  else if (s.universe === 'list') base = TICKERS;
  else if (s.universe === 'sp500') base = SP500_SUBSET;
  else if (s.universe === 'ndx') base = NASDAQ100_SUBSET;
  return [...new Set([...parseCustom(s.custom), ...base])];
}

// ─── Scan ───────────────────────────────────────────────────────────────────
function haveKeys() { return !!(state.keys.key && state.keys.secret); }

async function startScan() {
  if (state.running) return;
  if (!haveKeys()) { openSheet('settings'); toast('Add your Alpaca keys first'); return; }
  const s = readForm();
  if (!s.params.timeframes.length) { toast('Pick at least one timeframe'); return; }

  const alpaca = new Alpaca(state.keys.key, state.keys.secret);
  state.running = true; state.stopFlag = false; state.liveResults = []; state.shown = PAGE;
  setScanningUI(true);
  progress({ done: 0, total: 0, matches: 0, phase: s.universe === 'full' ? 'Loading US stock list' : 'Starting' });

  let tickers;
  try {
    tickers = await buildTickers(s, alpaca);
  } catch (e) {
    finishScan(); toast(e.message || String(e), 4000); return;
  }
  if (!tickers.length) { finishScan(); toast('No tickers to scan — add some or pick a universe'); return; }

  const startedAt = new Date();
  let lastRender = 0;
  const meta = { at: startedAt.toISOString(), params: s.params, filters: s.filters, years: s.years, total: tickers.length };
  try {
    const out = await runScan({
      tickers, params: s.params, filters: s.filters, years: s.years, alpaca,
      shouldStop: () => state.stopFlag,
      onProgress: progress,
      onHit: (r) => {
        state.liveResults.push(r);
        if (Date.now() - lastRender > 1500) { lastRender = Date.now(); showResults({ ...meta, results: sortResults(state.liveResults), live: true }); }
      },
    });
    state.last = { ...meta, results: out.results, stopped: out.stopped, scanned: out.scanned };
    save('last_scan', state.last);
    showResults(state.last);
    toast(out.stopped ? `Stopped · ${out.results.length} stocks so far` : `Scan complete · ${out.results.length} stocks`);
  } catch (e) {
    const partial = e.partial || sortResults(state.liveResults);
    state.last = { ...meta, results: partial, stopped: true, scanned: partial.length, error: e.message };
    save('last_scan', state.last);
    showResults(state.last);
    toast(e.message || String(e), 5000);
  } finally {
    finishScan();
  }
}

function finishScan() {
  state.running = false;
  setScanningUI(false);
}

function setScanningUI(on) {
  $('btnScan').hidden = on;
  $('btnStop').hidden = !on;
  $('progressWrap').hidden = !on;
  document.querySelectorAll('main input, main select, main textarea').forEach((el) => {
    if (!el.closest('#resultsSection')) el.disabled = on;
  });
}

function progress({ done, total, matches, phase, extra }) {
  $('progressText').textContent = phase + (extra ? ` · ${extra}` : '');
  $('progressCount').textContent = total ? `${done.toLocaleString()} / ${total.toLocaleString()} · ${matches} hits` : '';
  $('progressFill').style.width = total ? `${(100 * done) / total}%` : '0%';
}

// ─── Results ────────────────────────────────────────────────────────────────
function flatRows(scan) {
  const showTfs = [...$('showTfChips').querySelectorAll('input:checked')].map((i) => Number(i.value));
  const tkOnly = $('tkOnly').checked;
  const q = $('searchBox').value.trim().toUpperCase();
  const rows = [];
  for (const r of scan.results) {
    if (q && !r.ticker.includes(q)) continue;
    for (const [tfStr, hit] of Object.entries(r.hits)) {
      const tf = Number(tfStr);
      if (!showTfs.includes(tf)) continue;
      if (tkOnly && !hit.tk_cross) continue;
      rows.push({ r, tf, hit });
    }
  }
  const sort = $('sortBy').value;
  const cmp = {
    str_desc: (a, b) => b.hit.strength_pct - a.hit.strength_pct,
    str_asc: (a, b) => a.hit.strength_pct - b.hit.strength_pct,
    vol_desc: (a, b) => b.r.avg_vol - a.r.avg_vol,
    az: (a, b) => a.r.ticker.localeCompare(b.r.ticker) || a.tf - b.tf,
    tfs: (a, b) => Object.keys(b.r.hits).length - Object.keys(a.r.hits).length || b.hit.strength_pct - a.hit.strength_pct,
  }[sort];
  return rows.sort(cmp);
}

function statsHtml(hit, r) {
  const rev = hit.reversal || {}, b = hit.bounce || {};
  const items = [
    ['Close', money(hit.close)],
    ['Cloud top', money(hit.cloud_top)],
    ['Cloud bot', money(hit.cloud_bot)],
    ['Tenkan', money(hit.tenkan)],
    ['Kijun', money(hit.kijun)],
    ['Thickness', pct(hit.thickness_pct, false)],
    ['Avg vol 20d', fmtVol(r.avg_vol)],
    ['Kijun dist', pct(b.kijun_dist_pct)],
    ['Reversal', rev.was_below ? `${rev.bars_since_below}b ago, −${rev.max_drawdown_pct.toFixed(1)}%` : 'No'],
  ];
  return items.map(([k, v]) => `<div class="stat"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
}

function flagsHtml(hit) {
  const b = hit.bounce || {};
  const f = (on, label) => `<span class="flag${on ? ' on' : ''}">${label}</span>`;
  let out = f(hit.tk_cross, 'TK cross') + f(hit.chikou_confirmed, 'Chikou');
  if (b.kijun_bounce || b.cloud_bounce) {
    const where = [b.kijun_bounce && 'Kijun', b.cloud_bounce && 'Cloud'].filter(Boolean).join(' + ');
    out += f(true, `${where} bounce · ${b.bounce_bars_ago}b ago, ${pct(b.bounce_depth_pct)}`);
  }
  return out;
}

function showResults(scan) {
  $('emptyState').hidden = !!scan;
  $('resultsSection').hidden = !scan;
  if (!scan) return;

  const rows = flatRows(scan);
  const when = new Date(scan.at);
  const totalHits = scan.results.reduce((n, r) => n + Object.keys(r.hits).length, 0);
  $('resultsTitle').textContent = `${scan.results.length} stock${scan.results.length === 1 ? '' : 's'} breaking out`;
  $('resultsMeta').textContent = scan.live
    ? 'Scanning… results update live'
    : `${totalHits} timeframe hits · ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${scan.stopped ? ' · partial' : ''}${rows.length !== totalHits ? ` · showing ${rows.length}` : ''}`;
  $('btnCsv').disabled = !scan.results.length;

  const slice = rows.slice(0, state.shown);
  $('results').innerHTML = slice.length
    ? slice.map(({ r, tf, hit }, i) => `
      <button class="card" data-i="${i}">
        <div class="card-top">
          <span class="ticker">${r.ticker}</span>
          <span class="badge tf${tf}">${tf}D</span>
          <span class="card-price">${money(hit.close)}</span>
          <span class="badge str">+${hit.strength_pct.toFixed(2)}% above cloud</span>
        </div>
        <div class="stats">${statsHtml(hit, r)}</div>
        <div class="flags">${flagsHtml(hit)}</div>
      </button>`).join('')
    : '<div class="empty"><div class="empty-title">No matches</div><div>Nothing fits the current display filters.</div></div>';
  $('btnMore').hidden = rows.length <= state.shown;
  $('btnMore').textContent = `Show more (${rows.length - state.shown} left)`;
  $('results')._rows = slice;
}

// ─── CSV export (same columns as the Streamlit app) ─────────────────────────
function toCsv(scan) {
  const cols = ['scan_time', 'ticker', 'timeframe', 'close', 'cloud_top', 'cloud_bot', 'tenkan', 'kijun', 'strength_pct', 'thickness_pct', 'tk_cross', 'chikou_confirmed', 'avg_vol_20d', 'kijun_dist_pct', 'kijun_bounce', 'cloud_bounce', 'bounce_bars_ago', 'bounce_depth_pct', 'reversal_was_below', 'reversal_bars_ago', 'reversal_drawdown_pct', 'last_bar'];
  const ts = new Date(scan.at);
  const pad = (n) => String(n).padStart(2, '0');
  const scanTime = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;
  const r4 = (x) => (x == null ? '' : Math.round(x * 1e4) / 1e4);
  const B = (x) => (x ? 'True' : 'False');
  const lines = [cols.join(',')];
  for (const r of scan.results) {
    for (const [tf, h] of Object.entries(r.hits)) {
      const b = h.bounce || {}, rv = h.reversal || {};
      lines.push([
        scanTime, r.ticker, `${tf}D`, r4(h.close), r4(h.cloud_top), r4(h.cloud_bot), r4(h.tenkan), r4(h.kijun),
        h.strength_pct, h.thickness_pct, B(h.tk_cross), B(h.chikou_confirmed), r.avg_vol,
        b.kijun_dist_pct ?? '', B(b.kijun_bounce), B(b.cloud_bounce), b.bounce_bars_ago ?? '', b.bounce_depth_pct ?? '',
        B(rv.was_below), rv.bars_since_below ?? '', rv.max_drawdown_pct ?? '', dayStr(r.last_day),
      ].join(','));
    }
  }
  return { csv: lines.join('\n') + '\n', name: `ichimoku_breakouts_${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}.csv` };
}

async function exportCsv() {
  if (!state.last || !state.last.results.length) return;
  const { csv, name } = toCsv(state.last);
  const Filesystem = plugin('Filesystem'), Share = plugin('Share');
  if (isNative && Filesystem && Share) {
    try {
      const { uri } = await Filesystem.writeFile({ path: name, data: csv, directory: 'CACHE', encoding: 'utf8' });
      await Share.share({ title: name, files: [uri], dialogTitle: 'Save or send CSV' });
    } catch (e) {
      if (!/cancel/i.test(e.message || '')) toast('Could not share CSV: ' + (e.message || e));
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ─── Chart sheet ────────────────────────────────────────────────────────────
async function openChart(r, tf) {
  state.chart = { r, tf };
  openSheet('chart');
  $('chTicker').textContent = r.ticker;
  const tfs = Object.keys(r.hits).map(Number);
  $('chTfChips').innerHTML = tfs.map((t) => `<label class="chip tf${t}"><input type="radio" name="chtf" value="${t}" ${t === tf ? 'checked' : ''}><span>${t}D · +${r.hits[t].strength_pct.toFixed(1)}%</span></label>`).join('');
  drawChartFor(tf);
}

async function drawChartFor(tf) {
  const { r } = state.chart;
  state.chart.tf = tf;
  const hit = r.hits[tf];
  $('chBadges').innerHTML = `<span class="badge str">+${hit.strength_pct.toFixed(2)}%</span>`;
  $('chStats').innerHTML = statsHtml(hit, r);
  $('chFlags').innerHTML = flagsHtml(hit);
  const el = $('chart');
  purgeChart(el);
  try {
    const years = state.last?.years || 3;
    const series = await loadSeries(r.ticker, new Alpaca(state.keys.key, state.keys.secret), years);
    if (!series) throw new Error('No price data');
    if (state.chart?.r !== r || state.chart.tf !== tf) return;
    const params = { ...DEFAULT_PARAMS, ...(state.last?.params || {}) };
    await renderChart(el, series, tf, params);
  } catch (e) {
    el.innerHTML = `<div class="chart-loading">${e.message || 'Chart unavailable'}</div>`;
  }
}

// ─── Sheets & navigation ────────────────────────────────────────────────────
function openSheet(name) {
  const el = $(name === 'chart' ? 'chartSheet' : 'settingsSheet');
  el.hidden = false;
  $('toast').hidden = true;
  if (name === 'settings') {
    $('s_key').value = state.keys.key; $('s_secret').value = state.keys.secret;
    $('keyStatus').textContent = ''; $('keyStatus').className = 'status';
    countBars().then((n) => { $('cacheStatus').textContent = n ? `${n.toLocaleString()} tickers cached` : 'Empty'; });
  }
}

function closeTopSheet() {
  for (const id of ['settingsSheet', 'chartSheet']) {
    const el = $(id);
    if (!el.hidden) {
      el.hidden = true;
      if (id === 'chartSheet') { purgeChart($('chart')); state.chart = null; }
      return true;
    }
  }
  return false;
}

function updateKeyBanner() { $('keyBanner').hidden = haveKeys(); }

async function saveKeys() {
  state.keys = { key: $('s_key').value.trim(), secret: $('s_secret').value.trim() };
  save('keys', state.keys);
  updateKeyBanner();
  const st = $('keyStatus');
  if (!haveKeys()) { st.textContent = 'Both fields are needed'; st.className = 'status err'; return; }
  st.textContent = 'Testing…'; st.className = 'status';
  try {
    await new Alpaca(state.keys.key, state.keys.secret).check();
    st.textContent = '✓ Connected to Alpaca'; st.className = 'status ok';
  } catch (e) {
    st.textContent = e.message || String(e); st.className = 'status err';
  }
}

// ─── Wire up ────────────────────────────────────────────────────────────────
function init() {
  writeForm(load('settings', null));
  refreshFormLabels();
  updateKeyBanner();
  if (state.last) showResults(state.last);

  document.querySelectorAll('main input, main select, main textarea').forEach((el) => {
    if (el.closest('#resultsSection')) return;
    el.addEventListener('input', persistForm);
    el.addEventListener('change', persistForm);
  });
  $('btnResetParams').addEventListener('click', () => {
    const s = readForm();
    writeForm({ ...s, params: { ...DEFAULT_PARAMS, timeframes: s.params.timeframes } });
    persistForm();
  });

  $('btnScan').addEventListener('click', startScan);
  $('btnStop').addEventListener('click', () => { state.stopFlag = true; $('progressText').textContent = 'Stopping…'; });

  const rerender = () => { state.shown = PAGE; if (state.last) showResults(state.last); };
  ['sortBy', 'tkOnly'].forEach((id) => $(id).addEventListener('change', rerender));
  $('showTfChips').addEventListener('change', rerender);
  $('searchBox').addEventListener('input', rerender);
  $('btnMore').addEventListener('click', () => { state.shown += PAGE; showResults(state.last); });
  $('btnCsv').addEventListener('click', exportCsv);
  $('results').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const row = $('results')._rows[Number(card.dataset.i)];
    if (row) openChart(row.r, row.tf);
  });
  $('chTfChips').addEventListener('change', (e) => drawChartFor(Number(e.target.value)));

  $('btnSettings').addEventListener('click', () => openSheet('settings'));
  document.querySelectorAll('[data-open="settings"]').forEach((b) => b.addEventListener('click', () => openSheet('settings')));
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeTopSheet));
  $('btnSaveKeys').addEventListener('click', saveKeys);
  $('btnClearCache').addEventListener('click', async () => {
    await clearBars();
    save('universe_full_v1', null);
    $('cacheStatus').textContent = 'Cleared';
  });

  const App = plugin('App');
  if (isNative && App) {
    App.addListener('backButton', () => {
      if (closeTopSheet()) return;
      if (state.running) { App.minimizeApp(); return; }
      App.exitApp();
    });
    App.getInfo().then((i) => { $('versionLine').textContent = `v${i.version} (${i.build})`; }).catch(() => {});
  }
}

init();
