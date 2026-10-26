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
  `npm run build && BACKTEST_FROM=2026-01-01 node dist/scripts/backtest-strategies.js 0 out.json`.
  Command-line parameter overrides are ignored because `.env` wins. To compare settings, list them
  in a JSON file passed as `BACKTEST_VARIANTS=<file>` (`[{ "name": "...", "env": { "strategyLossCooldownMinutes": 30 } }]`),
  and set `BACKTEST_CACHE=<file>` so every run uses the same candles.
- Accept a change only if it helps in both Jan–Jun and Jul–Oct, and nearby values help too.

---

## v2.1.1 (2026-10-26)

Bug fix. `BOLLINGER_BREAKOUT` did not put `vwap` in its signal metadata, and the rules gate then
used the index price as VWAP. "Price above VWAP" could never be true, so every Bollinger signal got
+25 bear and no VWAP bull points, whatever the real VWAP was (live on 26 Oct 10:00: "Price below
VWAP (22638)" with NIFTY at 22638 and the session VWAP near 22540).

Changes:
- `BOLLINGER_BREAKOUT` reports the session VWAP like the other plugins.
- The rules gate computes the session VWAP when a plugin does not report one, instead of using
  the index price.

Backtest, same candles and settings as v2.1 (200 sessions, 1 Jan – 23 Oct 2026):

| | Trades | Win % | Net | Profit factor | Max drawdown | Jan–Jun | Jul–Oct | Positive months |
|---|---|---|---|---|---|---|---|---|
| v2.1 | 481 | 49.1% | +₹32,909 | 1.15 | ₹18,358 | +₹24,539 | +₹8,370 | 7 / 10 |
| v2.1.1 | 472 | 49.4% | +₹37,810 | 1.18 | ₹14,888 | +₹29,751 | +₹8,059 | 6 / 10 |

The fake bear points had been letting Bollinger PUTs through: 13 of the 14 (+₹7,116 together) are
now rejected. Supertrend PUTs take their place (+₹12,111 more). No Bollinger CALL passes in
either version. 12 days change, 8 better and 4 worse (paired t = 0.85): about the same, not
proven better. Jan–Jun +₹5,212, Jul–Oct flat (−₹311). Kept because it is a correctness fix.

---

## v2.1 (2026-10-24)

Why: in the week of 21–23 Oct v2.0 made 10 trades, 3 winners, −₹5,385 gross. No target was hit.
- After a stop loss the bot re-entered in the same direction 1–13 seconds later (#37, #38, #40).
  The 5-minute signal cooldown counts from the previous entry, which a stopped trade has usually
  outlived. On 23 Oct afternoon three CALLs lost ₹3,790 in 11 minutes.
- Trades that were up +13% to +16% (#33, #41) fell back to the full stop loss.
- The trailing-stop winners were reported as `STOP_LOSS_HIT`, the same as the losers.

Changes:
- **Pause after a loss.** No new entry for `STRATEGY_LOSS_COOLDOWN_MINUTES` (15) after a position
  closes at a loss. Read from today's closed positions, so it survives a restart.
- **Breakeven stop.** Once the premium is up `STRATEGY_BREAKEVEN_TRIGGER_PCT` (10%) and the trail
  is not yet active, the stop moves to entry + 1%.
- **`TRAIL_STOP_HIT` exit reason** when the stop that fired was above the entry (trail or
  breakeven). `STOP_LOSS_HIT` now means a real loss. The dashboard shows it as "Trail Stop".
- **Backtest premium model.** Black-Scholes on the ATM strike with the real weekly expiry (Tuesday,
  the session before when Tuesday is a holiday, the next expiry on expiry day) and IV = 0.94 ×
  India VIX. Calibrated on the 41 real paper trades in the DB: entry premium median error 0%
  (p10 −9%, p90 +20%) against −20% (p10 −40%, p90 +60%) for the old 0.45%-of-spot model. The
  backtest reproduces all 10 real trades of 21–23 Oct at the same minute, side and strike.

Backtest: 200 sessions, 1 Jan – 23 Oct 2026, 1 lot of 65, ₹60 charges per trade, prod `.env`:

| | Trades | Win % | Net | Profit factor | Max drawdown | Jan–Jun | Jul–Oct | Positive months |
|---|---|---|---|---|---|---|---|---|
| v2.0 | 477 | 39% | +₹11,954 | 1.04 | ₹31,324 | +₹4,480 | +₹7,474 | 5 / 10 |
| v2.0 + pause only | 421 | 40% | +₹27,242 | 1.11 | ₹26,559 | +₹16,971 | +₹10,271 | 5 / 10 |
| v2.0 + breakeven only | 535 | 48% | +₹19,058 | 1.08 | ₹16,693 | +₹12,706 | +₹6,352 | 5 / 10 |
| **v2.1** | 481 | **49%** | **+₹32,909** | **1.15** | **₹18,358** | **+₹24,539** | **+₹8,370** | **7 / 10** |

Day by day, v2.1 beats v2.0 on 72 days and trails it on 45 (paired t = 1.54): likely better, not
proven. A pause of 10, 15, 20 or 30 minutes each beat v2.0 in both halves. 21–23 Oct: v2.0
−₹4,661, v2.1 −₹2,858. Replaying the 41 real trades on their real 5-second option prices:
v2.0 −₹1,421, v2.1 +₹444.
Cost of the breakeven stop: it sometimes stops a trade that later wins (#32 on 21 Oct: +₹51
instead of +₹1,458).

Tested and rejected (worse overall or in one half):
- A daily loss cap that also counts the next trade's stop-loss risk: −₹3,668, larger drawdown.
- Locking +12% profit when the trail starts: −₹2,773.
- A chase guard (no CALL above the upper Bollinger band or with Stochastic turning down, and the
  mirror for PUTs): −₹6,651, worst drawdown ₹43,109.
- No entries before 09:45 or 10:00: better in Jan–Jun, worse in Jul–Oct.
- Target 30% or 25% instead of 40%: within noise.
- Supertrend entries only at ADX ≥ 25: +₹5,890 on top of v2.1 and better in both halves, but
  ADX ≥ 28 loses ₹14,802, so the gain may be luck. Next candidate once v2.1 has 10 days of
  live data.

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
