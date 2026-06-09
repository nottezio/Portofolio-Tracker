# Portfolio Investasi — Technical Documentation

A personal investment portfolio tracker built as a single-file HTML web app, with cross-device sync via GitHub and live price updates via a Cloudflare Worker proxy.

---

## Overview

This app consolidates holdings from five Indonesian investment platforms into a single dashboard:

| Platform | Asset Type | Pricing Source |
|----------|------------|----------------|
| **Tring! by Pegadaian** | Physical gold (emas) | Manual (Pegadaian buyback price) |
| **Bibit** | Mutual funds (reksa dana) | Manual (NAV) |
| **Stockbit** | Indonesian stocks (IDX) | Yahoo Finance via Cloudflare Worker |
| **GoTrade** | US stocks & ETFs | Yahoo Finance via Cloudflare Worker |
| **Pluang** | Cryptocurrency | CoinGecko via Cloudflare Worker |

The app is fundamentally **offline-first** — all data lives in browser localStorage and works without an internet connection. Cloud sync layers on top of this for multi-device coordination.

---

## Architecture

### High-Level Topology

```
┌──────────────────────────────────────────────────────────┐
│  GitHub Repo (private)  ← portfolio data sync             │
│  └── portfolio.json     ← positions, synced across devices│
└──────────────────┬───────────────────────────────────────┘
                   │  GitHub REST API (token-auth)
        ┌──────────┴──────────┐
        │                     │
   Laptop                    HP
   (read+write)         (read+write)
        │                     │
        └─────────┬───────────┘
                  │  on refresh / app open
                  ▼
┌──────────────────────────────────────────────────────────┐
│  Cloudflare Worker  ← live price proxy (real-time)        │
│  Fetches: Yahoo Finance (stocks), CoinGecko (crypto),     │
│           Frankfurter (USD/IDR), adds CORS headers        │
└──────────────────────────────────────────────────────────┘
```

Two independent systems:
- **GitHub** handles portfolio *data* sync (your positions, edits) across devices.
- **Cloudflare Worker** handles live *price* fetching on demand.

They're decoupled — you can use either alone. The Worker replaced an earlier GitHub Actions approach that proved unreliable (scheduled-job delays, 60-day idle stop, push conflicts).

---

## File Structure

```
portfolio.html              # The entire app — a single file (~235 KB)
price-worker.js             # Cloudflare Worker — deploy to dash.cloudflare.com
README.md                   # This file
avi_portfolio_backup.json   # Backup of initial portfolio data (import via Settings)
```

The HTML file embeds:
- All CSS (inline `<style>`)
- All JavaScript (inline `<script>`)
- Initial portfolio data (embedded as JSON literal)

There are **no external runtime dependencies**. No CDN scripts, no npm packages. The app loads from a `file://` URL or any static host.

---

## Data Schema

### `portfolio.json`

```jsonc
{
  "version": 1,
  "lastModified": "2026-04-28T10:00:00Z",
  "settings": {
    "kursUsdIdr": 16500,
    "targetAllocation": {
      "tring": 0.10, "bibit": 0.20, "stockbit": 0.30,
      "gotrade": 0.30, "pluang": 0.10
    },
    "github": { "autoPull": true, "autoPush": true }  // device-only, scrubbed before push
  },
  "tring": {
    "hargaBuybackSaatIni": 2695000,
    "transactions": [
      { "id": "tring-1", "tanggal": "2026-03-02",
        "keterangan": "...", "hargaBeli": 2816000, "jumlahGram": 0.1776 }
    ]
  },
  "bibit": { "positions": [
    { "id": "bibit-1", "nama": "Sucorinvest Money Market Fund",
      "jenis": "Pasar Uang", "navBeliAvg": 1917.05,
      "modalTotal": 100000, "navSekarang": 1952.25 }
  ]},
  "stockbit": { "positions": [
    { "id": "stockbit-1", "kode": "ADRO", "nama": "Alamtri Resources",
      "hargaBeliAvg": 2431.64, "totalLot": 5, "hargaSekarang": 2450 }
  ]},
  "gotrade": { "positions": [
    { "id": "gotrade-1", "ticker": "SPY", "nama": "S&P 500 ETF",
      "hargaBeliAvgUSD": 670.35, "totalLembar": 0.010054,
      "hargaSekarangUSD": 694.46, "feeUSD": 0 }
  ]},
  "pluang": { "positions": [
    { "id": "pluang-1", "simbol": "BTC", "nama": "Bitcoin",
      "hargaBeliAvg": 1221230233, "jumlahKoin": 0.00020435,
      "hargaSekarang": 1277519703 }
  ]},
  "snapshots": [
    { "date": "2026-04-28", "totalModal": 9786303, "totalNilai": 9565006, /*...*/ }
  ]
}
```

