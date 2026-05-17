/**
 * MT5 file-based signal bridge
 *
 * How it works:
 *  1. This module writes a JSON signal file that the MT5 EA reads
 *  2. The EA (TradingBotBridge.mq5) executes the trade inside MT5/Exness
 *  3. The EA writes a result file back; we poll until it appears
 *
 * Signal file location:
 *  The file must be somewhere MT5 can read. On Mac the default MT5
 *  data folder is:
 *    ~/Library/Application Support/MetaTrader 5/MQL5/Files/
 *  Set MT5_FILES_DIR in .env if your installation is elsewhere.
 *
 * Windows path example:
 *    C:\Users\YourName\AppData\Roaming\MetaQuotes\Terminal\<hash>\MQL5\Files\
 *  (Open MT5 → File → Open Data Folder to find your exact path)
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const MT5_FILES_DIR =
  process.env.MT5_FILES_DIR ||
  join(
    homedir(),
    "Library",
    "Application Support",
    "MetaTrader 5",
    "MQL5",
    "Files",
  );

const SIGNAL_FILE =
  process.env.MT5_SIGNAL_PATH || join(MT5_FILES_DIR, "bot_signal.json");

const RESULT_FILE =
  process.env.MT5_RESULT_PATH || join(MT5_FILES_DIR, "bot_result.json");

/**
 * Write a trade signal for the MT5 EA to pick up.
 * action: 'BUY' | 'SELL'
 */
export function sendMT5Signal({
  symbol,
  action,
  lotSize = 0.01,
  stopLoss = 0,
  takeProfit = 0,
}) {
  const signal = {
    id: Date.now(),
    symbol,
    action,
    lotSize,
    stopLoss,
    takeProfit,
    timestamp: new Date().toISOString(),
    processed: false,
  };

  writeFileSync(SIGNAL_FILE, JSON.stringify(signal, null, 2));
  console.log(`  MT5 signal written → ${SIGNAL_FILE}`);
  return signal;
}

/**
 * Poll for the MT5 EA's result file.
 * Resolves when the EA writes back a result for this signal ID.
 * Rejects after timeoutMs if the EA never responds.
 */
export async function waitForMT5Result(signalId, timeoutMs = 30000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (existsSync(RESULT_FILE)) {
      try {
        const result = JSON.parse(readFileSync(RESULT_FILE, "utf8"));
        if (String(result.signalId) === String(signalId) && result.processed) {
          return result;
        }
      } catch {
        // result file may still be mid-write — try again next tick
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(
    `MT5 EA did not respond within ${timeoutMs / 1000}s.\n` +
      `  Check that TradingBotBridge.mq5 is running on a chart in MT5\n` +
      `  and that AutoTrading is enabled (the green play button).`,
  );
}

export function mt5Enabled() {
  return process.env.MT5_ENABLED !== "false";
}

export function getSignalFilePath() {
  return SIGNAL_FILE;
}

export function getResultFilePath() {
  return RESULT_FILE;
}
