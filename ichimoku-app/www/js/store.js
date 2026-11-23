// store.js — on-device storage
//   • IndexedDB: cached daily bars per ticker (compact Float32 packing)
//   • localStorage: settings, API keys, last scan results

const DB_NAME = 'ichimoku';
const STORE = 'bars';
let _db = null;

function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function pack(s) {
  const n = s.c.length;
  const buf = new Float32Array(n * 6);
  const cols = [s.t, s.o, s.h, s.l, s.c, s.v];
  cols.forEach((col, k) => buf.set(col, k * n));
  return buf.buffer;
}

function unpack(buf) {
  const a = new Float32Array(buf);
  const n = a.length / 6;
  const col = (k) => Array.from(a.subarray(k * n, (k + 1) * n));
  return { t: col(0), o: col(1), h: col(2), l: col(3), c: col(4), v: col(5) };
}

/** Save many { ticker: series } in one transaction. */
export async function putBars(map, startDay) {
  try {
    const db = await openDb();
    const now = Date.now();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      for (const [ticker, s] of map) st.put({ f: now, s: startDay, buf: pack(s) }, ticker);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('cache write failed', e);
  }
}

/**
 * Load cached series. Returns Map(ticker -> { series, fetched, startDay }).
 * Missing tickers are simply absent.
 */
export async function getBars(tickers) {
  const out = new Map();
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const st = tx.objectStore(STORE);
      for (const t of tickers) {
        const r = st.get(t);
        r.onsuccess = () => {
          if (r.result) out.set(t, { series: unpack(r.result.buf), fetched: r.result.f, startDay: r.result.s });
        };
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('cache read failed', e);
  }
  return out;
}

export async function clearBars() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function countBars() {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).count();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(0);
    });
  } catch { return 0; }
}

// ─── localStorage helpers (always wrapped: storage can be unavailable) ──────
export function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}

export function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