### Worker Price Response (in-memory, not stored)

```jsonc
{
  "lastUpdated": "2026-04-28T10:30:00Z",
  "kursUsdIdr": 16472,
  "kursSource": "frankfurter",
  "stocks": {
    "ADRO.JK": 2450,        // IDX symbols use .JK suffix
    "BBNI.JK": 3740,
    "SPY": 694.46,           // US tickers as-is
    "MSFT": 393.01
  },
  "crypto": {
    "bitcoin": 1277519703,    // CoinGecko IDs (lowercase)
    "ethereum": 40042655
  }
}
```

---

## Computation Rules

| Platform | Modal Formula | Nilai Formula |
|----------|---------------|---------------|
| Tring | `hargaBeli × jumlahGram` per transaction | `hargaBuybackSaatIni × jumlahGram` |
| Bibit | `modalTotal` (input directly) | `(modalTotal / navBeliAvg) × navSekarang` |
| Stockbit | `hargaBeliAvg × totalLot × 100` | `hargaSekarang × totalLot × 100` |
| GoTrade | `hargaBeliAvgUSD × totalLembar × kursUsdIdr` | `(hargaSekarangUSD × totalLembar − feeUSD) × kursUsdIdr` |
| Pluang | `hargaBeliAvg × jumlahKoin` | `hargaSekarang × jumlahKoin` |

P/L = Nilai − Modal. Return % = P/L ÷ Modal.

Stockbit lot convention: 1 lot = 100 shares (Indonesian market standard).

---

## Sync Protocol

### Auto-Push (after local edit)

```
User edits field
  → saveState() writes localStorage
  → 3-second debounce timer starts
  → On timer fire: GET portfolio.json (to get current SHA)
  → PUT portfolio.json with new content + SHA
  → On 409 Conflict: re-fetch SHA, retry once
```

The SHA is GitHub's optimistic concurrency token. If two devices push simultaneously, the second one gets a 409, refetches, and retries — last-write-wins, which is acceptable for single-user multi-device.

### Auto-Pull (on app open)

```
init() runs
  → If GitHub configured: GET portfolio.json
  → Compare remote.lastModified vs local.lastModified
  → If remote is newer: replace state, preserve device-only fields (token, etc.)
  → Render
  → Then fetch prices from Cloudflare Worker, applyPrices() to update market values
```

### Refresh Button (🔄)

```
Push local first    (preserves any pending edits)
Pull remote         (gets edits from other devices)
Pull prices         (gets latest prices from Action)
applyPrices()       (updates portfolio with fresh prices)
saveState(silent)   (write to localStorage without re-pushing)
render()
```

The "push first" order is critical — it prevents the bug where a fresh local edit gets overwritten by a stale remote pull. This was the cause of the "NAV Bibit reset on refresh" bug in earlier versions.

### Device-Only Fields

These fields live only on each device, never in `portfolio.json`:
- `settings.github.token` — the PAT
- `settings.github.owner` / `repo` — repo identifier (technically could be shared, but kept local)
- `settings.appsScript.token` / `url` — legacy Apps Script config
- `settings.sheetsSyncUrls` — legacy Sheets URLs

