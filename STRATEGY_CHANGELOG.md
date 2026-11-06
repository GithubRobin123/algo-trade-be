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

## v2.3 (2026-11-05)

Why: a cost-aware review (real NSE/Upstox charges, bid/ask spread and the stop-fill gap measured on
live paper trades) showed the edge is thin, and only one entry filter held up in both halves of the
backtest:
- Live paper stop exits fill a median ₹0.25 (mean ₹0.40) below the stop price; the backtest filled
  exactly at the stop. With real charges (~₹68 per lot), ₹0.10 spread per side and stops 0.3% worse,
  v2.2.1 made +₹44,740 instead of +₹65,115 and broke even at only ~₹0.40 slippage per side.
- Entries before 10:30 lost money in Jan–Jun and in Jul–Nov; live v2 trades before 10:30 went 1 win,
  7 losses (−₹9,324). Starting at 10:30, 10:45 or 11:00 all beat 09:30 (a plateau, not one lucky
  value); 10:00 and 10:15 did not.
- Tested and rejected (realistic costs, both halves): only 10:30–13:30, no entry after 13:30 / 14:00
  / 14:15, trade with the day's direction, ADX ≥ 25, VIX ≥ 12 (spiky across 11–14), no repeat entry
  within 30 min, MACD not stretched and strong EMA gap (live winner patterns — fail Jul–Nov), max 1 /
  2 / 3 trades a day (all worse; max 1 loses money).

Change:
- No new entry before `STRATEGY_ENTRY_START_IST` (default `10:30`). Signals before it are still
  evaluated and logged as "Before entry start 10:30 IST — CALL/PUT signal not traded".
- Backtest mirrors the entry start; `BACKTEST_REAL_CHARGES=1`, `BACKTEST_SLIPPAGE`,
  `BACKTEST_STOP_SLIPPAGE_PCT` give cost-aware runs (defaults keep flat ₹60 / perfect fills).

Not entry/exit logic, shipped with it:
- Trade history, summary and daily P&L show estimated **Charges** and **Net P&L** (paper P&L stays
  gross). `CHARGES_BROKERAGE_PER_ORDER` (20), `CHARGES_STT_SELL_PCT` (0.15).
- Option-chain history fixed: every 30-s refresh used to move the newest snapshot's time forward, so
  new rows only appeared after outages (24 days in four months). Now one row per
  `OPTION_CHAIN_SNAPSHOT_MINUTES` (1); finished rows keep ATM ± `OPTION_CHAIN_HISTORY_STRIKES` (10)
  strikes, the newest row keeps the full chain. Rows now also store bid/ask price and quantity,
  volume, previous-day OI and delta per strike (Upstox `market_data` / `option_greeks` field names
  checked against the API docs), for spread, order-book imbalance and change-in-OI studies
  (~10–12 MB a month).
- Raw index ticks (~70% of the database, ~7 MB a trading day) are deleted after
  `MARKET_TICK_RETENTION_DAYS` (3) by a daily job outside market hours, on both databases.
- Routine "no trade" decision rows (no signal, market hours, open position, cooldown, risk pause)
  are written when the reason changes and then at most every `STRATEGY_ROUTINE_LOG_MINUTES` (5);
  rows with a signal are always written. Was ~1,100 rows a day, 93% repeats.

Backtest (1 Jan – 5 Nov, 209 sessions, same candles):

| | v2.2.1 (from 09:30) | v2.3 (from 10:30) |
|---|---|---|
| Flat ₹60, perfect fills | +₹67,517, 490 trades, PF 1.35, max DD ₹12,458 | **+₹75,368**, 345 trades, PF 1.58, max DD ₹8,854 |
| Real charges, ₹0.10 spread, stops 0.3% worse | +₹44,740, PF 1.22, max DD ₹13,985 | **+₹59,840**, PF 1.44, max DD ₹9,341 |

Realistic costs by half: Jan–Jun ₹290 → ₹398 a day, Jul–Nov ₹112 → ₹136 a day. Break-even slippage
rises from ~₹0.40 to ~₹0.90 per side; 10 of 11 months profitable (was 7); 20-day windows profitable
77% (was 71%). Jul–Nov is still ~65% weaker than Jan–Jun: profit depends on volatile months.

Deploy note: remove `INDIA_VIX_OVERRIDE=14` from the production `.env` — it pins live VIX at 14, so
the gate's "VIX > 22" discount can never fire live (the backtest uses real VIX).

---

## v2.2.1 (2026-11-04)

Why: the rules gate added ±8 for PCR (put/call OI of ±10 strikes around ATM: < 0.8 → +8 bear,
> 1.2 → +8 bull), but the backtest has no option-chain history and always used a neutral PCR, so live
ran a gate that was never tested. Live PCR also jumps across the 0.8 cut-off between scans (0.72 ↔
0.80 within a minute on 4 Nov), flipping otherwise identical signals:
- 4 Nov 14:11 Supertrend CALL scored Bull 72 / Bear 18 = 69% (needs 70) only because of "Low PCR
  0.78". Without it: 72 / 10 = 74% → BUY_CALL. Real 23900 CE from 153.1 reached +20% by 14:49.
- 3 Nov 10:30–13:09: 121 of 505 rejected CALL scans would have passed without it (the backtest
  says those would have lost ≈ ₹1,000 that day). Over the two days the effect was roughly a wash.

Change:
- PCR no longer scores in the rules gate unless `STRATEGY_GATE_PCR_ENABLED=true`. It is still listed
  in the rule signals, marked "(not scored)".

Backtest (1 Jan – 4 Nov, 208 sessions): unchanged at +₹65,115, PF 1.34, by construction — the live
gate now matches the tested one, so live results can be compared with the backtest day by day.

---

## v2.2 (2026-11-03)

