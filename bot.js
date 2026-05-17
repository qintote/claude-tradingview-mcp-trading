/**
 * Claude + TradingView MCP — Automated Trading Bot
 * Brokers: Capital.com (REST API) + Exness via MT5 (file bridge)
 *
 * Local:  node bot.js
 * Cloud:  deploy to Railway/Hostinger — set env vars, configure cron schedule
 * Tax:    node bot.js --tax-summary
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import {
  capitalLogin,
  capitalGetCandles,
  capitalPlaceOrder,
  capitalCredentialsSet,
} from "./exchanges/capital.js";
import {
  sendMT5Signal,
  waitForMT5Result,
  mt5Enabled,
  getSignalFilePath,
} from "./exchanges/mt5-bridge.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  capitalEpic:     process.env.CAPITAL_EPIC      || "GOLD",
  mt5Symbol:       process.env.MT5_SYMBOL        || "XAUUSD",
  tvSymbol:        process.env.TV_SYMBOL         || "OANDA:XAUUSD",
  timeframe:       process.env.TIMEFRAME         || "HOUR_4",
  portfolioValue:  parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD  || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY    || "3"),
  paperTrading:    process.env.PAPER_TRADING !== "false",
  capitalSize:     parseFloat(process.env.CAPITAL_TRADE_SIZE  || "1"),
  mt5LotSize:      parseFloat(process.env.MT5_LOT_SIZE        || "0.01"),
};

const LOG_FILE = "safety-check-log.json";

// ─── Onboarding check ────────────────────────────────────────────────────────

function checkOnboarding() {
  if (!existsSync(".env")) {
    console.log("\n⚠️  No .env file found. Creating one from the template...\n");
    const template = readFileSync(".env.example", "utf8");
    writeFileSync(".env", template);
    console.log(
      "  .env created — fill in your Capital.com credentials and MT5 path,\n" +
        "  then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (!capitalCredentialsSet()) {
    console.log(
      "\n⚠️  Capital.com credentials missing from .env\n" +
        "  Add: CAPITAL_API_KEY, CAPITAL_EMAIL, CAPITAL_PASSWORD\n" +
        "  Get your API key: Capital.com → Profile → API Keys\n",
    );
    process.exit(1);
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
}

// ─── Log helpers ─────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}
function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}
function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Indicator calculations ───────────────────────────────────────────────────

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// ─── TradingView scanner fetch ────────────────────────────────────────────────
// Pulls price, EMA(8), and VWAP from TradingView's scanner API — the same
// engine that powers the chart UI, so values match exactly what you see.

// TradingView scanner uses minute counts for intraday timeframes
const TV_TF_MAP = {
  MINUTE: "|1", MINUTE_5: "|5", MINUTE_15: "|15", MINUTE_30: "|30",
  HOUR: "|60", HOUR_2: "|120", HOUR_4: "|240",
  DAY: "|1D", WEEK: "|1W", MONTH: "|1M",
};

const TV_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Origin": "https://www.tradingview.com",
  "Referer": "https://www.tradingview.com/",
};

async function fetchTVIndicators(tvSymbol, timeframe) {
  const tf = TV_TF_MAP[timeframe] || "|240";
  const cols = [
    `close${tf}`, `EMA8${tf}`, `EMA9${tf}`, `EMA10${tf}`, `VWAP${tf}`,
  ];
  const res = await fetch("https://scanner.tradingview.com/global/scan", {
    method: "POST",
    headers: TV_HEADERS,
    body: JSON.stringify({ symbols: { tickers: [tvSymbol] }, columns: cols }),
  });
  if (!res.ok) throw new Error(`TradingView scanner HTTP ${res.status}`);
  const json = await res.json();
  if (!json.data?.length) throw new Error(`No TV data for ${tvSymbol}`);
  const [price, ema8, ema9, ema10, vwap] = json.data[0].d;
  return {
    price,
    ema8: ema8 ?? ema9 ?? ema10,  // EMA8 if available, else nearest
    vwap,
  };
}

// Session VWAP — resets at midnight UTC.
// Capital.com forex candles have no real volume; we fall back to volume=1
// so VWAP degrades gracefully to a simple average of typical prices.
function calcVWAP(candles) {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const session = candles.filter((c) => c.time >= midnight.getTime());
  if (session.length === 0) return null;
  const cumTPV = session.reduce(
    (s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = session.reduce((s, c) => s + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety check ────────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ──────────────────────────────────────────\n");

  const bullish = price > vwap && price > ema8;
  const bearish = price < vwap && price < ema8;
  let signal = null;

  if (bullish) {
    signal = "BUY";
    console.log("  Bias: BULLISH — checking long entry conditions\n");
    check("Price above VWAP (buyers in control)", `> ${vwap.toFixed(5)}`, price.toFixed(5), price > vwap);
    check("Price above EMA(8) (uptrend confirmed)", `> ${ema8.toFixed(5)}`, price.toFixed(5), price > ema8);
    check("RSI(3) below 30 (snap-back setup)", "< 30", rsi3.toFixed(2), rsi3 < 30);
    const dist = Math.abs((price - vwap) / vwap) * 100;
    check("Within 1.5% of VWAP (not overextended)", "< 1.5%", `${dist.toFixed(2)}%`, dist < 1.5);
  } else if (bearish) {
    signal = "SELL";
    console.log("  Bias: BEARISH — checking short entry conditions\n");
    check("Price below VWAP (sellers in control)", `< ${vwap.toFixed(5)}`, price.toFixed(5), price < vwap);
    check("Price below EMA(8) (downtrend confirmed)", `< ${ema8.toFixed(5)}`, price.toFixed(5), price < ema8);
    check("RSI(3) above 70 (reversal setup)", "> 70", rsi3.toFixed(2), rsi3 > 70);
    const dist = Math.abs((price - vwap) / vwap) * 100;
    check("Within 1.5% of VWAP (not overextended)", "< 1.5%", `${dist.toFixed(2)}%`, dist < 1.5);
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({ label: "Market bias", required: "Bullish or bearish", actual: "Neutral", pass: false });
  }

  return { results, allPass: results.every((r) => r.pass), signal };
}

// ─── Trade limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);
  console.log("\n── Trade Limits ──────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Daily limit reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return false;
  }
  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`);
  return true;
}

// ─── CSV tax log ─────────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";
const CSV_HEADERS = [
  "Date", "Time (UTC)", "Broker", "Symbol", "Side",
  "Size", "Price", "Total USD", "Fee (est.)", "Order ID", "Mode", "Notes",
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const note = `,,,,,,,,,,,"Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + note + "\n");
    console.log(`📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`);
  }
}

function writeTradeCsv({ timestamp, broker, symbol, side = "", size = "", price = 0, totalUSD = 0, orderId = "", mode, notes = "" }) {
  const now = new Date(timestamp);
  const feeEst = totalUSD > 0 ? (totalUSD * 0.001).toFixed(4) : "";
  const row = [
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    broker,
    symbol,
    side,
    size,
    price > 0 ? price.toFixed(5) : "",
    totalUSD > 0 ? totalUSD.toFixed(2) : "",
    feeEst,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades recorded yet.");
    return;
  }
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));
  const live    = rows.filter((r) => r[10] === "LIVE");
  const paper   = rows.filter((r) => r[10] === "PAPER");
  const blocked = rows.filter((r) => r[10] === "BLOCKED");
  const totalUSD  = live.reduce((s, r) => s + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((s, r) => s + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ───────────────────────────────────────────\n");
  console.log(`  Total decisions  : ${rows.length}`);
  console.log(`  Live trades      : ${live.length}`);
  console.log(`  Paper trades     : ${paper.length}`);
  console.log(`  Blocked by rules : ${blocked.length}`);
  console.log(`  Total volume     : $${totalUSD.toFixed(2)}`);
  console.log(`  Total fees (est.): $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot — Capital.com + Exness/MT5");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy  : ${rules.strategy.name}`);
  console.log(`Instruments: Capital.com [${CONFIG.capitalEpic}] | MT5 [${CONFIG.mt5Symbol}]`);
  console.log(`Timeframe : ${CONFIG.timeframe}`);

  const log = loadLog();
  if (!checkTradeLimits(log)) {
    console.log("\nBot stopping — daily trade limit reached.");
    return;
  }

  // ── Market data ──
  // Price, EMA(8), VWAP — pulled from TradingView scanner so they match the chart exactly.
  // RSI(3) is calculated from Capital.com candles (TV scanner only exposes RSI-14;
  // a 3-bar calculation is insensitive to the tiny source difference).
  console.log("\n── Fetching indicators from TradingView chart ────────────\n");
  let price, ema8, vwap;
  try {
    ({ price, ema8, vwap } = await fetchTVIndicators(CONFIG.tvSymbol, CONFIG.timeframe));
    console.log(`  Source: TradingView (${CONFIG.tvSymbol})`);
  } catch (tvErr) {
    console.log(`  ⚠️  TradingView scanner failed (${tvErr.message}) — falling back to Capital.com`);
    await capitalLogin();
    const candles = await capitalGetCandles(CONFIG.capitalEpic, CONFIG.timeframe, 500);
    const closes  = candles.map((c) => c.close);
    price = closes[closes.length - 1];
    ema8  = calcEMA(closes, 8);
    vwap  = calcVWAP(candles);
  }

  // RSI(3) — fetch minimal candle history from Capital.com
  await capitalLogin();
  const candles = await capitalGetCandles(CONFIG.capitalEpic, CONFIG.timeframe, 20);
  const closes  = candles.map((c) => c.close);
  const rsi3    = calcRSI(closes, 3);

  console.log(`  ${CONFIG.capitalEpic} price : ${price.toFixed(5)}`);
  console.log(`  EMA(8)            : ${ema8 ? ema8.toFixed(5) : "N/A"}`);
  console.log(`  VWAP              : ${vwap ? vwap.toFixed(5) : "N/A (no session data)"}`);
  console.log(`  RSI(3)            : ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3 || !ema8) {
    console.log("\n⚠️  Not enough data for all indicators. Exiting.");
    console.log(`   vwap=${vwap}, rsi3=${rsi3}, ema8=${ema8}`);
    return;
  }

  // ── Safety check ──
  const { results, allPass, signal } = runSafetyCheck(price, ema8, vwap, rsi3);
  const timestamp = new Date().toISOString();

  // ── Decision ──
  console.log("\n── Decision ──────────────────────────────────────────────\n");

  const logEntry = {
    timestamp,
    symbol: CONFIG.capitalEpic,
    price,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    signal,
    orderPlaced: false,
    capitalOrderId: null,
    mt5Ticket: null,
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log("🚫 TRADE BLOCKED");
    failed.forEach((f) => console.log(`   - ${f}`));

    writeTradeCsv({
      timestamp, broker: "ALL", symbol: CONFIG.capitalEpic,
      price, mode: "BLOCKED", notes: `Failed: ${failed.join("; ")}`,
    });
  } else {
    console.log(`✅ ALL CONDITIONS MET — ${signal}`);

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — would ${signal} ${CONFIG.capitalEpic} on Capital.com`);
      console.log(`📋 PAPER TRADE — would ${signal} ${CONFIG.mt5Symbol} on Exness/MT5`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;

      writeTradeCsv({ timestamp, broker: "Capital.com", symbol: CONFIG.capitalEpic, side: signal, size: CONFIG.capitalSize, price, totalUSD: CONFIG.maxTradeSizeUSD, orderId: `PAPER-CAP-${Date.now()}`, mode: "PAPER", notes: "All conditions met" });
      writeTradeCsv({ timestamp, broker: "Exness/MT5",  symbol: CONFIG.mt5Symbol,  side: signal, size: CONFIG.mt5LotSize, price, totalUSD: CONFIG.maxTradeSizeUSD, orderId: `PAPER-MT5-${Date.now()}`, mode: "PAPER", notes: "All conditions met" });
    } else {
      // ── Capital.com live order ──
      try {
        console.log(`\n🔴 Capital.com — ${signal} ${CONFIG.capitalEpic} size=${CONFIG.capitalSize}`);
        const capResult = await capitalPlaceOrder(CONFIG.capitalEpic, signal, CONFIG.capitalSize);
        const capId = capResult.dealReference || capResult.dealId || "unknown";
        console.log(`✅ Capital.com order placed — ${capId}`);
        logEntry.capitalOrderId = capId;
        logEntry.orderPlaced = true;
        writeTradeCsv({ timestamp, broker: "Capital.com", symbol: CONFIG.capitalEpic, side: signal, size: CONFIG.capitalSize, price, totalUSD: CONFIG.maxTradeSizeUSD, orderId: capId, mode: "LIVE", notes: "All conditions met" });
      } catch (err) {
        console.log(`❌ Capital.com failed: ${err.message}`);
        writeTradeCsv({ timestamp, broker: "Capital.com", symbol: CONFIG.capitalEpic, side: signal, price, mode: "LIVE", notes: `Error: ${err.message}` });
      }

      // ── Exness/MT5 live order ──
      if (mt5Enabled()) {
        try {
          console.log(`\n🔴 Exness/MT5 — ${signal} ${CONFIG.mt5Symbol} lots=${CONFIG.mt5LotSize}`);
          console.log(`   Signal file: ${getSignalFilePath()}`);
          const mt5Sig = sendMT5Signal({ symbol: CONFIG.mt5Symbol, action: signal, lotSize: CONFIG.mt5LotSize });
          const mt5Result = await waitForMT5Result(mt5Sig.id);
          if (mt5Result.success) {
            console.log(`✅ MT5 order placed — ticket #${mt5Result.ticket}`);
            logEntry.mt5Ticket = mt5Result.ticket;
            logEntry.orderPlaced = true;
            writeTradeCsv({ timestamp, broker: "Exness/MT5", symbol: CONFIG.mt5Symbol, side: signal, size: CONFIG.mt5LotSize, price, totalUSD: CONFIG.maxTradeSizeUSD, orderId: String(mt5Result.ticket), mode: "LIVE", notes: "All conditions met" });
          } else {
            console.log(`❌ MT5 order failed: ${mt5Result.error}`);
            writeTradeCsv({ timestamp, broker: "Exness/MT5", symbol: CONFIG.mt5Symbol, side: signal, price, mode: "LIVE", notes: `Error: ${mt5Result.error}` });
          }
        } catch (err) {
          console.log(`❌ MT5 failed: ${err.message}`);
          writeTradeCsv({ timestamp, broker: "Exness/MT5", symbol: CONFIG.mt5Symbol, side: signal, price, mode: "LIVE", notes: `Error: ${err.message}` });
        }
      }
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
