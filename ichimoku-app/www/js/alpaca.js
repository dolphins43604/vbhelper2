// alpaca.js — Alpaca Markets REST client (SIP feed, IEX fallback)
// In the Android app, Capacitor's native HTTP layer handles these requests,
// so there are no browser CORS limits.

const DATA_URL = 'https://data.alpaca.markets/v2/stocks/bars';
const MIN_INTERVAL_MS = 330;   // ≈180 requests/min, under the free 200/min cap
const MAX_RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const dayNum = (ms) => Math.floor(ms / 86_400_000);

export class StopError extends Error {
  constructor() { super('stopped'); this.name = 'StopError'; }
}

class SipDenied extends Error {
  constructor() { super('SIP feed not permitted'); this.name = 'SipDenied'; }
}

export class Alpaca {
  // 'sip' = consolidated volume from all US exchanges (free plan allows it for
  // data older than 15 minutes). Falls back to 'iex' if the account refuses.
  static feed = 'sip';

  constructor(key, secret) {
    this.key = (key || '').trim();
    this.secret = (secret || '').trim();
    this._last = 0;
    this.shouldStop = () => false;
  }

  get headers() {
    return {
      'APCA-API-KEY-ID': this.key,
      'APCA-API-SECRET-KEY': this.secret,
      Accept: 'application/json',
    };
  }

  get tradingBase() {
    // Paper keys start with "PK"; live keys with "AK".
    return this.key.startsWith('PK')
      ? 'https://paper-api.alpaca.markets'
      : 'https://api.alpaca.markets';
  }

  async _get(url) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (this.shouldStop()) throw new StopError();
      const wait = this._last + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this._last = Date.now();

      let res;
      try {
        res = await fetch(url, { headers: this.headers });
      } catch (e) {
        if (attempt === MAX_RETRIES) throw new Error(`Network error: ${e.message || e}`);
        await sleep(3000 * attempt);
        continue;
      }
      if (res.ok) return res.json();
      if (res.status === 401 || res.status === 403) {
        if (res.status === 403 && url.includes('feed=sip')) throw new SipDenied();
        throw new Error('Alpaca rejected your API keys (check them in Settings).');
      }
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after')) || 0;
        await sleep(Math.max(ra * 1000, 15000 * attempt));
        continue;
      }
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(3000 * attempt);
        continue;
      }
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch { /* ignore */ }
      throw new Error(`Alpaca HTTP ${res.status} ${msg}`.trim());
    }
    throw new Error('Alpaca: too many retries');
  }

  /** Quick credential check. */
  async check() {
    const url = `${DATA_URL}?symbols=SPY&timeframe=1Day&limit=5&feed=iex&start=${isoDaysAgo(14)}`;
    await this._get(url);
    return true;
  }

  /**
   * Daily, split+dividend adjusted bars for many symbols (one bulk request,
   * paginated). Returns Map(symbol -> series).
   */
  async fetchBars(symbols, startIso, onPage) {
    try {
      return await this._fetchBars(symbols, startIso, onPage, Alpaca.feed);
    } catch (e) {
      if (!(e instanceof SipDenied)) throw e;
      Alpaca.feed = 'iex';
      return this._fetchBars(symbols, startIso, onPage, 'iex');
    }
  }

  async _fetchBars(symbols, startIso, onPage, feed) {
    const out = new Map();
    let token = null;
    let page = 0;
    do {
      const q = new URLSearchParams({
        symbols: symbols.join(','),
        timeframe: '1Day',
        start: startIso,
        adjustment: 'all',
        feed,
        limit: '10000',
        sort: 'asc',
      });
      // Free plan: SIP data must be at least 15 minutes old
      if (feed === 'sip') q.set('end', new Date(Date.now() - 16 * 60_000).toISOString());
      if (token) q.set('page_token', token);
      const json = await this._get(`${DATA_URL}?${q}`);
      const bars = json.bars || {};
      for (const sym of Object.keys(bars)) {
        let s = out.get(sym);
        if (!s) { s = { t: [], o: [], h: [], l: [], c: [], v: [] }; out.set(sym, s); }
        for (const b of bars[sym]) {
          if (b.o == null || b.h == null || b.l == null || b.c == null) continue;
          s.t.push(dayNum(Date.parse(b.t)));
          s.o.push(b.o); s.h.push(b.h); s.l.push(b.l); s.c.push(b.c); s.v.push(b.v || 0);
        }
      }
      token = json.next_page_token || null;
      page++;
      if (onPage) onPage(page);
    } while (token);
    return out;
  }

  /** All active, tradable US-listed stock symbols (excludes OTC). */
  async listAssets() {
    const json = await this._get(`${this.tradingBase}/v2/assets?status=active&asset_class=us_equity`);
    return json
      .filter((a) => a.tradable && a.exchange !== 'OTC' && /^[A-Z]{1,5}$/.test(a.symbol))
      .map((a) => a.symbol);
  }
}

export function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) + 'T00:00:00Z';
}
