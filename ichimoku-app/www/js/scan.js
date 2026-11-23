// scan.js — two-phase pipeline (port of fetch_all_data + scan_universe)
//   Phase 1: scan whatever is fresh in the on-device cache
//   Phase 2: bulk-download the rest from Alpaca, scanning each batch as it lands

import { scanTicker, bestStrength } from './engine.js';
import { isoDaysAgo, dayNum, StopError } from './alpaca.js';
import { getBars, putBars } from './store.js';
import { TICKERS } from './tickers.js';

export const CACHE_TTL_HOURS = 8;
const BATCH_SIZE = 500;

const yieldUI = () => new Promise((r) => setTimeout(r, 0));

export async function runScan({ tickers, params, filters, years, alpaca, onProgress, onHit, shouldStop }) {
  const total = tickers.length;
  const startDays = Math.round(365 * years + 30);
  const startIso = isoDaysAgo(startDays);
  const wantStartDay = dayNum(Date.now()) - startDays;
  const results = [];
  let done = 0;
  let stopped = false;
  const report = (phase, extra = '') => onProgress({ done, total, matches: results.length, phase, extra });

  const scanOne = (t, s) => {
    const r = scanTicker(t, s, params, filters, true);
    if (r) { results.push(r); onHit && onHit(r); }
  };

  // ── Phase 1: cache ────────────────────────────────────────────────────────
  report('Checking cache');
  const cached = await getBars(tickers);
  const fresh = (e) => e
    && (Date.now() - e.fetched) / 3_600_000 < CACHE_TTL_HOURS
    && e.startDay <= wantStartDay + 7;

  const toDownload = [];
  let i = 0;
  for (const t of tickers) {
    const e = cached.get(t);
    if (fresh(e)) {
      scanOne(t, e.series);
      done++;
      if (++i % 40 === 0) { report('Scanning cached data'); await yieldUI(); }
      if (shouldStop()) { stopped = true; break; }
    } else {
      toDownload.push(t);
    }
  }
  cached.clear();

  // ── Phase 2: download + scan ──────────────────────────────────────────────
  if (!stopped && toDownload.length) {
    alpaca.shouldStop = shouldStop;
    const batches = [];
    for (let k = 0; k < toDownload.length; k += BATCH_SIZE) batches.push(toDownload.slice(k, k + BATCH_SIZE));

    try {
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const label = `Downloading batch ${b + 1}/${batches.length}`;
        report(label);
        const data = await alpaca.fetchBars(batch, startIso, (page) => report(label, `page ${page}`));
        let j = 0;
        for (const t of batch) {
          const s = data.get(t);
          if (s && s.c.length) scanOne(t, s);
          done++;
          if (++j % 40 === 0) { report(`Scanning batch ${b + 1}/${batches.length}`); await yieldUI(); }
        }
        await putBars(data, wantStartDay);
        report(label);
        if (shouldStop()) { stopped = true; break; }
      }
    } catch (e) {
      if (e instanceof StopError) stopped = true;
      else throw Object.assign(e, { partial: sortResults(results) });
    }
  }

  report(stopped ? 'Stopped' : 'Done');
  return { results: sortResults(results), stopped, scanned: done };
}

export function sortResults(results) {
  return results.slice().sort((a, b) => bestStrength(b) - bestStrength(a));
}

/** Series for the chart: cache first (even if stale), else a single fetch. */
export async function loadSeries(ticker, alpaca, years) {
  const c = await getBars([ticker]);
  if (c.has(ticker)) return c.get(ticker).series;
  const startDays = Math.round(365 * years + 30);
  const data = await alpaca.fetchBars([ticker], isoDaysAgo(startDays));
  const s = data.get(ticker);
  if (s) await putBars(new Map([[ticker, s]]), dayNum(Date.now()) - startDays);
  return s || null;
}

// ─── Universe ───────────────────────────────────────────────────────────────
const UNIVERSE_KEY = 'universe_full_v1';

export async function fullUniverse(alpaca, { load, save }) {
  const cachedList = load(UNIVERSE_KEY, null);
  if (cachedList && Date.now() - cachedList.at < 24 * 3_600_000 && cachedList.list.length > 1000) {
    return cachedList.list;
  }
  try {
    const list = await alpaca.listAssets();
    if (list.length > 1000) {
      save(UNIVERSE_KEY, { at: Date.now(), list });
      return list;
    }
  } catch (e) {
    console.warn('asset list failed', e);
  }
  try {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': 'IchimokuScanner/1.0 (contact@example.com)' },
    });
    if (res.ok) {
      const data = await res.json();
      const list = [...new Set(Object.values(data).map((v) => String(v.ticker).toUpperCase()))]
        .filter((t) => /^[A-Z]{1,5}$/.test(t));
      if (list.length > 1000) return list;
    }
  } catch { /* fall through */ }
  return [...TICKERS];
}
