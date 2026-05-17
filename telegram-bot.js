/**
 * AIAutoTrader — Telegram Bot + Market Assistant
 *
 * Single always-on process that:
 *  1. Handles natural-language market queries via Claude + TradingView tools
 *  2. Runs the 4-hour XAUUSD setup check with Telegram approve/reject gate
 *
 *   node telegram-bot.js
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { capitalLogin, capitalGetCandles, capitalPlaceOrder, capitalCredentialsSet, capitalGetAccounts, capitalSwitchAccount } from "./exchanges/capital.js";
import { sendMT5Signal, waitForMT5Result, mt5Enabled } from "./exchanges/mt5-bridge.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  capitalEpic:     process.env.CAPITAL_EPIC      || "GOLD",
  mt5Symbol:       process.env.MT5_SYMBOL        || "XAUUSD",
  tvSymbol:        process.env.TV_SYMBOL         || "OANDA:XAUUSD",
  timeframe:       process.env.TIMEFRAME         || "HOUR_4",
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading:    process.env.PAPER_TRADING !== "false",
  capitalSize:     parseFloat(process.env.CAPITAL_TRADE_SIZE || "1"),
  mt5LotSize:      parseFloat(process.env.MT5_LOT_SIZE       || "0.01"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
};

const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TG_API     = `https://api.telegram.org/bot${TG_TOKEN}`;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Telegram helpers ─────────────────────────────────────────────────────────

async function tgPost(method, body) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function tgSend(chatId, text, extra = {}) {
  // Telegram max message length is 4096 chars
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    await tgPost("sendMessage", { chat_id: chatId, text: chunk, parse_mode: "Markdown", ...extra });
  }
}

async function tgEdit(chatId, messageId, text) {
  await tgPost("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown" });
}

// ─── Approval gate ────────────────────────────────────────────────────────────

const pendingApprovals = new Map(); // messageId → resolve fn

function resolveApproval(messageId, decision) {
  const resolve = pendingApprovals.get(messageId);
  if (resolve) { resolve(decision); pendingApprovals.delete(messageId); }
}

async function sendTradeAlert(signal, price, ema8, vwap, rsi3) {
  const emoji = signal === "BUY" ? "🟢" : "🔴";
  const dist  = ((Math.abs(price - vwap) / vwap) * 100).toFixed(2);
  const text  =
    `${emoji} *${signal} SETUP — XAUUSD*\n\n` +
    `Price : \`${price.toFixed(2)}\`\n` +
    `EMA(8): \`${ema8.toFixed(2)}\`\n` +
    `VWAP  : \`${vwap.toFixed(2)}\`\n` +
    `RSI(3): \`${rsi3.toFixed(2)}\`\n` +
    `Dist  : \`${dist}%\` from VWAP\n\n` +
    `_Expires in 10 min_`;

  const r = await tgPost("sendMessage", {
    chat_id: TG_CHAT_ID, text, parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[
      { text: "✅ Approve", callback_data: "APPROVE" },
      { text: "❌ Reject",  callback_data: "REJECT"  },
    ]]},
  });
  return r.result?.message_id;
}

async function waitForApproval(messageId, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    pendingApprovals.set(messageId, resolve);
    setTimeout(() => {
      if (pendingApprovals.has(messageId)) {
        pendingApprovals.delete(messageId);
        resolve("TIMEOUT");
      }
    }, timeoutMs);
  });
}

// ─── Account selection ────────────────────────────────────────────────────────

let selectedAccountId = null; // overrides default after user picks one

async function showAccountSelector(chatId) {
  await capitalLogin();
  const data = await capitalGetAccounts();
  const accounts = data.accounts || [];

  if (!accounts.length) {
    await tgSend(chatId, "No accounts found on this Capital.com login.");
    return;
  }

  const buttons = accounts.map(a => [{
    text: `${a.preferred ? "★ " : ""}${a.accountName} (${a.accountType}) — ${a.currency}`,
    callback_data: `ACCT:${a.accountId}`,
  }]);

  await tgPost("sendMessage", {
    chat_id: chatId,
    text: "*Select trading account:*",
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons },
  });
}

async function handleAccountSwitch(chatId, messageId, accountId) {
  try {
    await capitalLogin();
    const data = await capitalGetAccounts();
    const account = (data.accounts || []).find(a => a.accountId === accountId);
    await capitalSwitchAccount(accountId);
    selectedAccountId = accountId;
    await tgEdit(chatId, messageId,
      `✅ *Switched to:* ${account?.accountName || accountId}\n` +
      `Type: ${account?.accountType} | Currency: ${account?.currency}\n` +
      `Balance: ${account?.balance?.balance?.toFixed(2) ?? "—"} ${account?.currency}`
    );
    console.log(`Account switched to ${accountId}`);
  } catch (err) {
    await tgEdit(chatId, messageId, `❌ Account switch failed: ${err.message}`);
  }
}

// ─── TradingView scanner ──────────────────────────────────────────────────────

const TV_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Origin": "https://www.tradingview.com",
  "Referer": "https://www.tradingview.com/",
};

const TV_TF_MAP = {
  MINUTE: "|1", MINUTE_5: "|5", MINUTE_15: "|15", MINUTE_30: "|30",
  HOUR: "|60", HOUR_2: "|120", HOUR_4: "|240",
  DAY: "|1D", WEEK: "|1W", MONTH: "|1M",
};

async function tvScan(market, body) {
  const res = await fetch(`https://scanner.tradingview.com/${market}/scan`, {
    method: "POST", headers: TV_HEADERS, body: JSON.stringify(body),
  });
  return res.json();
}

async function fetchTVIndicators(tvSymbol, timeframe) {
  const tf   = TV_TF_MAP[timeframe] || "|240";
  const cols = [`close${tf}`, `EMA8${tf}`, `EMA9${tf}`, `EMA10${tf}`, `VWAP${tf}`];
  const json = await tvScan("global", { symbols: { tickers: [tvSymbol] }, columns: cols });
  if (!json.data?.length) throw new Error(`No TV data for ${tvSymbol}`);
  const [price, ema8, ema9, ema10, vwap] = json.data[0].d;
  return { price, ema8: ema8 ?? ema9 ?? ema10, vwap };
}

// ─── Yahoo Finance ────────────────────────────────────────────────────────────

async function yahooFetch(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
  });
  return res.json();
}

// ─── Tool implementations ─────────────────────────────────────────────────────

const toolHandlers = {

  yahoo_price: async ({ symbol }) => {
    const data = await yahooFetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`
    );
    const q = data.chart?.result?.[0];
    if (!q) return { error: `No data for ${symbol}` };
    const meta = q.meta;
    return {
      symbol: meta.symbol,
      price: meta.regularMarketPrice,
      change_pct: ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose * 100).toFixed(2),
      currency: meta.currency,
      exchange: meta.exchangeName,
    };
  },

  market_snapshot: async () => {
    const symbols = ["^GSPC", "^DJI", "^IXIC", "^VIX", "BTC-USD", "ETH-USD", "GC=F", "EURUSD=X", "GLD"];
    const data = await yahooFetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(",")}`
    );
    return (data.quoteResponse?.result || []).map(q => ({
      symbol: q.symbol,
      price: q.regularMarketPrice,
      change_pct: q.regularMarketChangePercent?.toFixed(2),
    }));
  },

  coin_analysis: async ({ symbol, exchange = "BINANCE", timeframe = "1h" }) => {
    const tfMap = { "5m": "|5", "15m": "|15", "1h": "|60", "4h": "|240", "1D": "|1D" };
    const tf = tfMap[timeframe] || "|60";
    const ticker = `${exchange}:${symbol}`;
    const cols = [
      `close${tf}`, `EMA8${tf}`, `EMA20${tf}`, `EMA50${tf}`,
      `RSI${tf}`, `MACD.macd${tf}`, `MACD.signal${tf}`,
      `BB.upper${tf}`, `BB.lower${tf}`, `VWAP${tf}`,
      `ADX${tf}`, `volume${tf}`,
    ];
    const json = await tvScan("global", { symbols: { tickers: [ticker] }, columns: cols });
    if (!json.data?.length) return { error: `No data for ${ticker}` };
    const [close, ema8, ema20, ema50, rsi, macd, macdSig, bbUp, bbLow, vwap, adx, vol] = json.data[0].d;
    const bias = close > ema20 && close > vwap ? "BULLISH" : close < ema20 && close < vwap ? "BEARISH" : "NEUTRAL";
    return { symbol: ticker, timeframe, close, ema8, ema20, ema50, rsi, macd, macd_signal: macdSig, bb_upper: bbUp, bb_lower: bbLow, vwap, adx, volume: vol, bias };
  },

  top_gainers: async ({ market = "america", limit = 10 }) => {
    const json = await tvScan(market, {
      filter: [{ left: "change", operation: "greater", right: 0 }],
      columns: ["name", "close", "change", "change_abs", "volume"],
      sort: { sortBy: "change", sortOrder: "desc" },
      range: [0, Math.min(limit, 20)],
    });
    return (json.data || []).map(d => ({
      symbol: d.s, price: d.d[1], change_pct: d.d[2]?.toFixed(2), volume: d.d[4],
    }));
  },

  top_losers: async ({ market = "america", limit = 10 }) => {
    const json = await tvScan(market, {
      filter: [{ left: "change", operation: "less", right: 0 }],
      columns: ["name", "close", "change", "change_abs", "volume"],
      sort: { sortBy: "change", sortOrder: "asc" },
      range: [0, Math.min(limit, 20)],
    });
    return (json.data || []).map(d => ({
      symbol: d.s, price: d.d[1], change_pct: d.d[2]?.toFixed(2), volume: d.d[4],
    }));
  },

  volume_breakout_scanner: async ({ market = "america", min_rel_volume = 2, limit = 10 }) => {
    const json = await tvScan(market, {
      filter: [{ left: "relative_volume_10d_calc", operation: "greater", right: min_rel_volume }],
      columns: ["name", "close", "change", "volume", "relative_volume_10d_calc"],
      sort: { sortBy: "relative_volume_10d_calc", sortOrder: "desc" },
      range: [0, Math.min(limit, 20)],
    });
    return (json.data || []).map(d => ({
      symbol: d.s, price: d.d[1], change_pct: d.d[2]?.toFixed(2), volume: d.d[3], rel_volume: d.d[4]?.toFixed(1),
    }));
  },

  bollinger_scan: async ({ market = "america", mode = "squeeze", limit = 10 }) => {
    const filter = mode === "squeeze"
      ? [{ left: "BB.width", operation: "less", right: 0.05 }]
      : [{ left: "close", operation: "greater", right: "BB.upper" }];
    const json = await tvScan(market, {
      filter,
      columns: ["name", "close", "change", "BB.upper", "BB.lower", "BB.width"],
      sort: { sortBy: "BB.width", sortOrder: "asc" },
      range: [0, Math.min(limit, 20)],
    });
    return (json.data || []).map(d => ({
      symbol: d.s, price: d.d[1], change_pct: d.d[2]?.toFixed(2),
      bb_upper: d.d[3], bb_lower: d.d[4], bb_width: d.d[5]?.toFixed(4),
    }));
  },

  multi_timeframe_analysis: async ({ symbol, exchange = "BINANCE" }) => {
    const timeframes = { "1h": "|60", "4h": "|240", "1D": "|1D", "1W": "|1W" };
    const ticker = `${exchange}:${symbol}`;
    const results = {};
    for (const [label, tf] of Object.entries(timeframes)) {
      const cols = [`close${tf}`, `EMA20${tf}`, `RSI${tf}`, `MACD.macd${tf}`, `MACD.signal${tf}`];
      const json = await tvScan("global", { symbols: { tickers: [ticker] }, columns: cols });
      if (json.data?.length) {
        const [close, ema20, rsi, macd, macdSig] = json.data[0].d;
        results[label] = {
          close, ema20, rsi: rsi?.toFixed(1),
          bias: close > ema20 ? "BULL" : "BEAR",
          macd_cross: macd > macdSig ? "bullish" : "bearish",
        };
      }
    }
    return { symbol: ticker, timeframes: results };
  },

  rating_filter: async ({ market = "america", rating = "Strong Buy", limit = 10 }) => {
    const ratingMap = { "Strong Buy": 2, "Buy": 1, "Neutral": 0, "Sell": -1, "Strong Sell": -2 };
    const minRating = ratingMap[rating] ?? 1;
    const json = await tvScan(market, {
      filter: [{ left: "Recommend.All", operation: "greater", right: minRating - 0.5 }],
      columns: ["name", "close", "change", "Recommend.All", "RSI"],
      sort: { sortBy: "Recommend.All", sortOrder: "desc" },
      range: [0, Math.min(limit, 20)],
    });
    return (json.data || []).map(d => ({
      symbol: d.s, price: d.d[1], change_pct: d.d[2]?.toFixed(2),
      rating_score: d.d[3]?.toFixed(2), rsi: d.d[4]?.toFixed(1),
    }));
  },

  financial_news: async ({ symbol }) => {
    const data = await yahooFetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=5&enableFuzzyQuery=false`
    );
    return (data.news || []).slice(0, 5).map(n => ({
      title: n.title,
      publisher: n.publisher,
      published: new Date(n.providerPublishTime * 1000).toISOString().slice(0, 16),
      link: n.link,
    }));
  },

  market_sentiment: async ({ market = "crypto", limit = 5 }) => {
    const json = await tvScan(market, {
      columns: ["name", "close", "change", "RSI", "Recommend.All"],
      sort: { sortBy: "change", sortOrder: "desc" },
      range: [0, Math.min(limit, 20)],
    });
    const items = (json.data || []).map(d => ({
      symbol: d.s,
      change_pct: d.d[2]?.toFixed(2),
      rsi: d.d[3]?.toFixed(1),
      rating: d.d[4]?.toFixed(2),
    }));
    const bullish = items.filter(i => parseFloat(i.change_pct) > 0).length;
    return { market, sentiment: bullish > items.length / 2 ? "BULLISH" : "BEARISH", items };
  },
};

// ─── Claude tool definitions ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: "yahoo_price",
    description: "Real-time price quote for any stock, crypto, ETF, or index from Yahoo Finance. Use Yahoo symbols: AAPL, BTC-USD, GC=F (gold futures), EURUSD=X, ^GSPC.",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Yahoo Finance symbol" } },
      required: ["symbol"],
    },
  },
  {
    name: "market_snapshot",
    description: "Global market overview: S&P 500, Dow, Nasdaq, VIX, BTC, ETH, Gold, EUR/USD, GLD ETF.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "coin_analysis",
    description: "Detailed technical analysis for a crypto or stock: EMA, RSI, MACD, Bollinger Bands, VWAP, ADX, bias.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol e.g. BTCUSDT, XAUUSD, AAPL" },
        exchange: { type: "string", description: "Exchange: BINANCE, NASDAQ, NYSE, OANDA, KUCOIN, MEXC. Default BINANCE." },
        timeframe: { type: "string", description: "Timeframe: 5m, 15m, 1h, 4h, 1D. Default 1h." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "top_gainers",
    description: "Top gaining symbols on a market sorted by % change.",
    input_schema: {
      type: "object",
      properties: {
        market: { type: "string", description: "Market: america, forex, crypto, cfd. Default america." },
        limit:  { type: "number", description: "Number of results (max 20). Default 10." },
      },
      required: [],
    },
  },
  {
    name: "top_losers",
    description: "Top losing symbols on a market sorted by % change.",
    input_schema: {
      type: "object",
      properties: {
        market: { type: "string", description: "Market: america, forex, crypto, cfd. Default america." },
        limit:  { type: "number", description: "Number of results (max 20). Default 10." },
      },
      required: [],
    },
  },
  {
    name: "volume_breakout_scanner",
    description: "Scan for symbols with unusually high volume relative to their 10-day average.",
    input_schema: {
      type: "object",
      properties: {
        market:         { type: "string", description: "Market: america, crypto, forex. Default america." },
        min_rel_volume: { type: "number", description: "Minimum relative volume (e.g. 2 = 2x average). Default 2." },
        limit:          { type: "number", description: "Number of results. Default 10." },
      },
      required: [],
    },
  },
  {
    name: "bollinger_scan",
    description: "Scan for Bollinger Band setups: 'squeeze' (tight bands = volatility incoming) or 'breakout' (price above upper band).",
    input_schema: {
      type: "object",
      properties: {
        market: { type: "string", description: "Market: america, crypto, forex. Default america." },
        mode:   { type: "string", description: "'squeeze' or 'breakout'. Default squeeze." },
        limit:  { type: "number", description: "Number of results. Default 10." },
      },
      required: [],
    },
  },
  {
    name: "multi_timeframe_analysis",
    description: "Multi-timeframe alignment check (1h → 4h → 1D → 1W) for a symbol. Shows bias and MACD cross at each timeframe.",
    input_schema: {
      type: "object",
      properties: {
        symbol:   { type: "string", description: "Symbol e.g. BTCUSDT, XAUUSD" },
        exchange: { type: "string", description: "Exchange: BINANCE, OANDA, NASDAQ. Default BINANCE." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "rating_filter",
    description: "Find symbols with a specific TradingView analyst rating.",
    input_schema: {
      type: "object",
      properties: {
        market: { type: "string", description: "Market: america, crypto, forex. Default america." },
        rating: { type: "string", description: "Rating: 'Strong Buy', 'Buy', 'Neutral', 'Sell', 'Strong Sell'. Default 'Strong Buy'." },
        limit:  { type: "number", description: "Number of results. Default 10." },
      },
      required: [],
    },
  },
  {
    name: "financial_news",
    description: "Latest financial news headlines for a symbol or topic.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol or search term e.g. AAPL, gold, bitcoin" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "market_sentiment",
    description: "Overall market sentiment (bullish/bearish) based on price changes and RSI across a market.",
    input_schema: {
      type: "object",
      properties: {
        market: { type: "string", description: "Market: crypto, america, forex. Default crypto." },
        limit:  { type: "number", description: "Number of symbols to sample. Default 5." },
      },
      required: [],
    },
  },
];

// ─── Claude message handler ───────────────────────────────────────────────────

const SYSTEM = `You are AIAutoTrader's market assistant — a concise, data-driven trading analyst.
Answer using real data from the tools. Be direct: state price, key indicator values, and a clear bias.
Format with Markdown. Keep responses under 3500 characters. Never hallucinate numbers — only use tool data.`;

async function runClaude(userText) {
  const messages = [{ role: "user", content: userText }];

  for (let i = 0; i < 8; i++) {
    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });

    if (res.stop_reason === "end_turn") {
      return res.content.find(b => b.type === "text")?.text || "Done.";
    }

    if (res.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: res.content });
      const results = await Promise.all(
        res.content.filter(b => b.type === "tool_use").map(async (tu) => {
          let output;
          try {
            output = await toolHandlers[tu.name](tu.input);
          } catch (err) {
            output = { error: err.message };
          }
          return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(output) };
        })
      );
      messages.push({ role: "user", content: results });
    }
  }
  return "Reached tool call limit — try a more specific question.";
}

// ─── Local indicator helpers (for 4h cron check) ─────────────────────────────

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

// ─── Log / CSV helpers ────────────────────────────────────────────────────────

const LOG_FILE = "safety-check-log.json";
const CSV_FILE = "trades.csv";
const CSV_HEADERS = "Date,Time (UTC),Broker,Symbol,Side,Size,Price,Total USD,Fee (est.),Order ID,Mode,Notes";

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}
function saveLog(log) { writeFileSync(LOG_FILE, JSON.stringify(log, null, 2)); }
function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(t => t.timestamp.startsWith(today) && t.orderPlaced).length;
}
function writeTradeCsv({ timestamp, broker, symbol, side = "", size = "", price = 0, totalUSD = 0, orderId = "", mode, notes = "" }) {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  const now = new Date(timestamp);
  const fee = totalUSD > 0 ? (totalUSD * 0.001).toFixed(4) : "";
  const row = [
    now.toISOString().slice(0, 10), now.toISOString().slice(11, 19),
    broker, symbol, side, size,
    price > 0 ? price.toFixed(5) : "",
    totalUSD > 0 ? totalUSD.toFixed(2) : "",
    fee, orderId, mode, `"${notes}"`,
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

// ─── 4-hour market check ──────────────────────────────────────────────────────

async function runMarketCheck() {
  console.log(`\n[${new Date().toISOString()}] Running 4h market check...`);

  const log = loadLog();
  const todayCount = countTodaysTrades(log);
  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`Daily limit reached (${todayCount}/${CONFIG.maxTradesPerDay}) — skipping`);
    return;
  }

  let price, ema8, vwap;
  try {
    ({ price, ema8, vwap } = await fetchTVIndicators(CONFIG.tvSymbol, CONFIG.timeframe));
  } catch (err) {
    console.log(`TV fetch failed: ${err.message} — falling back to Capital.com`);
    await capitalLogin();
    const candles = await capitalGetCandles(CONFIG.capitalEpic, CONFIG.timeframe, 500);
    const closes  = candles.map(c => c.close);
    price = closes.at(-1);
    ema8  = calcEMA(closes, 8);
    vwap  = null;
  }

  await capitalLogin();
  const candles = await capitalGetCandles(CONFIG.capitalEpic, CONFIG.timeframe, 20);
  const closes  = candles.map(c => c.close);
  const rsi3    = calcRSI(closes, 3);

  if (!vwap || !rsi3 || !ema8) {
    console.log("Incomplete indicators — skipping");
    return;
  }

  const bullish = price > vwap && price > ema8;
  const bearish = price < vwap && price < ema8;
  const signal  = bullish ? "BUY" : bearish ? "SELL" : null;

  if (!signal) { console.log("Neutral bias — no trade"); return; }

  const rsiBuyOk  = signal === "BUY"  && rsi3 < 30;
  const rsiSellOk = signal === "SELL" && rsi3 > 70;
  const dist      = Math.abs((price - vwap) / vwap) * 100;
  const allPass   = (rsiBuyOk || rsiSellOk) && dist < 1.5;

  console.log(`Signal: ${signal} | RSI(3): ${rsi3.toFixed(2)} | Dist: ${dist.toFixed(2)}% | Pass: ${allPass}`);

  const timestamp = new Date().toISOString();

  if (!allPass) {
    writeTradeCsv({ timestamp, broker: "ALL", symbol: CONFIG.capitalEpic, price, mode: "BLOCKED", notes: `RSI=${rsi3.toFixed(2)}, Dist=${dist.toFixed(2)}%` });
    return;
  }

  // ── Telegram approval ──
  if (CONFIG.paperTrading) {
    console.log(`PAPER: would ${signal}`);
    writeTradeCsv({ timestamp, broker: "Capital.com", symbol: CONFIG.capitalEpic, side: signal, size: CONFIG.capitalSize, price, totalUSD: CONFIG.maxTradeSizeUSD, orderId: `PAPER-${Date.now()}`, mode: "PAPER", notes: "All conditions met" });
    return;
  }

  const msgId  = await sendTradeAlert(signal, price, ema8, vwap, rsi3);
  console.log(`Telegram alert sent (msg ${msgId}) — waiting for approval`);
  const decision = await waitForApproval(msgId);
  console.log(`Decision: ${decision}`);

  if (decision !== "APPROVE") {
    await tgEdit(TG_CHAT_ID, msgId, `${decision === "REJECT" ? "❌ *Rejected*" : "⏰ *Expired*"} — ${signal} setup skipped`);
    writeTradeCsv({ timestamp, broker: "ALL", symbol: CONFIG.capitalEpic, price, mode: "REJECTED", notes: `Telegram: ${decision}` });
    return;
  }

  await tgEdit(TG_CHAT_ID, msgId, `✅ *Approved* — placing ${signal} order...`);

  try {
    const result = await capitalPlaceOrder(CONFIG.capitalEpic, signal, CONFIG.capitalSize);
    const dealId = result.dealReference || result.dealId || "unknown";
    await tgSend(TG_CHAT_ID, `✅ *Order placed* — ${signal} XAUUSD @ \`${price.toFixed(2)}\`\nDeal: \`${dealId}\``);
    writeTradeCsv({ timestamp, broker: "Capital.com", symbol: CONFIG.capitalEpic, side: signal, size: CONFIG.capitalSize, price, totalUSD: CONFIG.maxTradeSizeUSD, orderId: dealId, mode: "LIVE", notes: "Approved via Telegram" });
    log.trades.push({ timestamp, symbol: CONFIG.capitalEpic, price, signal, orderPlaced: true, capitalOrderId: dealId });
    saveLog(log);
  } catch (err) {
    await tgSend(TG_CHAT_ID, `❌ Order failed: ${err.message}`);
    writeTradeCsv({ timestamp, broker: "Capital.com", symbol: CONFIG.capitalEpic, side: signal, price, mode: "LIVE", notes: `Error: ${err.message}` });
  }
}

// ─── Telegram polling loop ────────────────────────────────────────────────────

let tgOffset = 0;
let tgOffsetReady = false;

async function initOffset() {
  const res = await tgPost("getUpdates", { limit: 1, offset: -1 });
  tgOffset = res.result?.length ? res.result[0].update_id + 1 : 0;
  tgOffsetReady = true;
}

async function pollOnce() {
  const { result: updates } = await tgPost("getUpdates", {
    offset: tgOffset,
    timeout: 30,
    allowed_updates: ["message", "callback_query"],
  });

  for (const upd of updates || []) {
    tgOffset = upd.update_id + 1;

    if (upd.callback_query) {
      const cb = upd.callback_query;
      await tgPost("answerCallbackQuery", { callback_query_id: cb.id });
      if (cb.data?.startsWith("ACCT:")) {
        await handleAccountSwitch(cb.message.chat.id, cb.message.message_id, cb.data.slice(5));
      } else {
        resolveApproval(cb.message?.message_id, cb.data);
      }
      continue;
    }

    if (upd.message?.text && String(upd.message.chat.id) === String(TG_CHAT_ID)) {
      const msg  = upd.message;
      const text = msg.text;
      if (text === "/start") {
        await tgSend(msg.chat.id,
          "🤖 *AIAutoTrader ready*\n\nAsk me anything about the markets:\n" +
          "• _What's gold doing right now?_\n" +
          "• _Top crypto gainers today_\n" +
          "• _Analyse BTCUSDT on 4h_\n" +
          "• _Volume breakouts in US stocks_\n" +
          "• _Latest news on Apple_\n\n" +
          "*/accounts* — switch Capital.com trading account"
        );
        continue;
      }
      if (text === "/accounts") {
        await showAccountSelector(msg.chat.id);
        continue;
      }
      // Route to Claude
      console.log(`[TG] ${msg.from?.username}: ${text}`);
      await tgPost("sendChatAction", { chat_id: msg.chat.id, action: "typing" });
      try {
        const reply = await runClaude(text);
        await tgSend(msg.chat.id, reply);
      } catch (err) {
        await tgSend(msg.chat.id, `❌ Error: ${err.message}`);
        console.error("Claude error:", err);
      }
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY must be set");
    process.exit(1);
  }

  console.log("AIAutoTrader Telegram bot starting...");
  await initOffset();
  console.log(`Telegram polling ready (offset: ${tgOffset})`);
  await tgSend(TG_CHAT_ID, "🤖 *AIAutoTrader online* — ready for market queries and trade approvals.");

  // Schedule 4-hour market checks
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  const scheduleCheck = async () => {
    try { await runMarketCheck(); } catch (err) { console.error("Market check error:", err); }
    setTimeout(scheduleCheck, FOUR_HOURS);
  };
  setTimeout(scheduleCheck, FOUR_HOURS); // first check at next 4h mark
  console.log("4-hour market check scheduled");

  // Polling loop
  console.log("Listening for messages...");
  while (true) {
    try { await pollOnce(); }
    catch (err) { console.error("Poll error:", err.message); await new Promise(r => setTimeout(r, 5000)); }
  }
}

main();
