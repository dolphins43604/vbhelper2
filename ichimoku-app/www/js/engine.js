// engine.js — Ichimoku Cloud scanner engine (port of scanner.py)
// Pure math, no network, no DOM. Works in the app and in Node.
//
// A "series" here is a plain object of parallel arrays:
//   { t: [dayNumber...], o: [...], h: [...], l: [...], c: [...], v: [...] }
// where dayNumber = Math.floor(epochMs / 86_400_000).

export const DEFAULT_PARAMS = {
  tenkan: 18,
  kijun: 52,
  senkou_b: 104,
  displacement: 26,
  timeframes: [1, 2, 3],
};

export const DEFAULT_FILTERS = {
  require_tk_cross: false,
  require_chikou: false,
  require_fresh: false,
  min_strength_pct: 0,
  min_avg_volume: 0,
  require_reversal: false,
  reversal_lookback: 20,
  require_bounce: false,
  bounce_tolerance_pct: 3.0,
  bounce_lookback: 10,
  bounce_min_recovery_pct: 0.5,
};

const isNum = (x) => typeof x === 'number' && !Number.isNaN(x);
const round2 = (x) => Math.round(x * 100) / 100;
// pandas-style row min/max that skips NaN (NaN only if both are NaN)
const nanMax = (a, b) => (isNum(a) ? (isNum(b) ? Math.max(a, b) : a) : (isNum(b) ? b : NaN));
const nanMin = (a, b) => (isNum(a) ? (isNum(b) ? Math.min(a, b) : a) : (isNum(b) ? b : NaN));

// ─── Bar aggregation ─────────────────────────────────────────────────────────
// Groups consecutive trading days into N-day bars.
// alignEnd=true (app default): groups are counted back from the most recent
// bar, so the last N-day bar always contains today's close.
// alignEnd=false reproduces the original Python behaviour (groups counted from
// the first bar of history; leftover days at the end are dropped).
export function aggregateBars(s, n, alignEnd = true) {
  if (n === 1) return s;
  const len = s.c.length;
  const out = { t: [], o: [], h: [], l: [], c: [], v: [] };
  const start = alignEnd ? len % n : 0;
  for (let i = start; i + n - 1 < len; i += n) {
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (let j = i; j < i + n; j++) {
      if (s.h[j] > hi) hi = s.h[j];
      if (s.l[j] < lo) lo = s.l[j];
      vol += s.v[j] || 0;
    }
    out.t.push(s.t[i]);
    out.o.push(s.o[i]);
    out.h.push(hi);
    out.l.push(lo);
    out.c.push(s.c[i + n - 1]);
    out.v.push(vol);
  }
  return out;
}

// Rolling (max(high) + min(low)) / 2 over `win` bars; NaN until window is full.
function midpoint(h, l, win) {
  const n = h.length;
  const out = new Array(n).fill(NaN);
  if (win < 1) return out;
  // Monotonic deques for O(n)
  const dqMax = [], dqMin = [];
  for (let i = 0; i < n; i++) {
    while (dqMax.length && h[dqMax[dqMax.length - 1]] <= h[i]) dqMax.pop();
    dqMax.push(i);
    while (dqMin.length && l[dqMin[dqMin.length - 1]] >= l[i]) dqMin.pop();
    dqMin.push(i);
    if (dqMax[0] <= i - win) dqMax.shift();
    if (dqMin[0] <= i - win) dqMin.shift();
    if (i >= win - 1) out[i] = (h[dqMax[0]] + l[dqMin[0]]) / 2;
  }
  return out;
}

function shift(arr, k) {
  const n = arr.length;
  const out = new Array(n).fill(NaN);
  for (let i = k; i < n; i++) out[i] = arr[i - k];
  return out;
}

