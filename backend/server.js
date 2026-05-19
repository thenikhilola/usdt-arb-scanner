/**
 * USDT Arbitrage Scanner — Backend Proxy Server
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

const http = axios.create({ timeout: 8000 });

async function timedFetch(platformId, platformName, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { ...result, platform: platformId, name: platformName, latency: Date.now() - t0, status: "ok" };
  } catch (err) {
    return { platform: platformId, name: platformName, status: "error", error: err.message, latency: Date.now() - t0 };
  }
}

async function fetchWazirX() {
  const { data } = await http.get("https://api.wazirx.com/sapi/v1/ticker/24hr?symbol=usdtinr");
  return { buy: parseFloat(data.bidPrice), sell: parseFloat(data.askPrice) };
}

async function fetchCoinDCX() {
  const { data } = await http.get("https://api.coindcx.com/exchange/ticker");
  const pair = data.find((x) => x.market === "USDTINR");
  if (!pair) throw new Error("USDTINR pair not found");
  return { buy: parseFloat(pair.ask), sell: parseFloat(pair.bid) };
}

async function fetchZebPay() {
  const { data } = await http.get("https://api.zebpay.com/api/v1/market/orderbook?currencyCode=USDT");
  const buy  = parseFloat(data?.buy?.[0]?.price  || 0);
  const sell = parseFloat(data?.sell?.[0]?.price || 0);
  if (!buy || !sell) throw new Error("ZebPay returned empty orderbook");
  return { buy, sell };
}

async function fetchBinance() {
  const headers = { "Content-Type": "application/json" };
  const body = (tradeType) => ({ fiat: "INR", page: 1, rows: 3, tradeType, asset: "USDT", payTypes: [] });
  const [buyRes, sellRes] = await Promise.all([
    http.post("https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search", body("BUY"),  { headers }),
    http.post("https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search", body("SELL"), { headers }),
  ]);
  const buy  = parseFloat(buyRes.data?.data?.[0]?.adv?.price  || 0);
  const sell = parseFloat(sellRes.data?.data?.[0]?.adv?.price || 0);
  if (!buy || !sell) throw new Error("Binance P2P returned no listings");
  return { buy, sell };
}

async function fetchBybit() {
  const base = "https://api2.bybit.com/fiat/otc/item/online";
  const params = (side) => ({ tokenId: "USDT", currencyId: "INR", payment: "", side, size: 5, page: 1, amount: "" });
  const [buyRes, sellRes] = await Promise.all([
    http.get(base, { params: params(0) }),
    http.get(base, { params: params(1) }),
  ]);
  const buy  = parseFloat(buyRes.data?.result?.items?.[0]?.price  || 0);
  const sell = parseFloat(sellRes.data?.result?.items?.[0]?.price || 0);
  if (!buy || !sell) throw new Error("Bybit P2P returned no listings");
  return { buy, sell };
}

async function fetchKuCoin() {
  try {
    const { data } = await http.get("https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=USDT-INR");
    if (!data?.data?.bestAsk) throw new Error("no data");
    return { buy: parseFloat(data.data.bestAsk), sell: parseFloat(data.data.bestBid) };
  } catch {
    const [tickerRes, forexRes] = await Promise.all([
      http.get("https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=USDT-USDC"),
      http.get("https://open.er-api.com/v6/latest/USD"),
    ]);
    const usdtUsd = parseFloat(tickerRes.data?.data?.bestAsk || 1);
    const usdInr  = parseFloat(forexRes.data?.rates?.INR     || 84);
    const mid     = usdtUsd * usdInr;
    return { buy: +(mid + 0.15).toFixed(2), sell: +(mid - 0.15).toFixed(2) };
  }
}

async function fetchOKX() {
  const { data } = await http.get("https://www.okx.com/api/v5/market/ticker?instId=USDT-INR");
  const t = data?.data?.[0];
  if (!t) throw new Error("OKX returned no ticker");
  return { buy: parseFloat(t.askPx), sell: parseFloat(t.bidPx) };
}

async function fetchBitget() {
  const { data } = await http.get("https://api.bitget.com/api/spot/v1/market/ticker?symbol=USDTINR_SPBL");
  const buy  = parseFloat(data?.data?.buyOne  || 0);
  const sell = parseFloat(data?.data?.sellOne || 0);
  if (!buy || !sell) throw new Error("Bitget USDTINR unavailable");
  return { buy, sell };
}

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

app.get("/health", (req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

app.get("/api/prices", async (req, res) => {
  const results = await Promise.all(
    Object.entries(FETCHERS).map(([id, { name, fn }]) =>
      timedFetch(id, name, () => fn())
    )
  );
  res.json(results);
});

app.get("/api/prices/:platform", async (req, res) => {
  const id = req.params.platform.toLowerCase();
  const entry = FETCHERS[id];
  if (!entry) return res.status(404).json({ status: "error", error: `Unknown platform: ${id}` });
  const result = await timedFetch(id, entry.name, () => entry.fn());
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
