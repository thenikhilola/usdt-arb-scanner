/**
 * USDT Arbitrage Scanner — Backend Proxy Server
 * ─────────────────────────────────────────────
 * Fetches real-time USDT/INR prices from 8 exchanges,
 * bypasses browser CORS restrictions, serves frontend.
 *
 * Start:  node server.js
 * Port:   4000  (override with PORT env var)
 */

const express  = require("express");
const cors     = require("cors");
const axios    = require("axios");
const crypto   = require("crypto");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: "*" }));
app.use(express.json());

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────
const http = axios.create({ timeout: 8000 });

/** Wrap any async fetcher with timing + error handling */
async function timedFetch(platformId, platformName, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { ...result, platform: platformId, name: platformName, latency: Date.now() - t0, status: "ok" };
  } catch (err) {
    return { platform: platformId, name: platformName, status: "error", error: err.message, latency: Date.now() - t0 };
  }
}

// ─────────────────────────────────────────────────────────────
//  EXCHANGE FETCHERS
// ─────────────────────────────────────────────────────────────

/** 1. WazirX – public spot ticker */
async function fetchWazirX(keys = {}) {
  const { data } = await http.get(
    "https://api.wazirx.com/sapi/v1/ticker/24hr?symbol=usdtinr"
  );
  return {
    buy:  parseFloat(data.bidPrice),
    sell: parseFloat(data.askPrice),
  };
}

/** 2. CoinDCX – public ticker list */
async function fetchCoinDCX(keys = {}) {
  const { data } = await http.get("https://api.coindcx.com/exchange/ticker");
  const pair = data.find((x) => x.market === "USDTINR");
  if (!pair) throw new Error("USDTINR pair not found on CoinDCX");
  return {
    buy:  parseFloat(pair.ask),
    sell: parseFloat(pair.bid),
  };
}

/** 3. ZebPay – public orderbook */
async function fetchZebPay(keys = {}) {
  const { data } = await http.get(
    "https://api.zebpay.com/api/v1/market/orderbook?currencyCode=USDT"
  );
  const buy  = parseFloat(data?.buy?.[0]?.price  || 0);
  const sell = parseFloat(data?.sell?.[0]?.price || 0);
  if (!buy || !sell) throw new Error("ZebPay returned empty orderbook");
  return { buy, sell };
}

/** 4. Binance P2P – no auth required */
async function fetchBinance(keys = {}) {
  const headers = { "Content-Type": "application/json" };
  const body = (tradeType) => ({
    fiat: "INR", page: 1, rows: 3,
    tradeType, asset: "USDT", payTypes: [],
  });

  const [buyRes, sellRes] = await Promise.all([
    http.post("https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search", body("BUY"),  { headers }),
    http.post("https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search", body("SELL"), { headers }),
  ]);

  // BUY ads → price you pay to buy USDT
  const buy  = parseFloat(buyRes.data?.data?.[0]?.adv?.price  || 0);
  // SELL ads → price you receive when selling USDT
  const sell = parseFloat(sellRes.data?.data?.[0]?.adv?.price || 0);

  if (!buy || !sell) throw new Error("Binance P2P returned no listings");
  return { buy, sell };
}

/** 5. Bybit P2P – public OTC endpoint */
async function fetchBybit(keys = {}) {
  const base = "https://api2.bybit.com/fiat/otc/item/online";
  const params = (side) => ({
    tokenId: "USDT", currencyId: "INR",
    payment: "", side, size: 5, page: 1, amount: "",
  });

  const [buyRes, sellRes] = await Promise.all([
    http.get(base, { params: params(0) }), // side 0 = BUY
    http.get(base, { params: params(1) }), // side 1 = SELL
  ]);

  const buy  = parseFloat(buyRes.data?.result?.items?.[0]?.price  || 0);
  const sell = parseFloat(sellRes.data?.result?.items?.[0]?.price || 0);

  if (!buy || !sell) throw new Error("Bybit P2P returned no listings");
  return { buy, sell };
}

