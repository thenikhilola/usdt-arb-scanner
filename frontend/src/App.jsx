import { useState, useEffect, useCallback, useRef } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000";

const PLATFORMS = [
  { id: "wazirx",  name: "WazirX",      flag: "🇮🇳", color: "#1a73e8", keyFields: ["api_key", "secret_key"],              docUrl: "https://docs.wazirx.com" },
  { id: "coindcx", name: "CoinDCX",     flag: "🇮🇳", color: "#00c2ff", keyFields: ["api_key", "secret_key"],              docUrl: "https://docs.coindcx.com" },
  { id: "zebpay",  name: "ZebPay",      flag: "🇮🇳", color: "#ff6b35", keyFields: ["api_key"],                             docUrl: "https://zebpay.com/api-docs" },
  { id: "binance", name: "Binance P2P", flag: "🌍", color: "#f0b90b", keyFields: ["api_key", "secret_key"],              docUrl: "https://binance-docs.github.io/apidocs" },
  { id: "bybit",   name: "Bybit P2P",   flag: "🌍", color: "#f7a600", keyFields: ["api_key", "api_secret"],              docUrl: "https://bybit-exchange.github.io/docs" },
  { id: "kucoin",  name: "KuCoin",      flag: "🌍", color: "#00c8a0", keyFields: ["api_key", "secret_key", "passphrase"], docUrl: "https://docs.kucoin.com" },
  { id: "okx",     name: "OKX",         flag: "🌍", color: "#ffffff", keyFields: ["api_key", "secret_key", "passphrase"], docUrl: "https://www.okx.com/docs-v5" },
  { id: "bitget",  name: "Bitget",      flag: "🌍", color: "#00cfa8", keyFields: ["api_key", "secret_key", "passphrase"], docUrl: "https://bitgetlimited.github.io/apidoc" },
];

// Mock prices with realistic INR values (used when backend not available)
const MOCK_BASE = {
  wazirx:  { buy: 87.42, sell: 87.68, latency: 120 },
  coindcx: { buy: 87.15, sell: 87.55, latency: 95  },
  zebpay:  { buy: 87.80, sell: 88.10, latency: 210 },
  binance: { buy: 86.90, sell: 87.30, latency: 180 },
  bybit:   { buy: 87.05, sell: 87.45, latency: 145 },
  kucoin:  { buy: 87.35, sell: 87.72, latency: 160 },
  okx:     { buy: 87.20, sell: 87.58, latency: 130 },
  bitget:  { buy: 87.10, sell: 87.50, latency: 155 },
};

