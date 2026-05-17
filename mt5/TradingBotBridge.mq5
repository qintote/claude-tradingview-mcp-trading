//+------------------------------------------------------------------+
//| TradingBotBridge.mq5                                             |
//|                                                                  |
//| Reads trade signals from the Node.js bot via JSON files and      |
//| executes them inside MetaTrader 5 (Exness account).              |
//|                                                                  |
//| ── Setup (do this once) ─────────────────────────────────────── |
//|  1. In MT5: File → Open Data Folder                             |
//|  2. Navigate to: MQL5 → Experts                                 |
//|  3. Copy this file there                                         |
//|  4. Open MetaEditor (F4) and compile it (F7)                    |
//|  5. Drag the compiled EA onto any chart                          |
//|  6. Enable AutoTrading (the green play button in the toolbar)    |
//|                                                                  |
//| The signal and result files live in:                             |
//|   MQL5/Files/bot_signal.json  ← bot writes here                 |
//|   MQL5/Files/bot_result.json  ← EA writes result here           |
//|                                                                  |
//| Match these names to your .env:                                  |
//|   MT5_FILES_DIR = <your MT5 data folder>/MQL5/Files             |
//+------------------------------------------------------------------+
#property copyright "TradingBot"
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>

input string InpSignalFile = "bot_signal.json";  // Signal file (in MQL5/Files/)
input string InpResultFile = "bot_result.json";  // Result file (in MQL5/Files/)
input double InpDefaultLots = 0.01;              // Fallback lot size if not in signal

CTrade trade;

//+------------------------------------------------------------------+

int OnInit()
  {
   EventSetTimer(2);
   Print("TradingBotBridge: Ready — watching ", InpSignalFile);
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason) { EventKillTimer(); }
void OnTick() {}

//+------------------------------------------------------------------+
//| Timer — poll for a new signal every 2 seconds                    |
//+------------------------------------------------------------------+
void OnTimer()
  {
   if(!FileIsExist(InpSignalFile))
      return;

   // Read signal file
   int fh = FileOpen(InpSignalFile, FILE_READ | FILE_TXT | FILE_ANSI);
   if(fh == INVALID_HANDLE)
      return;
   string content = "";
   while(!FileIsEnding(fh))
      content += FileReadString(fh);
   FileClose(fh);

   // Already processed — skip
   if(StringFind(content, "\"processed\": true") >= 0)
      return;

   // Parse fields from JSON
   string sigIdStr   = JsonGet(content, "id");
   string symbol     = JsonGet(content, "symbol");
   string action     = JsonGet(content, "action");
   double lotSize    = StringToDouble(JsonGet(content, "lotSize"));
   double stopLoss   = StringToDouble(JsonGet(content, "stopLoss"));
   double takeProfit = StringToDouble(JsonGet(content, "takeProfit"));

   if(symbol == "" || action == "")
      return;
   if(lotSize <= 0)
      lotSize = InpDefaultLots;

   // Mark processed immediately to prevent duplicate execution on slow runs
   string updated = StrReplace(content, "\"processed\": false", "\"processed\": true");
   int fw = FileOpen(InpSignalFile, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(fw != INVALID_HANDLE) { FileWriteString(fw, updated); FileClose(fw); }

   // Execute
   bool   success = false;
   ulong  ticket  = 0;
   string errMsg  = "";

   if(action == "BUY")
     {
      success = trade.Buy(lotSize, symbol, 0,
                          stopLoss   > 0 ? stopLoss   : 0,
                          takeProfit > 0 ? takeProfit : 0,
                          "TradingBot");
      if(success) ticket = trade.ResultOrder();
      else        errMsg = trade.ResultComment();
     }
   else if(action == "SELL")
     {
      success = trade.Sell(lotSize, symbol, 0,
                           stopLoss   > 0 ? stopLoss   : 0,
                           takeProfit > 0 ? takeProfit : 0,
                           "TradingBot");
      if(success) ticket = trade.ResultOrder();
      else        errMsg = trade.ResultComment();
     }
   else
     {
      errMsg = "Unknown action: " + action;
     }

   if(success)
      Print("TradingBotBridge: Executed ", action, " ", symbol,
            " lots=", DoubleToString(lotSize, 2), " ticket=", ticket);
   else
      Print("TradingBotBridge: FAILED ", action, " ", symbol, " → ", errMsg);

   // Write result so Node.js bot can confirm
   long sigId = StringToInteger(sigIdStr);
   string result = StringFormat(
      "{\"signalId\": %d, \"processed\": true, \"success\": %s, "
      "\"ticket\": %d, \"error\": \"%s\", \"timestamp\": \"%s\"}",
      sigId,
      success ? "true" : "false",
      (long)ticket,
      errMsg,
      TimeToString(TimeCurrent(), TIME_DATE | TIME_MINUTES | TIME_SECONDS)
   );

   int rh = FileOpen(InpResultFile, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(rh != INVALID_HANDLE) { FileWriteString(rh, result); FileClose(rh); }
  }

//+------------------------------------------------------------------+
//| Extract a value from a flat JSON string by key                   |
//+------------------------------------------------------------------+
string JsonGet(const string json, const string key)
  {
   string search = "\"" + key + "\": ";
   int pos = StringFind(json, search);
   if(pos < 0) { search = "\"" + key + "\":"; pos = StringFind(json, search); }
   if(pos < 0) return "";

   pos += StringLen(search);
   string rest = StringSubstr(json, pos);

   if(StringGetCharacter(rest, 0) == '"')
     {
      rest = StringSubstr(rest, 1);
      int end = StringFind(rest, "\"");
      return end >= 0 ? StringSubstr(rest, 0, end) : "";
     }

   // Numeric — find nearest delimiter
   int e1 = StringFind(rest, ",");
   int e2 = StringFind(rest, "\n");
   int e3 = StringFind(rest, "}");
   int end = -1;
   if(e1 >= 0 && (end < 0 || e1 < end)) end = e1;
   if(e2 >= 0 && (end < 0 || e2 < end)) end = e2;
   if(e3 >= 0 && (end < 0 || e3 < end)) end = e3;
   return end >= 0 ? StringTrimRight(StringSubstr(rest, 0, end)) : StringTrimRight(rest);
  }

//+------------------------------------------------------------------+
//| Simple single-occurrence string replacement                       |
//+------------------------------------------------------------------+
string StrReplace(const string str, const string from, const string to)
  {
   int pos = StringFind(str, from);
   if(pos < 0) return str;
   return StringSubstr(str, 0, pos) + to + StringSubstr(str, pos + StringLen(from));
  }