/** 6. KuCoin – spot ticker (USDT-INR if exists, else estimated) */
async function fetchKuCoin(keys = {}) {
  try {
    const { data } = await http.get(
      "https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=USDT-INR"
    );
    if (!data?.data?.bestAsk) throw new Error("no data");
    return {
      buy:  parseFloat(data.data.bestAsk),
      sell: parseFloat(data.data.bestBid),
    };
  } catch {
    // Fallback: fetch USDT spot price in USD + USD/INR rate
    const [tickerRes, forexRes] = await Promise.all([
      http.get("https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=USDT-USDC"),
      http.get("https://open.er-api.com/v6/latest/USD"),
    ]);
    const usdtUsd = parseFloat(tickerRes.data?.data?.bestAsk || 1);
    const usdInr  = parseFloat(forexRes.data?.rates?.INR     || 84);
    const mid     = usdtUsd * usdInr;
    return {
      buy:  +(mid + 0.15).toFixed(2),
      sell: +(mid - 0.15).toFixed(2),
    };
  }
}

/** 7. OKX – spot ticker */
async function fetchOKX(keys = {}) {
  const { data } = await http.get(
    "https://www.okx.com/api/v5/market/ticker?instId=USDT-INR"
  );
  const t = data?.data?.[0];
  if (!t) throw new Error("OKX returned no ticker data");
  return {
    buy:  parseFloat(t.askPx),
    sell: parseFloat(t.bidPx),
  };
}

/** 8. Bitget – spot ticker */
async function fetchBitget(keys = {}) {
  const { data } = await http.get(
    "https://api.bitget.com/api/spot/v1/market/ticker?symbol=USDTINR_SPBL"
  );
  const buy  = parseFloat(data?.data?.buyOne  || 0);
  const sell = parseFloat(data?.data?.sellOne || 0);
  if (!buy || !sell) throw new Error("Bitget USDTINR pair unavailable");
  return { buy, sell };
}

// ─────────────────────────────────────────────────────────────
//  REGISTRY
// ─────────────────────────────────────────────────────────────
const FETCHERS = {
  wazirx:  { name: "WazirX",      fn: fetchWazirX  },
  coindcx: { name: "CoinDCX",     fn: fetchCoinDCX },
  zebpay:  { name: "ZebPay",      fn: fetchZebPay  },
  binance: { name: "Binance P2P", fn: fetchBinance  },
  bybit:   { name: "Bybit P2P",   fn: fetchBybit    },
  kucoin:  { name: "KuCoin",      fn: fetchKuCoin   },
  okx:     { name: "OKX",         fn: fetchOKX      },
  bitget:  { name: "Bitget",      fn: fetchBitget   },
};

// ─────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────

/** Health check */
app.get("/health", (req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString(), uptime: process.uptime() });
});

/** Fetch ALL platforms in parallel */
app.get("/api/prices", async (req, res) => {
  const results = await Promise.all(
    Object.entries(FETCHERS).map(([id, { name, fn }]) => {
      const keys = getKeys(req, id);
      return timedFetch(id, name, () => fn(keys));
    })
  );
  res.json(results);
});

/** Fetch a SINGLE platform */
app.get("/api/prices/:platform", async (req, res) => {
  const id = req.params.platform.toLowerCase();
  const entry = FETCHERS[id];
  if (!entry) {
    return res.status(404).json({ status: "error", error: `Unknown platform: ${id}` });
  }
  const keys = getKeys(req, id);
  const result = await timedFetch(id, entry.name, () => entry.fn(keys));
  res.json(result);
});

/** Parse API keys from request header (sent by frontend) */
function getKeys(req, platformId) {
  try {
    const raw = req.headers["x-api-keys"];
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║   USDT ARB SCANNER — BACKEND SERVER      ║
  ║   Port  : ${PORT}                           ║
  ║   Status: Running ✓                      ║
  ╚══════════════════════════════════════════╝

  Endpoints:
    GET  /health              → health check
    GET  /api/prices          → all platforms
    GET  /api/prices/:id      → single platform

  Platforms: wazirx | coindcx | zebpay | binance
             bybit  | kucoin  | okx    | bitget
  `);
});
        