// ─── Ichimoku ────────────────────────────────────────────────────────────────
export function computeIchimoku(s, p = DEFAULT_PARAMS) {
  const { tenkan, kijun, senkou_b, displacement } = p;
  const n = s.c.length;
  if (n < senkou_b + displacement + 5) return null;

  const tenkanSen = midpoint(s.h, s.l, tenkan);
  const kijunSen = midpoint(s.h, s.l, kijun);
  const senkouARaw = tenkanSen.map((x, i) => (x + kijunSen[i]) / 2);
  const senkouBRaw = midpoint(s.h, s.l, senkou_b);
  const cloudA = shift(senkouARaw, displacement);
  const cloudB = shift(senkouBRaw, displacement);

  const aNow = cloudA[n - 1], bNow = cloudB[n - 1];
  if (!isNum(aNow) || !isNum(bNow)) return null;

  const cloudTop = Math.max(aNow, bNow);
  const cloudBot = Math.min(aNow, bNow);

  let prevCloudTop = null;
  if (n >= 2 && isNum(cloudA[n - 2]) && isNum(cloudB[n - 2])) {
    prevCloudTop = Math.max(cloudA[n - 2], cloudB[n - 2]);
  }

  const futureA = isNum(senkouARaw[n - 1]) ? senkouARaw[n - 1] : null;
  const futureB = isNum(senkouBRaw[n - 1]) ? senkouBRaw[n - 1] : null;

  let chikouConfirmed = false;
  if (n > displacement + 1) {
    const ca = cloudA[n - displacement - 1], cb = cloudB[n - displacement - 1];
    if (isNum(ca) && isNum(cb)) chikouConfirmed = s.c[n - 1] > Math.max(ca, cb);
  }

  return {
    tenkanSen, kijunSen, senkouARaw, senkouBRaw, cloudA, cloudB,
    futureA, futureB, cloudTop, cloudBot, prevCloudTop, chikouConfirmed,
  };
}

// ─── Reversal: was the close below the cloud within the last N bars? ────────
export function wasBelowCloudRecently(s, ichi, lookback) {
  const n = s.c.length;
  const none = { was_below: false, bars_since_below: null, max_drawdown_pct: 0 };
  if (lookback < 2 || n < lookback + 1) return none;

  const from = n - lookback - 1, to = n - 1; // [from, to)
  const len = to - from;
  let lastPos = -1, maxDD = -Infinity;
  for (let i = from; i < to; i++) {
    const bot = nanMin(ichi.cloudA[i], ichi.cloudB[i]);
    if (isNum(bot) && s.c[i] < bot) {
      lastPos = i - from;
      const dd = ((bot - s.c[i]) / bot) * 100;
      if (dd > maxDD) maxDD = dd;
    }
  }
  if (lastPos < 0) return none;
  return { was_below: true, bars_since_below: len - lastPos, max_drawdown_pct: round2(maxDD) };
}

// ─── Bounce off Kijun / cloud top ────────────────────────────────────────────
export function detectBounce(s, ichi, lookback = 10, tolerancePct = 3.0, minRecoveryPct = 0.5) {
  const res = {
    kijun_bounce: false, cloud_bounce: false,
    bounce_bars_ago: null, bounce_depth_pct: null, kijun_dist_pct: null,
  };
  const n = s.c.length;
  if (n < lookback + 2) return res;

  const close = s.c[n - 1];
  const kNow = ichi.kijunSen[n - 1];
  if (isNum(kNow) && kNow > 0) res.kijun_dist_pct = round2(((close - kNow) / kNow) * 100);

  const from = n - lookback - 1, to = n - 1;
  const check = (levelAt) => {
    let bestAgo = null, bestDepth = null;
    for (let i = from; i < to; i++) {
      const level = levelAt(i);
      if (!isNum(level) || level <= 0) continue;
      const pct = ((s.l[i] - level) / level) * 100;
      if (pct >= -tolerancePct && pct <= tolerancePct) {
        const ago = lookback - (i - from);
        const recovery = ((close - level) / level) * 100;
        if (recovery >= minRecoveryPct && (bestAgo === null || ago < bestAgo)) {
          bestAgo = ago;
          bestDepth = round2(pct);
        }
      }
    }
    return [bestAgo !== null, bestAgo, bestDepth];
  };

  const [kHit, kAgo, kDepth] = check((i) => ichi.kijunSen[i]);
  if (kHit) {
    res.kijun_bounce = true;
    res.bounce_bars_ago = kAgo;
    res.bounce_depth_pct = kDepth;
  }
  const [cHit, cAgo, cDepth] = check((i) => nanMax(ichi.cloudA[i], ichi.cloudB[i]));
  if (cHit) {
    res.cloud_bounce = true;
    if (res.bounce_bars_ago === null || cAgo < res.bounce_bars_ago) {
      res.bounce_bars_ago = cAgo;
      res.bounce_depth_pct = cDepth;
    }
  }
  return res;
}

