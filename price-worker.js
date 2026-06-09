// ═══════════════════════════════════════════════════════════════════════════
// Portfolio Price Proxy — Cloudflare Worker
// ═══════════════════════════════════════════════════════════════════════════
// Deploy: dash.cloudflare.com → Workers & Pages → Create → Worker
// Paste this whole file, click Deploy. Copy the *.workers.dev URL into the app.
//
// Optional: set a SHARED_SECRET environment variable (Worker → Settings →
// Variables) to require a token. If set, the app must send ?token=SECRET.
// Leave unset for no auth (fine for personal use — it only proxies prices).
//
// Returns JSON: { lastUpdated, kursUsdIdr, kursSource, stocks:{}, crypto:{} }
// ═══════════════════════════════════════════════════════════════════════════

const CRYPTO_TO_BINANCE = {
  bitcoin: 'BTCUSDT', ethereum: 'ETHUSDT', solana: 'SOLUSDT',
  cardano: 'ADAUSDT', ripple: 'XRPUSDT', dogecoin: 'DOGEUSDT',
  polkadot: 'DOTUSDT', 'avalanche-2': 'AVAXUSDT', 'matic-network': 'MATICUSDT',
  chainlink: 'LINKUSDT', binancecoin: 'BNBUSDT', litecoin: 'LTCUSDT'
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; PortfolioBot/1.0)',
      'Accept': 'application/json',
      ...(opts.headers || {})
    },
    cf: { cacheTtl: 60, cacheEverything: true } // edge-cache 60s to reduce upstream load
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ─── USD/IDR exchange rate (multi-source fallback) ──────────────────────────
async function fetchKurs() {
  try {
    const d = await fetchJson('https://api.frankfurter.app/latest?from=USD&to=IDR');
    if (d.rates && d.rates.IDR) return { rate: d.rates.IDR, source: 'frankfurter' };
  } catch (e) {}
  try {
    const d = await fetchJson('https://open.er-api.com/v6/latest/USD');
    if (d.rates && d.rates.IDR) return { rate: d.rates.IDR, source: 'er-api' };
  } catch (e) {}
  try {
    const d = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=idr');
    if (d.tether && d.tether.idr) return { rate: d.tether.idr, source: 'coingecko-usdt' };
  } catch (e) {}
  return null;
}

// ─── Single stock (Yahoo Finance v8 chart endpoint) ─────────────────────────
async function fetchStock(symbol) {
  try {
    const d = await fetchJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`
    );
    const meta = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
    const price = meta ? (meta.regularMarketPrice != null ? meta.regularMarketPrice : meta.previousClose) : null;
    return (price != null && !isNaN(price)) ? price : null;
  } catch (e) {
    return null;
  }
}

async function fetchStocks(symbols) {
  const out = {};
  if (!symbols.length) return out;
  // Parallel — Cloudflare allows up to 50 subrequests per request on free tier
  const results = await Promise.all(symbols.map(s => fetchStock(s).then(p => [s, p])));
  for (const [s, p] of results) if (p != null) out[s] = p;
  return out;
}

// ─── Crypto (CoinGecko, fallback to Binance × kurs) ─────────────────────────
async function fetchCrypto(geckoIds, apiKey) {
  if (!geckoIds.length) return {};
  // Try CoinGecko first
  try {
    const base = apiKey
      ? 'https://pro-api.coingecko.com/api/v3/simple/price'
      : 'https://api.coingecko.com/api/v3/simple/price';
    const headers = apiKey ? { 'x-cg-demo-api-key': apiKey } : {};
    const d = await fetchJson(
      `${base}?ids=${encodeURIComponent(geckoIds.join(','))}&vs_currencies=idr`,
      { headers }
    );
    const out = {};
    for (const [k, v] of Object.entries(d)) if (v && v.idr) out[k] = v.idr;
    if (Object.keys(out).length) return out;
  } catch (e) {}

  // Binance fallback (USD pairs × kurs)
  try {
    const kurs = await fetchKurs();
    if (!kurs) return {};
    const binMap = {};
    const binSyms = [];
    for (const id of geckoIds) {
      const bs = CRYPTO_TO_BINANCE[id];
      if (bs) { binMap[bs] = id; binSyms.push(`"${bs}"`); }
    }
    if (!binSyms.length) return {};
    const d = await fetchJson(`https://api.binance.com/api/v3/ticker/price?symbols=[${binSyms.join(',')}]`);
    const out = {};
    for (const item of d) {
      const id = binMap[item.symbol];
      if (id && item.price) out[id] = parseFloat(item.price) * kurs.rate;
    }
    return out;
  } catch (e) {
    return {};
  }
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // Optional auth
    if (env && env.SHARED_SECRET) {
      const token = url.searchParams.get('token');
      if (token !== env.SHARED_SECRET) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
    }

    const stockSymbols = (url.searchParams.get('stocks') || '').split(',').map(s => s.trim()).filter(Boolean);
    const cryptoIds = (url.searchParams.get('crypto') || '').split(',').map(s => s.trim()).filter(Boolean);
    const cgKey = (env && env.COINGECKO_API_KEY) || '';

    try {
      const [kurs, stocks, crypto] = await Promise.all([
        fetchKurs(),
        fetchStocks(stockSymbols),
        fetchCrypto(cryptoIds, cgKey)
      ]);

      return new Response(JSON.stringify({
        lastUpdated: new Date().toISOString(),
        kursUsdIdr: kurs ? kurs.rate : null,
        kursSource: kurs ? kurs.source : null,
        stocks,
        crypto
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
  }
};
