# Strategy changelog

Every decision, intent and position records `strategyVersion` and the parameters that shaped it
(`strategyParams`) in its metadata. Results per version:

```
GET /api/reports/strategy-performance?days=90
```

Rules for changes:
- Bump `strategyVersion` in `src/config/env.ts` whenever entry or exit **logic** changes.
- Parameter-only changes (`.env`) don't need a bump; they are stamped on each trade anyway.
- Judge a version on at least 10 trading days (≈ 50 trades) before changing it again.
- Before deploying a change, compare it with the previous version on the same candles:
  `npm run build && node dist/scripts/backtest-strategies.js 40 out.json`.
  The script ignores parameter overrides on the command line because `.env` wins, so set
  parameters in `.env`.

---

## v2.0 (2026-10-16)

Why: on 16 Oct NIFTY rallied ~200 points (9:47–10:36 IST) and the engine logged 150 "No strategy
produced a signal" scans in a row. Root causes:
- Indicators started cold every morning from today's candles only. 5 of 6 strategies could not
  run until 10:55–12:35 IST.
- Before 5 candles existed, everything ran on raw 1-second ticks (ATR ≈ 1 point, "RSI 97").
- Only the top-confidence signal was checked. A counter-trend signal the rules gate rejected hid
  a valid trend signal.
- Supertrend kept its direction in memory between calls, so the same candles could give a
  different answer.
- The rules gate counted RSI > 65 and the upper Bollinger band as bearish even in a strong
  uptrend.

Changes:
- **Warm-up candles.** The last 2 sessions plus today's 5-min candles come from Upstox's public
  candle API (`historical-candle.service.ts`). Today's candles are gap-filled from our DB.
  There is no tick fallback anywhere, for entries or exits.
- **Candidate selection.** Every strategy's signal is scored; the first one the rules gate
  agrees with is taken.
- **Standard Supertrend.** Deterministic, computed on high/low/close.
- **Trend-aware rules gate.** With ADX ≥ 25 and Supertrend, EMA and VWAP aligned, high RSI and
  riding the band count as momentum, not as overbought.
- **Trend-aware Supertrend RSI cap.** 82 when ADX ≥ 25, otherwise 75.
- **Exits.** The RSI-exhaustion exit is skipped in a strong trend. The trailing distance is
  `max(6% of best premium, 1.5 × ATM delta × entry ATR)`.
- **Diagnostics.** NO_SIGNAL logs now record why each strategy said no (`strategyDiagnostics`).
- **Bug fix.** `sessionStart()` returned 03:45 IST instead of 09:15.
- **Expiry day is traded with the next expiry** (added 2026-10-20, before v2.0's first deploy).
  v1 skipped the whole day when the nearest expiry was today: every Tuesday, and on Monday
  19 Oct, when the Dussehra holiday moved the expiry, it logged ~1,000 `EXPIRY_DAY` rejections
  and took no trade. Now the chain, ATM strike, premium, PCR and lot size come from the next
  expiry on that day. Contracts expiring today are still never bought. The backtest already
  traded every day, so its numbers below are unchanged.

Parameters changed in `.env`:

| Setting | v1 | v2.0 |
|---|---|---|
| `STRATEGY_SL_ATR_MULTIPLIER` | 2.5 | **1.5** |
| `STRATEGY_TRAIL_ACTIVATION_PCT` | 12 | **20** |
| `STRATEGY_TRAIL_ATR_MULTIPLIER` | — | 1.5 (new) |
| `STRATEGY_WARMUP_SESSIONS` | — | 2 (new) |

Backtest: 40 sessions, 20 Aug – 16 Oct 2026, 1 lot of 65, ₹60 charges per trade. The premium is
modelled (ATM ≈ 0.45% of spot, delta 0.5), so use these numbers for comparison only:

| | Trades | Win % | Avg win / loss | Net | Profit factor | Max drawdown |
|---|---|---|---|---|---|---|
| v1 data handling (today-only candles), v1 parameters | 42 | 52% | +12.3% / −11.8% | −₹499 | 0.97 | ₹5,920 |
| v2.0 logic, v1 parameters | 100 | 58% | +12.7% / −13.9% | +₹3,715 | 1.09 | ₹13,078 |
| **v2.0 logic + v2.0 parameters** | 91 | 43% | **+20.0% / −10.4%** | **+₹10,124** | **1.25** | ₹11,119 |

Known limitation: every variant lost money in 20 Aug – 17 Sep (choppy market; v2.0 −₹4,728,
profit factor 0.72) and made money in 18 Sep – 16 Oct (trending market; v2.0 +₹14,852,
profit factor 1.65). Watch drawdowns on range-bound days.

v1 paper results for reference (3 Jul – 16 Oct, 28 trades): 64% win rate, +₹3,047, profit
factor 2.1, no target ever hit.
