/**
 * Fire a live Telegram approval alert using real current indicator values.
 * Tests the full flow: alert → button tap → response — without placing an order.
 *
 *   node test-signal.js
 */

import "dotenv/config";

const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TG_API     = `https://api.telegram.org/bot${TG_TOKEN}`;

const TV_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  "Origin": "https://www.tradingview.com",
  "Referer": "https://www.tradingview.com/",
};

async function tgPost(method, body) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function fetchIndicators() {
  const res = await fetch("https://scanner.tradingview.com/global/scan", {
    method: "POST",
    headers: TV_HEADERS,
    body: JSON.stringify({
      symbols: { tickers: ["OANDA:XAUUSD"] },
      columns: ["close|240", "EMA8|240", "EMA9|240", "VWAP|240", "RSI|240"],
    }),
  });
  const { data } = await res.json();
  const [price, ema8, ema9, vwap, rsi14] = data[0].d;
  return { price, ema8: ema8 ?? ema9, vwap, rsi14 };
}

async function waitForApproval(messageId, timeoutMs = 10 * 60 * 1000) {
  const init = await tgPost("getUpdates", { limit: 1, offset: -1 });
  let offset  = init.result?.length ? init.result[0].update_id + 1 : 0;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    const { result: updates } = await tgPost("getUpdates", {
      offset,
      timeout: Math.min(30, remaining),
      allowed_updates: ["callback_query"],
    });
    for (const upd of updates || []) {
      offset = upd.update_id + 1;
      const cb = upd.callback_query;
      if (cb?.message?.message_id !== messageId) continue;
      await tgPost("answerCallbackQuery", { callback_query_id: cb.id });
      return cb.data;
    }
  }
  return "TIMEOUT";
}

async function run() {
  console.log("Fetching live indicators from TradingView...");
  const { price, ema8, vwap, rsi14 } = await fetchIndicators();

  const signal = price < vwap && price < ema8 ? "SELL" : "BUY";
  const dist   = ((Math.abs(price - vwap) / vwap) * 100).toFixed(2);
  const emoji  = signal === "BUY" ? "🟢" : "🔴";

  console.log(`  Price : ${price.toFixed(2)}`);
  console.log(`  EMA(8): ${ema8.toFixed(2)}`);
  console.log(`  VWAP  : ${vwap.toFixed(2)}`);
  console.log(`  RSI14 : ${rsi14.toFixed(2)}`);
  console.log(`  Signal: ${signal}\n`);

  const text =
    `${emoji} *[TEST] ${signal} SETUP — XAUUSD*\n\n` +
    `Price : \`${price.toFixed(2)}\`\n` +
    `EMA(8): \`${ema8.toFixed(2)}\`\n` +
    `VWAP  : \`${vwap.toFixed(2)}\`\n` +
    `RSI14 : \`${rsi14.toFixed(2)}\`\n` +
    `Dist  : \`${dist}%\` from VWAP\n\n` +
    `_This is a test — no order will be placed_`;

  console.log("Sending Telegram alert...");
  const r = await tgPost("sendMessage", {
    chat_id: TG_CHAT_ID,
    text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Approve", callback_data: "APPROVE" },
        { text: "❌ Reject",  callback_data: "REJECT"  },
      ]],
    },
  });

  const msgId = r.result?.message_id;
  console.log(`Alert sent (message_id: ${msgId}). Waiting up to 10 min for your response...\n`);

  const decision = await waitForApproval(msgId);

  const resultText = {
    APPROVE: "✅ *Approved* — [TEST] no real order placed",
    REJECT:  "❌ *Rejected* — setup skipped",
    TIMEOUT: "⏰ *Expired* — no response in 10 min",
  }[decision];

  await tgPost("editMessageText", {
    chat_id: TG_CHAT_ID,
    message_id: msgId,
    text: resultText,
    parse_mode: "Markdown",
  });

  console.log(`Decision: ${decision}`);
  console.log("Telegram flow test complete.");
}

run().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