const noise = (v) => +(v + (Math.random() - 0.5) * 0.28).toFixed(2);

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [credentials, setCredentials] = useState(() => {
    try { return JSON.parse(localStorage.getItem("uarb_creds") || "{}"); }
    catch { return {}; }
  });
  const [connected, setConnected]   = useState({});
  const [prices, setPrices]         = useState({});
  const [loading, setLoading]       = useState({});
  const [backendOnline, setBackendOnline] = useState(false);
  const [lastUpdated, setLastUpdated]     = useState(null);
  const [autoRefresh, setAutoRefresh]     = useState(true);
  const [refreshSec, setRefreshSec]       = useState(10);
  const [activeTab, setActiveTab]         = useState("dashboard");
  const [modalPlatform, setModalPlatform] = useState(null);
  const [tempCreds, setTempCreds]         = useState({});
  const [alerts, setAlerts]               = useState([]);
  const [alertThreshold, setAlertThreshold] = useState(0.50);
  const [history, setHistory]             = useState([]);
  const [tradeAmt, setTradeAmt]           = useState(10000);
  const tickRef = useRef(0);
  const intervalRef = useRef(null);

  // ── Check if backend is reachable ──
  useEffect(() => {
    fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok && setBackendOnline(true))
      .catch(() => setBackendOnline(false));
  }, []);

  // ── Fetch prices ──
  const fetchPrices = useCallback(async () => {
    const active = PLATFORMS.filter(p => connected[p.id]);
    if (!active.length) return;

    if (backendOnline) {
      // Real backend fetch
      active.forEach(async (p) => {
        setLoading(l => ({ ...l, [p.id]: true }));
        try {
          const res = await fetch(`${API_BASE}/api/prices/${p.id}`, {
            headers: credentials[p.id]
              ? { "x-api-keys": JSON.stringify(credentials[p.id]) }
              : {},
            signal: AbortSignal.timeout(8000),
          });
          const json = await res.json();
          if (json.status === "ok") {
            setPrices(prev => ({ ...prev, [p.id]: json }));
          }
        } catch (e) {
          console.warn(`Failed to fetch ${p.id}:`, e.message);
        } finally {
          setLoading(l => ({ ...l, [p.id]: false }));
        }
      });
    } else {
      // Mock mode
      active.forEach(p => {
        setLoading(l => ({ ...l, [p.id]: true }));
        const base = MOCK_BASE[p.id];
        setTimeout(() => {
          setPrices(prev => ({
            ...prev,
            [p.id]: { buy: noise(base.buy), sell: noise(base.sell), latency: base.latency + Math.floor(Math.random() * 40), status: "ok" }
          }));
          setLoading(l => ({ ...l, [p.id]: false }));
        }, base.latency);
      });
    }

    const now = new Date();
    setLastUpdated(now);
    setHistory(h => [...h.slice(-49), { time: now, prices: { ...prices } }]);
  }, [connected, backendOnline, credentials, prices]);

  // ── Auto-refresh ticker ──
  useEffect(() => {
    clearInterval(intervalRef.current);
    if (autoRefresh) {
      intervalRef.current = setInterval(() => {
        tickRef.current += 1;
        fetchPrices();
      }, refreshSec * 1000);
    }
    return () => clearInterval(intervalRef.current);
  }, [autoRefresh, refreshSec, fetchPrices]);

  // ── Initial fetch when connection changes ──
  useEffect(() => { fetchPrices(); }, [connected]);

  // ── Spread alert detection ──
  useEffect(() => {
    const active = Object.entries(prices).filter(([id]) => connected[id]);
    if (active.length < 2) return;
    const cheapestBuy  = active.reduce((a, b) => a[1].buy  < b[1].buy  ? a : b);
    const highestSell  = active.reduce((a, b) => a[1].sell > b[1].sell ? a : b);
    const spread = highestSell[1].sell - cheapestBuy[1].buy;
    if (spread >= alertThreshold) {
      setAlerts(a => [{
        time: new Date(),
        buyId: cheapestBuy[0], buyPrice: cheapestBuy[1].buy,
        sellId: highestSell[0], sellPrice: highestSell[1].sell,
        spread: spread.toFixed(2),
      }, ...a.slice(0, 49)]);
    }
  }, [prices]);

  // ── Helpers ──
  const saveCreds = (platformId) => {
    const updated = { ...credentials, [platformId]: tempCreds };
    setCredentials(updated);
    localStorage.setItem("uarb_creds", JSON.stringify(updated));
    setConnected(c => ({ ...c, [platformId]: true }));
    setModalPlatform(null);
    setTempCreds({});
  };

  const disconnect = (id) => {
    setConnected(c => ({ ...c, [id]: false }));
    setPrices(p => { const n = { ...p }; delete n[id]; return n; });
  };

  const activePrices = PLATFORMS
    .filter(p => connected[p.id] && prices[p.id])
    .map(p => ({ ...p, data: prices[p.id] }));

  const sortedBuy  = [...activePrices].sort((a, b) => a.data.buy  - b.data.buy);
  const sortedSell = [...activePrices].sort((a, b) => b.data.sell - a.data.sell);
  const bestBuy    = sortedBuy[0];
  const bestSell   = sortedSell[0];
  const maxSpread  = bestBuy && bestSell ? (bestSell.data.sell - bestBuy.data.buy) : 0;
  const spreadPct  = bestBuy ? ((maxSpread / bestBuy.data.buy) * 100) : 0;
  const profit     = bestBuy ? ((tradeAmt / bestBuy.data.buy) * maxSpread) : 0;

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: "'Share Tech Mono', monospace", background: "#080b10", minHeight: "100vh", color: "#cdd6f4", overflowX: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        :root{
          --green:#00ff9d; --gold:#ffd700; --red:#ff5555;
          --bg:#080b10; --card:#0d1117; --border:rgba(0,255,157,0.1);
        }
        body{background:var(--bg);}
        .mono{font-family:'Share Tech Mono',monospace;}
        .raj{font-family:'Rajdhani',sans-serif;}
        .card{
          background:linear-gradient(135deg,rgba(13,17,23,0.95),rgba(10,14,20,0.9));
          border:1px solid var(--border);border-radius:6px;
          position:relative;overflow:hidden;
        }
        .card::after{
          content:'';position:absolute;top:0;left:0;right:0;height:1px;
          background:linear-gradient(90deg,transparent 0%,rgba(0,255,157,0.35) 50%,transparent 100%);
        }
        .btn{border:none;cursor:pointer;border-radius:4px;font-family:'Share Tech Mono',monospace;transition:all .15s;outline:none;}
        .btn-g{background:linear-gradient(135deg,#00ff9d,#00cc7a);color:#000;font-weight:700;padding:9px 18px;font-size:12px;letter-spacing:.5px;}
        .btn-g:hover{transform:translateY(-1px);box-shadow:0 4px 20px rgba(0,255,157,0.3);}
        .btn-ghost{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);color:#888;padding:7px 14px;font-size:11px;}
        .btn-ghost:hover{border-color:rgba(255,255,255,0.2);color:#ccc;}
        .btn-danger{background:rgba(255,85,85,0.1);border:1px solid rgba(255,85,85,0.3);color:#ff5555;padding:7px 14px;font-size:11px;}
        .btn-danger:hover{background:rgba(255,85,85,0.18);}
        .tab{cursor:pointer;padding:8px 18px;border-radius:4px;font-family:'Share Tech Mono',monospace;font-size:11px;transition:all .2s;border:1px solid transparent;letter-spacing:.5px;}
        .tab.on{background:rgba(0,255,157,0.08);border-color:rgba(0,255,157,0.25);color:var(--green);}
        .tab.off{color:#444;}
        .tab.off:hover{color:#777;}
        .inp{background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,157,0.15);color:#cdd6f4;border-radius:4px;padding:9px 13px;font-family:'Share Tech Mono',monospace;font-size:12px;width:100%;outline:none;transition:border .2s;}
        .inp:focus{border-color:rgba(0,255,157,0.45);box-shadow:0 0 0 2px rgba(0,255,157,0.08);}
        .pulse{animation:pulse 2s ease-in-out infinite;}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        .glow-g{text-shadow:0 0 12px rgba(0,255,157,.6),0 0 30px rgba(0,255,157,.3);}
        .glow-gold{text-shadow:0 0 12px rgba(255,215,0,.5),0 0 30px rgba(255,215,0,.2);}
        .scanline{background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.025) 2px,rgba(0,0,0,.025) 4px);pointer-events:none;position:fixed;inset:0;z-index:9998;}
        .badge{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;font-size:11px;font-weight:700;}
        .overlay{position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:1000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);}
        .modal{width:430px;max-width:92vw;padding:28px;}
        ::-webkit-scrollbar{width:3px;}
        ::-webkit-scrollbar-track{background:transparent;}
        ::-webkit-scrollbar-thumb{background:rgba(0,255,157,.15);border-radius:2px;}
        table{border-collapse:collapse;width:100%;}
        th,td{padding:9px 12px;text-align:left;}
        tr:hover td{background:rgba(255,255,255,.015);}
        .rank-row-1 td{background:rgba(0,255,157,.025);}
        input[type=range]{accent-color:var(--green);width:100%;}
        input[type=checkbox]{accent-color:var(--green);}
        @keyframes slideIn{from{transform:translateY(-6px);opacity:0}to{transform:translateY(0);opacity:1}}
        .slide-in{animation:slideIn .2s ease-out;}
      `}</style>

      <div className="scanline" />

      {/* ── HEADER ── */}
      <header style={{ borderBottom: "1px solid rgba(0,255,157,0.08)", padding: "10px 22px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(0,255,157,0.015)", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 34, height: 34, background: "linear-gradient(135deg,#00ff9d,#00cc7a)", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0 }}>⚡</div>
          <div>
            <div className="raj" style={{ fontSize: 17, fontWeight: 700, color: "#00ff9d", letterSpacing: 3 }}>USDT ARB SCANNER</div>
            <div className="mono" style={{ fontSize: 9, color: "#333", letterSpacing: 1 }}>
              MULTI-PLATFORM P2P ARBITRAGE MONITOR &nbsp;·&nbsp;
              <span style={{ color: backendOnline ? "#00ff9d" : "#ff5555" }}>{backendOnline ? "● LIVE" : "● DEMO MODE"}</span>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div className="mono" style={{ fontSize: 10, color: "#444", textAlign: "right" }}>
            {lastUpdated ? <><span style={{ color: "#00ff9d" }}>UPDATED</span> {lastUpdated.toLocaleTimeString()}</> : "NO DATA YET"}
            <br /><span style={{ color: "#333" }}>{Object.values(connected).filter(Boolean).length} PLATFORMS ACTIVE</span>
          </div>
          <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={fetchPrices}>↺ REFRESH</button>
          <div style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }} onClick={() => setAutoRefresh(x => !x)}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: autoRefresh ? "#00ff9d" : "#333", boxShadow: autoRefresh ? "0 0 8px #00ff9d" : "none" }} className={autoRefresh ? "pulse" : ""} />
            <span className="mono" style={{ fontSize: 10, color: autoRefresh ? "#00ff9d" : "#444" }}>{autoRefresh ? `AUTO ${refreshSec}s` : "PAUSED"}</span>
          </div>
        </div>
      </header>

      {/* ── TABS ── */}
      <div style={{ padding: "10px 22px", display: "flex", gap: 6, borderBottom: "1px solid rgba(255,255,255,0.04)", flexWrap: "wrap" }}>
        {[
          { id: "dashboard", label: "📊 DASHBOARD" },
          { id: "platforms", label: "🔌 PLATFORMS" },
          { id: "alerts",    label: `🔔 ALERTS${alerts.length ? ` (${alerts.length})` : ""}` },
          { id: "history",   label: "📈 HISTORY" },
        ].map(t => (
          <div key={t.id} className={`tab ${activeTab === t.id ? "on" : "off"}`} onClick={() => setActiveTab(t.id)}>{t.label}</div>
        ))}
      </div>

      {/* ── CONTENT ── */}
      <main style={{ padding: "20px 22px", maxWidth: 1200, margin: "0 auto" }}>

        {/* ════════════════ DASHBOARD ════════════════ */}
        {activeTab === "dashboard" && (
          <div>
            {activePrices.length === 0 ? (
              <div style={{ textAlign: "center", padding: "100px 20px" }}>
                <div style={{ fontSize: 52, marginBottom: 16 }}>🔌</div>
                <div className="raj" style={{ fontSize: 22, color: "#00ff9d", marginBottom: 8, fontWeight: 700 }}>No Platforms Connected</div>
                <div className="mono" style={{ fontSize: 12, color: "#444", marginBottom: 28 }}>Head to PLATFORMS tab → connect exchanges → prices appear here</div>
                <button className="btn btn-g" onClick={() => setActiveTab("platforms")}>→ CONNECT NOW</button>
              </div>
            ) : (
              <>
                {/* Best opportunity */}
                {maxSpread > 0 && (
                  <div className="card slide-in" style={{ padding: "18px 22px", marginBottom: 20, borderColor: "rgba(0,255,157,0.25)", background: "linear-gradient(135deg,rgba(0,255,157,0.04),rgba(0,204,122,0.01))" }}>
                    <div className="mono" style={{ fontSize: 9, color: "#555", marginBottom: 8, letterSpacing: 1 }}>◈ BEST ARBITRAGE OPPORTUNITY RIGHT NOW</div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 14 }}>
                      <div className="raj" style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.4 }}>
                        <span style={{ color: "#00ff9d" }}>BUY</span>
                        <span style={{ color: "#444", margin: "0 8px" }}>on</span>
                        <span style={{ color: "#fff" }}>{bestBuy?.name}</span>
                        <span style={{ color: "#333", margin: "0 8px" }}>@</span>
                        <span style={{ color: "#cdd6f4" }}>₹{bestBuy?.data.buy.toFixed(2)}</span>
                        <span style={{ color: "#00ff9d", margin: "0 12px" }}>→</span>
                        <span style={{ color: "#ffd700" }}>SELL</span>
                        <span style={{ color: "#444", margin: "0 8px" }}>on</span>
                        <span style={{ color: "#fff" }}>{bestSell?.name}</span>
                        <span style={{ color: "#333", margin: "0 8px" }}>@</span>
                        <span style={{ color: "#cdd6f4" }}>₹{bestSell?.data.sell.toFixed(2)}</span>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div className="mono" style={{ fontSize: 9, color: "#555", letterSpacing: 1 }}>MAX SPREAD</div>
                        <div className="raj glow-g" style={{ fontSize: 38, fontWeight: 800, color: "#00ff9d", lineHeight: 1 }}>₹{maxSpread.toFixed(2)}</div>
                        <div className="mono" style={{ fontSize: 11, color: "#00cc7a" }}>+{spreadPct.toFixed(3)}% margin</div>
                      </div>
                    </div>
                    {/* Profit calculator */}
                    <div style={{ marginTop: 14, padding: "10px 14px", background: "rgba(0,0,0,0.3)", borderRadius: 5, display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
                      <div className="mono" style={{ fontSize: 10, color: "#555" }}>TRADE AMOUNT:</div>
                      <div style={{ display: "flex", gap: 6 }}>
                        {[5000, 10000, 25000, 50000, 100000].map(v => (
                          <button key={v} className="btn" onClick={() => setTradeAmt(v)} style={{ background: tradeAmt === v ? "rgba(0,255,157,0.15)" : "rgba(255,255,255,0.04)", border: `1px solid ${tradeAmt === v ? "rgba(0,255,157,0.4)" : "rgba(255,255,255,0.08)"}`, color: tradeAmt === v ? "#00ff9d" : "#555", padding: "3px 9px", fontSize: 10, borderRadius: 3 }}>
                            ₹{(v/1000).toFixed(0)}K
                          </button>
                        ))}
                      </div>
                      <div className="mono" style={{ fontSize: 11, color: "#00ff9d" }}>
                        Profit ≈ <span style={{ fontSize: 14, fontWeight: 700 }}>₹{profit.toFixed(0)}</span>
                        <span style={{ color: "#444", marginLeft: 8, fontSize: 10 }}>(before fees & slippage)</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Buy / Sell ranked tables */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
                  {[
                    { title: "⬇ CHEAPEST TO BUY", color: "#00ff9d", list: sortedBuy,  key: "buy",  rankColor: "rgba(0,255,157,0.18)", textColor: "#00ff9d", suffix: (p, i) => i > 0 ? <div className="mono" style={{ fontSize: 9, color: "#ff5555" }}>+₹{(p.data.buy - sortedBuy[0].data.buy).toFixed(2)}</div> : <div className="mono" style={{ fontSize: 9, color: "#00cc7a" }}>BEST</div> },
                    { title: "⬆ HIGHEST TO SELL", color: "#ffd700", list: sortedSell, key: "sell", rankColor: "rgba(255,215,0,0.18)",  textColor: "#ffd700", suffix: (p, i) => i > 0 ? <div className="mono" style={{ fontSize: 9, color: "#ff5555" }}>-₹{(sortedSell[0].data.sell - p.data.sell).toFixed(2)}</div> : <div className="mono" style={{ fontSize: 9, color: "#cc9900" }}>BEST</div> },
                  ].map(({ title, color, list, key, rankColor, textColor, suffix }) => (
                    <div key={key} className="card" style={{ padding: 18 }}>
                      <div className="mono" style={{ fontSize: 10, color, marginBottom: 