The push code strips these before serializing. The pull code preserves them when replacing state from remote.

---

## Price Fetching (Cloudflare Worker)

Prices are fetched on demand — when the app opens or the user hits refresh — through a Cloudflare Worker that proxies upstream APIs and adds CORS headers (Yahoo Finance blocks direct browser calls).

### Request

```
GET https://your-worker.workers.dev/?stocks=BBCA.JK,MSFT&crypto=bitcoin,ethereum&token=SECRET
```

The app collects symbols from `portfolio.json`:
- Stockbit `kode` → `{KODE}.JK` (Yahoo IDX suffix)
- GoTrade `ticker` → as-is (US symbols)
- Pluang `simbol` → CoinGecko ID via `CRYPTO_SYMBOL_MAP`

### Response

```jsonc
{
  "lastUpdated": "2026-06-09T10:30:00Z",
  "kursUsdIdr": 16472,
  "kursSource": "frankfurter",
  "stocks": { "BBCA.JK": 9500, "MSFT": 393.01 },
  "crypto": { "bitcoin": 1277519703 }
}
```

This is the same shape the app's `applyPrices()` expects.

### Sources (with fallback)

| Data | Primary | Fallback 1 | Fallback 2 |
|------|---------|------------|------------|
| USD/IDR | Frankfurter (ECB rates) | exchangerate-api | CoinGecko USDT |
| US/IDX stocks | Yahoo Finance v8 chart | — | (app keeps old value) |
| Crypto | CoinGecko (Pro if key set) | Binance × USD/IDR | — |

### Worker Configuration (environment variables)

| Variable | Purpose |
|----------|---------|
| `SHARED_SECRET` | Optional. If set, requests must include `?token=`. Prevents others using your Worker's quota |
| `COINGECKO_API_KEY` | Optional. Demo API key for higher crypto rate limits |

### Why Cloudflare Worker over GitHub Actions

| Aspect | GitHub Actions (old) | Cloudflare Worker (current) |
|--------|---------------------|----------------------------|
| Latency | 15 min (cron) | Real-time (on demand) |
| Reliability | Scheduled jobs delayed/skipped under load | Always-on edge, 99.99% uptime |
| Idle stop | Stops after 60 days inactivity | Never |
| Commit churn | Every price update = git commit | None — prices never touch the repo |
| Push conflicts | Action vs app push races | Eliminated (prices not committed) |
| Free tier | 2000 min/month | 100,000 requests/day |

### Rate Limits

Cloudflare free tier: 100,000 requests/day. The app makes ~1 request per refresh, so a few dozen per day. The Worker also edge-caches upstream responses for 60s (`cf: { cacheTtl: 60 }`) to reduce load on Yahoo/CoinGecko.

---

## Authentication

### GitHub Personal Access Token (PAT)

The app requires a **fine-grained PAT** with these scopes on a single repo:

| Permission | Required For |
|------------|--------------|
| Contents: Read & Write | Read/write `portfolio.json` |
| Actions: Read & Write | Trigger workflow via "Run Now" button |
| Workflows: Read & Write | Install workflow file via "Install" button |

The token is stored in browser localStorage on each device. It's never committed to the repo (push code strips it). To revoke: [github.com/settings/tokens](https://github.com/settings/tokens) → delete.

### Why Not OAuth?

OAuth would require a backend server to hold the client secret. This app is intentionally backend-less — it runs from a single HTML file. PATs are the appropriate auth mechanism for personal-use tools.

---

## Security Considerations

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Token leaks via screenshots | Token field is `<input type="password">`; readme warns user |
| Repo accidentally public | App warns on connect if repo is detected as public |
| Token compromise → data exfil | Fine-grained PAT scoped to one repo only — no access to other GitHub data |
| Token compromise → data destruction | GitHub keeps full commit history; rollback via `git revert` |
| Browser cache cleared, no backup | Two safety nets: GitHub repo + manual JSON export |
| MITM on PAT in transit | All GitHub API calls use HTTPS |