Why: three losing weeks in a row (12–30 Oct), and a review of all 59 paper trades (3 Jul – 2 Nov).
The backtest reproduces the live trades, so the losses come from the strategy, not from execution.
Over 1 Jan – 30 Oct the backtest has the same strategy mix as live (Supertrend ≈ 93% of trades):
Supertrend PUTs +₹52,009, Supertrend CALLs −₹17,594. The leak is the CALL side, not Supertrend.

Changes:
- **Stop loss minimum 8%** (`STRATEGY_SL_MIN_PCT`, was 10). Losers almost never recover from −8%:
  on real ticks the live winners #32, #35, #38, #43, #49, #51 dipped at most −5.9% and #55–#58
  (2 Nov) at most −5.6% before turning green.
- **Trailing distance 5%** (`STRATEGY_TRAIL_OFFSET_PCT`, production `.env` had 6).
- **No new entry after 3 losing trades in a day** (`STRATEGY_MAX_LOSSES_PER_DAY`, 0 = off).
- **The daily loss limit counts the next trade's planned loss** (`STRATEGY_DAILY_LOSS_INCLUDES_NEXT_RISK`).
  It only checked realized + open P&L, so a trade could start just inside the limit and end past
  it: 28 Oct closed at −₹3,920 against a ₹3,000 limit; the backtest's worst day was −₹4,330.
- **`BREAKEVEN_STOP_HIT` exit reason** for a stop at entry + 1% before the trail started (#56, #58
  were reported as `TRAIL_STOP_HIT` with the trail inactive). Dashboard label "Breakeven".
- **Bug: the 15:10 square-off ran at midnight.** `toLocaleTimeString('en-IN', { hour12: false })`
  returns "24:05" between 00:00 and 00:59, so the sweep fired at 00:00 and marked the day done;
  #24 (24 Jul) and #50 (29 Oct) were closed at 00:00 the next day. IST time now comes from UTC
  arithmetic (`utils/ist-clock.ts`) everywhere.
- **Bug: a failed square-off was never retried.** The day was marked done before the sweep, and the
  "force close" fallback could not run because `closePositionWithEvent` catches its own errors
  (#26, 29 Jul, DB outage at 15:10, closed by hand at 16:10). Now the sweep repeats every 30 s
  until no position is open, and a position is never marked closed without an exit order.
- `/api/trades/history` returns `strategyVersion`, `buildCommit`, `initialStopLossPct` (the
  position's `stopLossPrice` is the final, moved stop) and ADX / RSI / ATR at entry. Every trade
  is stamped with the deployed commit.

Production `.env` for v2.2: `STRATEGY_TRAIL_OFFSET_PCT=5`, `STRATEGY_DAILY_MAX_LOSS_PCT=3.5`
(`STRATEGY_SL_MIN_PCT` is not set there, so the new default 8 applies).

Backtest: 205 sessions, 1 Jan – 30 Oct 2026, same candles, 1 lot of 65, ₹60 charges per trade:

| | Trades | Net | Profit factor | Max drawdown | Jan–Apr | May–Jul | Aug–Oct | Worst day | Worst week | Losing weeks |
|---|---|---|---|---|---|---|---|---|---|---|
| v2.1.1 (production settings) | 483 | +₹34,797 | 1.16 | ₹14,888 | +₹35,101 | −₹5,647 | +₹5,342 | −₹4,330 | −₹6,140 | 23 / 44 |
| v2.2, `.env` unchanged | 470 | +₹47,124 | 1.25 | ₹11,480 | +₹35,976 | −₹44 | +₹11,192 | −₹2,758 | −₹9,121 | 23 / 44 |
| **v2.2 + trail 5% + limit 3.5%** | 478 | **+₹64,716** | **1.34** | **₹12,458** | **+₹52,847** | **+₹652** | **+₹11,218** | **−₹3,445** | **−₹4,750** | **20 / 44** |

Day by day the last row beats v2.1.1 on 106 days and trails it on 16 (paired t = 3.09).
With the switches off, the v2.2 build reproduces v2.1.1 exactly (483 trades, +₹34,797).
Nearby values: stop minimum 7% / 9% → +₹62,065 / +₹57,844 (with max 3 losses); trail 4% / 6% →
+₹59,438 / +₹56,309; max losing trades 2 / 4 → −₹1,947 / +₹1,204 against no limit; a hard limit
of 3% → +₹50,458 (worst day −₹2,758, but worst week −₹9,121), 4% → never binds.
12–30 Oct stays negative: v2.2 −₹6,513, v2.1.1 −₹7,579. Only the rejected gap-free ADX below
turned it positive.

Tested and rejected, each on top of stop 8% / trail 5% (+₹56,714):
- ATR without the overnight gap (stops and trail after a gap open were ~2× wider, #55 on 2 Nov
  gave back +30% → +8%): −₹8,301, worse in Jan–Apr and May–Jul. The wide post-gap stops help more
  often than they hurt.
- ADX without the overnight gap: −₹24,191 overall, but Aug–Oct +₹11,730 and 12–30 Oct +₹17,407.
  Strongly regime-dependent — watch it, do not adopt.
- No entry more than 3 / 4 / 5 ATR past EMA21: −₹52,501 / −₹27,206 / −₹20,602.
- 15-minute Supertrend must agree: −₹12,197.
- Supertrend only while ADX is rising: −₹4,535 (May–Jul −₹11,498).
- Daily trend filter (last close vs 10 / 20-day EMA): −₹22,210 / −₹18,616. It blocks CALLs in a
  falling year but costs more PUT profit than it saves.
- Pause after a small win (exit below +3% / +5%): −₹29,134.
- Technical-reversal exits from +5% / +10% (v1 took profits early): −₹143 / −₹659.

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