// ─── Breakout detection on the most recent bar ───────────────────────────────
export function detectBreakout(s, params, filters) {
  const ichi = computeIchimoku(s, params);
  if (!ichi) return null;
  const n = s.c.length;
  const close = s.c[n - 1];
  const { cloudTop, cloudBot } = ichi;
  if (!isNum(close)) return null;
  if (close <= cloudTop) return null;

  const tenkanVal = ichi.tenkanSen[n - 1];
  const kijunVal = ichi.kijunSen[n - 1];
  const tkCross = isNum(tenkanVal) && isNum(kijunVal) && tenkanVal > kijunVal;

  const reversal = wasBelowCloudRecently(s, ichi, filters.reversal_lookback ?? 20);
  if (filters.require_reversal && !reversal.was_below) return null;
  if (filters.require_tk_cross && !tkCross) return null;
  if (filters.require_chikou && !ichi.chikouConfirmed) return null;
  if (filters.require_fresh) {
    if (ichi.prevCloudTop === null || n < 2) return null;
    if (s.c[n - 2] > ichi.prevCloudTop) return null;
  }

  const strength = ((close - cloudTop) / cloudTop) * 100;
  const thickness = cloudTop > 0 ? ((cloudTop - cloudBot) / cloudTop) * 100 : 0;
  if (strength < (filters.min_strength_pct ?? 0)) return null;

  const bounce = detectBounce(
    s, ichi,
    filters.bounce_lookback ?? 10,
    filters.bounce_tolerance_pct ?? 3.0,
    filters.bounce_min_recovery_pct ?? 0.5,
  );
  if (filters.require_bounce && !(bounce.kijun_bounce || bounce.cloud_bounce)) return null;

  return {
    close,
    cloud_top: cloudTop,
    cloud_bot: cloudBot,
    tenkan: isNum(tenkanVal) ? tenkanVal : null,
    kijun: isNum(kijunVal) ? kijunVal : null,
    tk_cross: tkCross,
    chikou_confirmed: ichi.chikouConfirmed,
    strength_pct: round2(strength),
    thickness_pct: round2(thickness),
    reversal,
    bounce,
  };
}

export function avgVolume20(s) {
  const v = s.v.slice(-20).filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

// ─── Per-ticker scan ─────────────────────────────────────────────────────────
// Returns { ticker, avg_vol, last_day, hits: { 1: {...}, 2: {...} } } or null.
export function scanTicker(ticker, s, params, filters, alignEnd = true) {
  try {
    const minBars = params.senkou_b + params.displacement + 10;
    if (!s || s.c.length < minBars) return null;

    const avgVol = avgVolume20(s);
    const minVol = filters.min_avg_volume || 0;
    if (minVol > 0 && (!isNum(avgVol) || avgVol < minVol)) return null;

    const hits = {};
    for (const tf of params.timeframes || [1, 2, 3]) {
      const hit = detectBreakout(aggregateBars(s, tf, alignEnd), params, filters);
      if (hit) hits[tf] = hit;
    }
    if (!Object.keys(hits).length) return null;
    return {
      ticker,
      avg_vol: isNum(avgVol) ? Math.round(avgVol) : 0,
      last_day: s.t[s.t.length - 1],
      hits,
    };
  } catch (e) {
    return null;
  }
}

export function bestStrength(r) {
  return Math.max(...Object.values(r.hits).map((h) => h.strength_pct));
}