### What's *Not* Protected

- The token sits in plaintext localStorage. A malicious browser extension could read it. Mitigation: use a dedicated browser profile for this app.
- Anyone with shell access to your unlocked laptop can read localStorage via DevTools. Mitigation: standard OS-level lock screen.
- GitHub itself can read your data (it's their server). This is the same trust assumption as using GitHub for anything else.

---

## Build & Development

### File Generation

The `portfolio.html` file embeds the user's initial portfolio data. To regenerate from a different starting point:

```python
# Embed a different initial state
import json
with open('initial_data.json') as f: data = json.load(f)
with open('portfolio.html') as f: html = f.read()
html = html.replace(
    'const __INITIAL_DATA__ = {...};',
    f'const __INITIAL_DATA__ = {json.dumps(data, ensure_ascii=False)};'
)
```

### Local Testing

The app works from `file://` for personal use. For development with hot-reload:

```bash
python3 -m http.server 8080
# Open http://localhost:8080/portfolio.html
```

Some browser features behave differently between `file://` and `http://`:
- `file://` triggers stricter CORS (resolved by GitHub's CORS-friendly API)
- `localStorage` is per-origin; `file://` paths share the same origin

### Dependencies

Runtime: none. Inline CSS, vanilla JS, no frameworks.

Build: none. Edit the HTML file directly.

Cloudflare Worker runtime: V8 isolate with native `fetch` (no dependencies, no build step).

---

## Known Limitations

| Limitation | Reason | Workaround |
|------------|--------|------------|
| Manual NAV input for Bibit | No public API for Indonesian mutual fund NAVs | Update in app, syncs to all devices |
| Manual buyback price for Tring | Pegadaian doesn't expose API | Same |
| Prices fetched on demand | By design (no background polling) | Open app or hit refresh to update |
| Fine-grained PATs expire (max 1 year) | GitHub policy | Set "No expiration" or schedule renewal reminder |
| CoinGecko rate limits without API key | Free tier limit | Register Demo key (free), add to repo secrets |
| Yahoo Finance unofficial API | Not a documented API | Multiple fallback sources in fetch script |

---

## Migration History

The app evolved through several backends:

1. **v1: Single Excel file** — manual updates, no sync
2. **v2: Google Sheets with GOOGLEFINANCE** — live prices but Sheets-only
3. **v3: HTML app + Google Drive folder sync** — File System Access API (Chrome only)
4. **v4: HTML app + Apps Script proxy + Sheets URLs** — cross-device but janky (CORS issues, scope drama, multi-step setup)
5. **v5: HTML app + GitHub repo + GitHub Actions** — clean data sync, but Action-based price fetching was unreliable (scheduled-job delays, 60-day idle stop, push conflicts)
6. **v6 (current): HTML app + GitHub repo (data) + Cloudflare Worker (prices)** — decoupled sync and pricing; real-time, reliable, no commit churn

The `apps_script_code.gs` and `Portfolio_Price_Sync.xlsx` files from v4 remain in the project for reference but are unused. The v5 GitHub Action (`fetch-prices.js`/`.yml`) was removed in v6.

---

## Useful Commands

```bash
# View commit history of portfolio data
git log --oneline portfolio.json

# See what changed between two snapshots
git diff HEAD~5 HEAD portfolio.json

# Test the price worker from CLI
curl "https://your-worker.workers.dev/?stocks=BBCA.JK,MSFT&crypto=bitcoin"

# Tail worker logs (requires wrangler)
npx wrangler tail portfolio-prices

# Roll back accidental edit
git revert <commit-hash> -- portfolio.json
```

---

## License

Personal use. No warranty. Built for one specific portfolio configuration; adapt as needed.
