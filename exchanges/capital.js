/**
 * Capital.com REST API integration
 * Docs: https://open-api.capital.com/
 *
 * Authentication flow:
 *  1. POST /api/v1/session → returns CST + X-SECURITY-TOKEN headers
 *  2. All subsequent requests carry those two headers
 *
 * Sessions expire ~10 minutes after last request. capitalLogin() is called
 * at the start of every bot run so this is never a problem.
 */

const BASE_URL =
  process.env.CAPITAL_DEMO === "false"
    ? "https://api-capital.backend-capital.com"
    : "https://demo-api-capital.backend-capital.com";

let _cst = null;
let _securityToken = null;

function authHeaders() {
  return {
    "X-SECURITY-TOKEN": _securityToken,
    CST: _cst,
    "Content-Type": "application/json",
  };
}

export async function capitalLogin() {
  const res = await fetch(`${BASE_URL}/api/v1/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CAP-API-KEY": process.env.CAPITAL_API_KEY,
    },
    body: JSON.stringify({
      identifier: process.env.CAPITAL_EMAIL,
      password: process.env.CAPITAL_PASSWORD,
      encryptedPassword: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Capital.com login failed (${res.status}): ${body}`);
  }

  _cst = res.headers.get("CST");
  _securityToken = res.headers.get("X-SECURITY-TOKEN");
  console.log(`  Capital.com: authenticated (${BASE_URL})`);
}

/**
 * Fetch OHLCV candles for an epic.
 * resolution: MINUTE | MINUTE_5 | MINUTE_15 | MINUTE_30 | HOUR | HOUR_4 | DAY | WEEK
 */
export async function capitalGetCandles(epic, resolution = "HOUR_4", max = 500) {
  const url = `${BASE_URL}/api/v1/prices/${epic}?resolution=${resolution}&max=${max}`;
  const res = await fetch(url, { headers: authHeaders() });

  if (!res.ok) throw new Error(`Capital.com prices failed (${res.status})`);

  const data = await res.json();

  return data.prices.map((p) => ({
    time: new Date(p.snapshotTimeUTC).getTime(),
    open:  (p.openPrice.bid  + p.openPrice.ask)  / 2,
    high:  (p.highPrice.bid  + p.highPrice.ask)  / 2,
    low:   (p.lowPrice.bid   + p.lowPrice.ask)   / 2,
    close: (p.closePrice.bid + p.closePrice.ask) / 2,
    // lastTradedVolume is 0 for forex (no centralised volume) — fall back to 1
    // so VWAP stays meaningful as a volume-weighted average of typical prices
    volume: p.lastTradedVolume || 1,
  }));
}

/**
 * Place a CFD position on Capital.com.
 * direction: 'BUY' | 'SELL'
 * size: units (varies by instrument — see Capital.com deal ticket)
 * stopLossLevel / takeProfitLevel: price levels (0 = omit)
 */
export async function capitalPlaceOrder(
  epic,
  direction,
  size,
  stopLossLevel = 0,
  takeProfitLevel = 0,
) {
  const body = { epic, direction, size, guaranteedStop: false };
  if (stopLossLevel > 0) body.stopLevel = stopLossLevel;
  if (takeProfitLevel > 0) body.profitLevel = takeProfitLevel;

  const res = await fetch(`${BASE_URL}/api/v1/positions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Capital.com order failed (${res.status}): ${err}`);
  }
  return res.json();
}

export async function capitalGetAccounts() {
  const res = await fetch(`${BASE_URL}/api/v1/accounts`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Get accounts failed (${res.status})`);
  return res.json();
}

export async function capitalSwitchAccount(accountId) {
  const res = await fetch(`${BASE_URL}/api/v1/session`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ accountId }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Switch account failed (${res.status}): ${body}`);
  }
  // Capital.com issues fresh tokens after an account switch
  const newCst = res.headers.get("CST");
  const newToken = res.headers.get("X-SECURITY-TOKEN");
  if (newCst) _cst = newCst;
  if (newToken) _securityToken = newToken;
  return res.json();
}

export function capitalCredentialsSet() {
  return !!(
    process.env.CAPITAL_API_KEY &&
    process.env.CAPITAL_EMAIL &&
    process.env.CAPITAL_PASSWORD
  );
}
