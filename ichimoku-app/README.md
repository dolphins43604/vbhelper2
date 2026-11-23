# Ichimoku Scanner (Android)

Your Streamlit Ichimoku Cloud breakout scanner, rebuilt as an Android app.
Same logic (Tenkan 18 / Kijun 52 / Senkou B 104 / Displacement 26, 1D / 2D / 3D,
TK cross, Chikou, fresh breakouts, reversal, Kijun/cloud bounce, volume filter),
same Alpaca data source, and the same CSV columns.
Volume is now full-market (SIP) volume, not IEX-only. See below.

GitHub builds the APK for you. You don't need Android Studio.

## 1. Put this folder on GitHub

1. Create a new **private** repository on github.com (no README or .gitignore).
2. Upload this folder's contents, including the hidden `.github` folder:
   - **GitHub Desktop:** *Add an Existing Repository*, pick this folder, then *Publish*.
   - **Command line:**
     ```bash
     git remote add origin https://github.com/<you>/<repo>.git
     git push -u origin main
     ```
   > The web "Upload files" page can skip hidden folders like `.github`. If you use it,
   > make sure `.github/workflows/build-apk.yml` is in the repo.

## 2. Let GitHub build the APK

Each push to `main` starts the **Build Android APK** workflow (see the **Actions** tab;
it takes about 5–8 minutes). You can also start it by hand: Actions → Build Android APK → *Run workflow*.

When it finishes, open the repo's **Releases** page on your phone and tap
**IchimokuScanner.apk**.

## 3. Install on your phone

1. Tap the downloaded APK. Android will ask you to allow installs from your browser or Files app. Allow it.
2. Open **Ichimoku Scanner**, then go to ⚙ Settings and paste your Alpaca **API key ID** and **secret**
   (from a free paper account at alpaca.markets → API Keys). Tap *Save & test*.
3. Pick a universe and filters, then tap **Start scan**.

Later builds install as updates over the old one, and your keys and last results stay.

## How it works

| Streamlit version | App |
|---|---|
| `scanner.py` (pandas) | `www/js/engine.js` (same math; checked against the Python on 1,500 tickers × 6 filter combos with zero differences) |
| `alpaca-py` bulk requests | `www/js/alpaca.js` (REST, 500 symbols per request, paginated, ~180 req/min) |
| parquet disk cache (8 h) | IndexedDB on the phone (8 h); clear it in Settings |
| Plotly chart per result | Tap a result to open its full-screen chart |
| `st.download_button` CSV | **CSV** button opens Android's share sheet (Drive, email, Files…) |

A full-US scan (~8,000 symbols, 3 years of history) needs a few hundred API calls,
so it takes roughly 2–4 minutes. Re-scanning with different filters within 8 hours
uses the cache and finishes in seconds. **Keep the app open while it downloads.**
Android pauses apps in the background.

### Differences from the Streamlit version
- **Volume is full-market (SIP), not IEX-only.** The Python version used Alpaca's IEX feed, which only
  counts trades on one exchange (a few percent of the total), so its volume filters ran far too low.
  The free plan allows SIP data that is at least 15 minutes old. If your account refuses it, the app falls back to IEX.
- **2D/3D bars are counted back from today**, so the latest 2D/3D bar always includes
  today's close. The Python version grouped from the first day of history, which could leave
  the last 1–2 days out of the 2D/3D bars.
- The chart's future cloud uses the real projected Senkou A/B values, not a flat line.
- "Full US market" comes from Alpaca's list of active, tradable, exchange-listed stocks
  (no OTC), with the SEC list as a fallback.
- History is 3 years by default (enough for 3D at 104/26). 2 or 5 years can be picked under *Ichimoku parameters*.

## Signing key

`android/app/scanner-signing.jks` is a signing key made for this project. Because every build
uses the same key, updates install over each other. **Keep the repo private.** To use your own key,
add the repo secrets `SIGNING_KEYSTORE_B64` (base64 of a .jks), `SIGNING_PASSWORD` and
`SIGNING_ALIAS`. Switching keys means uninstalling the old app once.

## Test in a browser (optional)

```bash
npm install
npm run serve        # http://localhost:8080
```
A desktop browser blocks the Alpaca calls (CORS). The Android app makes them natively, so it isn't affected.

## Project layout
```
www/                  the app (HTML/CSS/JS, no build step)
  js/engine.js        Ichimoku + breakout/bounce/reversal detection
  js/alpaca.js        Alpaca REST client
  js/scan.js          cache → download → scan pipeline
  js/chart.js         Plotly Ichimoku chart
  js/app.js           UI
android/              Capacitor Android project
.github/workflows/    APK build
```
