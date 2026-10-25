/**
 * Offline backtest of the strategy pipeline on Upstox historical NIFTY candles.
 *
 *   npm run build && node dist/scripts/backtest-strategies.js [tradingDays=20] [out.json]
 *   BACKTEST_FROM=2026-01-01 node dist/scripts/backtest-strategies.js 0 out.json   (every session since a date)
 *
 * Mirrors the live engine at 1-minute resolution (live scans every 20 s): entries are evaluated at
 * every 1-minute close on COMPLETED 5-minute candles with the same warm-up, plugins, rules gate,
 * entry window (09:30–14:35 IST), 5-minute cooldown, pause after a loss, daily loss cap and
 * one-position limit. Exits replay the stop loss, breakeven, target, trailing stop,
 * technical-reversal and 15:10 square-off rules on 1-minute bars.
 *
 * The option premium is MODELLED with Black-Scholes on the ATM strike: the weekly expiry (Tuesday
 * 15:30 IST, the previous session when Tuesday is a holiday, the next expiry on expiry day — as
 * live), and IV = IV_PER_VIX × India VIX at that time. IV_PER_VIX = 0.94 is the median implied
 * IV / VIX of the 41 real paper trades (Jul–Oct 2026); it prices their entries with a median error
 * of 0% (p10 −9%, p90 +20%). The earlier flat model (0.45% of spot, delta 0.5, no theta) was off by
 * a median −20%. No bid/ask spread or slippage; charges are a flat ₹60 per trade.
 * Needs no Upstox token or database (the candle API is public).
 */

import { env } from '../config/env';
import { selectByRules } from '../services/ai-decision.service';
import type { StrategyCandle } from '../services/historical-candle.service';
import {
  ATM_DELTA,
  StrategyContext,
  adx,
  ema,
  macd,
  rsi,
  strategyRegistry,
  supertrend,
} from '../services/strategy-registry.service';
import { upstoxService } from '../services/upstox.service';

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const VIX_KEY = 'NSE_INDEX|India VIX';
const UNDERLYING = 'NIFTY';
const LOT_SIZE = 65;
const STRIKE_STEP = 50;
const IV_PER_VIX = 0.94;
const DEFAULT_VIX = 14;
const CHARGES_PER_ROUND_TRIP = 60;
const WARMUP_SESSIONS = env.strategyWarmupSessions;
const COOLDOWN_MS = 5 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

interface Bar extends StrategyCandle { volume: number }

interface Trade {
  day: string;
  entryTime: string;
  exitTime: string;
  strategy: string;
  side: 'CE' | 'PE';
  strike: number;
  expiry: string;
  indexEntry: number;
  indexExit: number;
  premiumEntry: number;
  premiumExit: number;
  bestPct: number;
  returnPct: number;
  pnl: number;
  exitReason: string;
  confidence: number;
}

interface OpenPosition {
  strategy: string;
  side: 'CE' | 'PE';
  strike: number;
  expiry: string;
  expiryMs: number;
  entryTime: number;
  indexEntry: number;
  premiumEntry: number;
  stopLoss: number;
  target: number;
  best: number;
  trailActive: boolean;
  entryAtr: number;
  confidence: number;
}

/** A backtest variant: env overrides for the live rules (keys as in env.ts). */
interface Variant {
  name: string;
  env: Partial<Record<keyof typeof env, number | boolean>>;
}

const istDay = (ms: number): string => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const istMinutes = (ms: number): number => Math.floor(((ms + IST_OFFSET_MS) % DAY_MS) / 60000);
const istClock = (ms: number): string => new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16);
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

// ── Option pricing ────────────────────────────────────────────────────────

/** Standard normal CDF (Abramowitz–Stegun 26.2.17, error < 7.5e-8). */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const tail = 0.3989422804014327 * Math.exp(-x * x / 2)
    * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}

/** Black-Scholes option price (zero rates), floored at the 0.05 tick. */
function optionPrice(side: 'CE' | 'PE', spot: number, strike: number, years: number, vol: number): number {
  const intrinsic = Math.max(0, side === 'CE' ? spot - strike : strike - spot);
  if (years <= 0 || vol <= 0) return Math.max(0.05, intrinsic);
  const sd = vol * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + sd * sd / 2) / sd;
  const d2 = d1 - sd;
  const price = side === 'CE'
    ? spot * normCdf(d1) - strike * normCdf(d2)
    : strike * normCdf(-d2) - spot * normCdf(-d1);
  return Math.max(0.05, price);
}

/**
 * The expiry traded on each session: the first Tuesday on or after it, moved to the previous
 * session when that Tuesday is a holiday, and the next one on expiry day itself (as live).
 */
function expiryCalendar(sessions: string[]): (day: string) => string {
  const sessionSet = new Set(sessions);
  const last = sessions[sessions.length - 1];
  const addDays = (day: string, n: number): string => new Date(dayMs(day) + n * DAY_MS).toISOString().slice(0, 10);
  const expiryOnOrAfter = (day: string): string => {
    let expiry = day;
    while (new Date(dayMs(expiry)).getUTCDay() !== 2) expiry = addDays(expiry, 1);
    // Holiday Tuesday (only knowable inside the data range): the session before it
    while (expiry <= last && !sessionSet.has(expiry)) expiry = addDays(expiry, -1);
    return expiry;
  };
  return (day: string): string => {
    const expiry = expiryOnOrAfter(day);
    return expiry === day ? expiryOnOrAfter(addDays(day, 1)) : expiry;
  };
}

const expiryCloseMs = (expiry: string): number => dayMs(expiry) + (15 * 60 + 30) * 60000 - IST_OFFSET_MS;

// ── Data ──────────────────────────────────────────────────────────────────

async function fetchCandles(instrumentKey: string, intervalMinutes: number, fromMs: number, toMs: number): Promise<Bar[]> {
  const byTime = new Map<number, Bar>();
  // Upstox serves at most ~1 month of minute candles per request
  for (let start = fromMs; start <= toMs; start += 25 * DAY_MS) {
    const end = Math.min(start + 24 * DAY_MS, toMs);
    const rows = await upstoxService.getCandles(instrumentKey, intervalMinutes, { fromDate: istDay(start), toDate: istDay(end) });
    for (const r of rows) byTime.set(r.candleStart.getTime(), r);
  }
  const now = Date.now();
  for (const r of await upstoxService.getCandles(instrumentKey, intervalMinutes)) {
    if (r.candleStart.getTime() + intervalMinutes * 60000 <= now) byTime.set(r.candleStart.getTime(), r);
  }
  return [...byTime.values()].sort((a, b) => a.candleStart.getTime() - b.candleStart.getTime());
}

const groupByDay = (bars: Bar[]): Map<string, Bar[]> => {
  const map = new Map<string, Bar[]>();
  for (const b of bars) {
    const day = istDay(b.candleStart.getTime());
    const list = map.get(day);
    if (list) list.push(b); else map.set(day, [b]);
  }
  return map;
};

/** India VIX at a time: the latest completed 5-minute close (falls back to the previous value). */
function vixLookup(vixBars: Bar[]): (ms: number) => number {
  const times = vixBars.map((b) => b.candleStart.getTime() + 5 * 60000);
  return (ms: number): number => {
    let lo = 0, hi = times.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found >= 0 ? vixBars[found].close : DEFAULT_VIX;
  };
}

/** Same rules as executionService.checkTechnicalReversal (runs only once the trail is active). */
function technicalReversal(candles: StrategyCandle[], side: 'CE' | 'PE', pnlPct: number): string | null {
  const bullish = side === 'CE';
  const closes = candles.map((c) => c.close);
  const st = supertrend(candles, 10, 3.0);
  if (st && bullish && st === 'BEARISH') return 'TECH_REVERSAL: Supertrend flipped BEARISH';
  if (st && !bullish && st === 'BULLISH') return 'TECH_REVERSAL: Supertrend flipped BULLISH';

  const e9 = ema(closes, 9), e21 = ema(closes, 21);
  const e9p = ema(closes.slice(0, -2), 9), e21p = ema(closes.slice(0, -2), 21);
  if (bullish && e9p > e21p && e9 < e21) return 'TECH_REVERSAL: EMA death cross';
  if (!bullish && e9p < e21p && e9 > e21) return 'TECH_REVERSAL: EMA golden cross';

  const r = rsi(closes, 14);
  const strongTrend = adx(closes, 14).adx >= 25;
  if (!strongTrend && bullish && r > 87) return `TECH_REVERSAL: RSI exhaustion ${r.toFixed(0)}`;
  if (!strongTrend && !bullish && r < 13) return `TECH_REVERSAL: RSI exhaustion ${r.toFixed(0)}`;

  const hNow = macd(closes).histogram, hPrev = macd(closes.slice(0, -2)).histogram;
  if (bullish && hNow < 0 && hPrev > 0 && pnlPct > 18) return 'TECH_REVERSAL: MACD histogram below zero';
  if (!bullish && hNow > 0 && hPrev < 0 && pnlPct > 18) return 'TECH_REVERSAL: MACD histogram above zero';
  return null;
}

// ── Engine ────────────────────────────────────────────────────────────────

interface Market {
  sessions: string[];
  fiveByDay: Map<string, Bar[]>;
  oneByDay: Map<string, Bar[]>;
  vixAt: (ms: number) => number;
  expiryFor: (day: string) => string;
}

interface EntrySignal {
  strategy: string;
  side: 'CE' | 'PE';
  premium: number;
  stopLoss: number;
  target: number;
  atr: number;
  confidence: number;
}

// Entry signals depend only on the market and the settings below, so variants that share those share them
const signalCache = new Map<string, EntrySignal | null>();
const SIGNAL_SETTINGS = [
  'strategyConfidenceThreshold', 'strategyRulesGateEnabled', 'aiMinProbabilityPct', 'strategyProfitTargetPct',
  'strategySlAtrMultiplier', 'strategySlMinPct', 'strategySlMaxPct',
] as const;

/** Applies a variant's env overrides for the duration of fn (env is a plain object at runtime). */
function withEnv<T>(overrides: Variant['env'], fn: () => T): T {
  const target = env as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(overrides)) { saved[k] = target[k]; target[k] = v; }
  try { return fn(); } finally { Object.assign(target, saved); }
}

function entrySignal(market: Market, day: string, warm: Bar[], five: Bar[], bar: Bar, now: number): EntrySignal | null {
  const key = [day, now, ...SIGNAL_SETTINGS.map((k) => env[k])].join('|');
  if (signalCache.has(key)) return signalCache.get(key) ?? null;

  const minute = istMinutes(now);
  const sessionCandles = five.filter((c) => c.candleStart.getTime() + 5 * 60000 <= now);
  const candles = [...warm, ...sessionCandles];
  let result: EntrySignal | null = null;
  if (candles.length >= 40) {
    const lastPrice = bar.close;
    const strike = Math.round(lastPrice / STRIKE_STEP) * STRIKE_STEP;
    const years = (expiryCloseMs(market.expiryFor(day)) - now) / YEAR_MS;
    const vol = (IV_PER_VIX * market.vixAt(now)) / 100;
    const callLtp = Math.round(optionPrice('CE', lastPrice, strike, years, vol) * 20) / 20;
    const putLtp = Math.round(optionPrice('PE', lastPrice, strike, years, vol) * 20) / 20;
    const ctx: StrategyContext = {
      underlying: UNDERLYING, prices: [], candles, sessionCandles, diagnostics: {}, lastPrice,
      pcr: 1, atmStrike: strike, callLtp, putLtp,
      callInstrumentKey: 'SIM-CE', putInstrumentKey: 'SIM-PE', expiryDate: market.expiryFor(day),
      timeIST: istClock(now), minutesToClose: 15 * 60 + 15 - minute, lotSize: LOT_SIZE,
      atmCallOi: 0, atmPutOi: 0, atmIv: null,
      dayHigh: Math.max(lastPrice, ...sessionCandles.map((c) => c.high)),
      dayLow: Math.min(lastPrice, ...sessionCandles.map((c) => c.low)),
      prevDayClose: warm.length ? warm[warm.length - 1].close : lastPrice,
      vix: market.vixAt(now),
    };
    const candidates = strategyRegistry.evaluateAll(ctx);
    if (candidates.length) {
      const { chosen } = selectByRules(ctx, candidates, lastPrice, env.strategyRulesGateEnabled);
      if (!(env.strategyRulesGateEnabled && chosen.blockReason)) {
        const { signal, strategyName } = chosen.candidate;
        const meta = signal.metadata as Record<string, unknown>;
        result = {
          strategy: strategyName, side: meta.bullish ? 'CE' : 'PE', premium: signal.entryPrice,
          stopLoss: signal.suggestedStopLoss, target: signal.suggestedTarget,
          atr: Number(meta.atr ?? 0), confidence: signal.confidence,
        };
      }
    }
  }
  signalCache.set(key, result);
  return result;
}

function runVariant(variant: Variant, market: Market): Trade[] {
  return withEnv(variant.env, () => {
    const trades: Trade[] = [];
    const { sessions, fiveByDay, oneByDay, vixAt, expiryFor } = market;
    const dailyLossLimit = -(env.strategyCapital * env.strategyDailyMaxLossPct) / 100; // same risk gate as live
    const lossCooldownMs = env.strategyLossCooldownMinutes * 60000;

    for (let d = WARMUP_SESSIONS; d < sessions.length; d++) {
      const day = sessions[d];
      const warm = sessions.slice(d - WARMUP_SESSIONS, d).flatMap((s) => fiveByDay.get(s) ?? []);
      const five = fiveByDay.get(day) ?? [];
      const ones = oneByDay.get(day) ?? [];
      let position: OpenPosition | null = null;
      let lastSignalAt = 0;
      let lastLossAt = 0;
      let tradesToday = 0;
      let dayPnl = 0;

      const premiumAt = (p: OpenPosition, index: number, at: number): number =>
        optionPrice(p.side, index, p.strike, (p.expiryMs - at) / YEAR_MS, (IV_PER_VIX * vixAt(at)) / 100);

      const close = (p: OpenPosition, at: number, index: number, premium: number, reason: string): void => {
        const pnl = (premium - p.premiumEntry) * LOT_SIZE - CHARGES_PER_ROUND_TRIP;
        dayPnl += pnl;
        if (premium < p.premiumEntry) lastLossAt = at; // live pauses on a gross loss (realizedPnl < 0)
        // A stop that was moved past the entry (trail / breakeven) is reported as a trail stop, as live
        const label = reason === 'STOP_LOSS_HIT' && p.stopLoss > p.premiumEntry ? 'TRAIL_STOP_HIT' : reason;
        trades.push({
          day, entryTime: istClock(p.entryTime), exitTime: istClock(at), strategy: p.strategy, side: p.side,
          strike: p.strike, expiry: p.expiry, indexEntry: p.indexEntry, indexExit: index,
          premiumEntry: p.premiumEntry, premiumExit: premium,
          bestPct: ((p.best - p.premiumEntry) / p.premiumEntry) * 100,
          returnPct: ((premium - p.premiumEntry) / p.premiumEntry) * 100, pnl, exitReason: label, confidence: p.confidence,
        });
      };

      for (const bar of ones) {
        const now = bar.candleStart.getTime() + 60000; // this 1-minute bar just closed
        const minute = istMinutes(now);

        // ── Manage the open position on this bar ──
        if (position) {
          const p = position;
          const [lowIdx, highIdx] = p.side === 'CE' ? [bar.low, bar.high] : [bar.high, bar.low];
          const premOpen = premiumAt(p, bar.open, now - 60000);
          const premLow = premiumAt(p, lowIdx, now);
          const premHigh = premiumAt(p, highIdx, now);
          const premClose = premiumAt(p, bar.close, now);

          if (premLow <= p.stopLoss) {
            close(p, now, lowIdx, Math.min(p.stopLoss, premOpen), 'STOP_LOSS_HIT');
            position = null;
          } else {
            p.best = Math.max(p.best, premHigh);
            const bestPct = ((p.best - p.premiumEntry) / p.premiumEntry) * 100;
            if (bestPct >= env.strategyTrailActivationPct) {
              p.trailActive = true;
              const atrDistance = p.entryAtr * ATM_DELTA * env.strategyTrailAtrMultiplier;
              const distance = Math.max(p.best * (env.strategyTrailOffsetPct / 100), atrDistance);
              p.stopLoss = Math.max(p.stopLoss, p.best - distance, p.premiumEntry * 1.01);
            } else if (env.strategyBreakevenTriggerPct > 0 && bestPct >= env.strategyBreakevenTriggerPct) {
              p.stopLoss = Math.max(p.stopLoss, p.premiumEntry * 1.01);
            }
            const pnlPct = ((premClose - p.premiumEntry) / p.premiumEntry) * 100;
            if (premHigh >= p.target) {
              close(p, now, highIdx, p.target, 'TARGET_HIT');
              position = null;
            } else if (premClose <= p.stopLoss) {
              close(p, now, bar.close, p.stopLoss, 'STOP_LOSS_HIT');
              position = null;
            } else if (minute >= 15 * 60 + 10) {
              close(p, now, bar.close, premClose, 'EOD_SQUAREOFF');
              position = null;
            } else if (p.trailActive) {
              const candles = [...warm, ...five.filter((c) => c.candleStart.getTime() + 5 * 60000 <= now)];
              const reason = candles.length >= 40 ? technicalReversal(candles, p.side, pnlPct) : null;
              if (reason) { close(p, now, bar.close, premClose, reason); position = null; }
            }
          }
        }

        // ── Entry scan (same gates as strategyService.evaluateAndQueueSignal) ──
        const minutesSinceOpen = minute - (9 * 60 + 15);
        const minutesToClose = 15 * 60 + 15 - minute;
        if (position || minutesSinceOpen < 15 || minutesToClose < 40) continue;
        if (tradesToday >= env.strategyMaxAutoTradesPerDay || dayPnl <= dailyLossLimit || now - lastSignalAt < COOLDOWN_MS) continue;
        if (lossCooldownMs > 0 && lastLossAt && now - lastLossAt < lossCooldownMs) continue;

        const signal = entrySignal(market, day, warm, five, bar, now);
        if (!signal) continue;

        lastSignalAt = now;
        tradesToday += 1;
        const expiry = expiryFor(day);
        position = {
          strategy: signal.strategy, side: signal.side, strike: Math.round(bar.close / STRIKE_STEP) * STRIKE_STEP,
          expiry, expiryMs: expiryCloseMs(expiry), entryTime: now, indexEntry: bar.close,
          premiumEntry: signal.premium, stopLoss: signal.stopLoss, target: signal.target,
          best: signal.premium, trailActive: false, entryAtr: signal.atr, confidence: signal.confidence,
        };
      }

      if (position) {
        const last = ones[ones.length - 1];
        const at = last.candleStart.getTime() + 60000;
        close(position, at, last.close, premiumAt(position, last.close, at), 'EOD_SQUAREOFF');
      }
    }
    return trades;
  });
}

function summarise(trades: Trade[]): Record<string, unknown> {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const t of trades) { equity += t.pnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); }
  const avg = (xs: number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
  const exitReasons: Record<string, number> = {};
  for (const t of trades) { const k = t.exitReason.split(':')[0]; exitReasons[k] = (exitReasons[k] ?? 0) + 1; }
  return {
    trades: trades.length,
    winRatePct: trades.length ? +((wins.length / trades.length) * 100).toFixed(1) : 0,
    netPnl: Math.round(grossWin - grossLoss),
    profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(2) : null,
    avgWinPct: +avg(wins.map((t) => t.returnPct)).toFixed(1),
    avgLossPct: +avg(losses.map((t) => t.returnPct)).toFixed(1),
    bestPct: trades.length ? +Math.max(...trades.map((t) => t.returnPct)).toFixed(1) : 0,
    maxDrawdown: Math.round(maxDrawdown),
    exitReasons,
  };
}

// v2.0 = the rules before v2.1; each v2.1 change alone, then the code defaults (v2.1 + .env)
const V20: Variant['env'] = { strategyBreakevenTriggerPct: 0, strategyLossCooldownMinutes: 0 };
const VARIANTS: Variant[] = [
  { name: 'v2.0', env: V20 },
  { name: 'v2.0 + pause after a loss', env: { ...V20, strategyLossCooldownMinutes: env.strategyLossCooldownMinutes } },
  { name: 'v2.0 + breakeven stop', env: { ...V20, strategyBreakevenTriggerPct: env.strategyBreakevenTriggerPct } },
  { name: 'v2.1 (code defaults)', env: {} },
];

async function main(): Promise<void> {
  const tradingDays = Math.max(0, Number(process.argv[2] ?? 20));
  const outPath = process.argv[3];
  const from = process.env.BACKTEST_FROM; // YYYY-MM-DD: test every session from this date instead
  const toMs = Date.now() - DAY_MS;
  const fromMs = from
    ? dayMs(from) - Math.ceil(WARMUP_SESSIONS * 1.6 + 6) * DAY_MS
    : toMs - Math.ceil((tradingDays + WARMUP_SESSIONS) * 1.6 + 4) * DAY_MS;

  // BACKTEST_CACHE=<file>: reuse the same candles across runs (parameter sweeps compare like with like)
  const { existsSync, readFileSync, writeFileSync } = await import('fs');
  const cacheFile = process.env.BACKTEST_CACHE;
  let five: Bar[];
  let one: Bar[];
  let vix: Bar[];
  if (cacheFile && existsSync(cacheFile)) {
    const revive = (rows: Bar[]): Bar[] => rows.map((r) => ({ ...r, candleStart: new Date(r.candleStart) }));
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as { five: Bar[]; one: Bar[]; vix: Bar[] };
    [five, one, vix] = [revive(cached.five), revive(cached.one), revive(cached.vix ?? [])];
  } else {
    process.stdout.write(`Fetching NIFTY + India VIX candles ${istDay(fromMs)} → today…\n`);
    [five, one, vix] = await Promise.all([
      fetchCandles(INSTRUMENT_KEY, 5, fromMs, toMs),
      fetchCandles(INSTRUMENT_KEY, 1, fromMs, toMs),
      fetchCandles(VIX_KEY, 5, fromMs, toMs),
    ]);
    if (cacheFile) writeFileSync(cacheFile, JSON.stringify({ five, one, vix }));
  }
  const fiveByDay = groupByDay(five);
  const oneByDay = groupByDay(one);
  // BACKTEST_SKIP_RECENT=N leaves out the N most recent sessions (out-of-sample checks on older data)
  const skipRecent = Math.max(0, Number(process.env.BACKTEST_SKIP_RECENT ?? 0));
  const allSessions = [...fiveByDay.keys()].filter((d) => oneByDay.has(d)).sort();
  const inRange = allSessions.slice(0, allSessions.length - skipRecent);
  const firstTested = from ? Math.max(WARMUP_SESSIONS, inRange.findIndex((d) => d >= from)) : Math.max(0, inRange.length - tradingDays);
  const sessions = inRange.slice(firstTested - WARMUP_SESSIONS);
  const market: Market = { sessions, fiveByDay, oneByDay, vixAt: vixLookup(vix), expiryFor: expiryCalendar(allSessions) };
  process.stdout.write(`Sessions: ${sessions.length - WARMUP_SESSIONS} tested (${sessions[WARMUP_SESSIONS]} → ${sessions[sessions.length - 1]}) + ${WARMUP_SESSIONS} warm-up\n`);

  // BACKTEST_VARIANTS=<file.json>: run these variants instead ([{ name, env }], env keys as in env.ts).
  // BACKTEST_MAIN_ONLY=1 runs just the code-default variant.
  const variantsFile = process.env.BACKTEST_VARIANTS;
  const variants: Variant[] = variantsFile
    ? JSON.parse(readFileSync(variantsFile, 'utf8')) as Variant[]
    : process.env.BACKTEST_MAIN_ONLY === '1' ? VARIANTS.slice(-1) : VARIANTS;
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), sessions: sessions.slice(WARMUP_SESSIONS), variants: {} };
  for (const variant of variants) {
    const trades = runVariant(variant, market);
    const byMonth: Record<string, unknown> = {};
    for (const m of [...new Set(trades.map((t) => t.day.slice(0, 7)))]) byMonth[m] = summarise(trades.filter((t) => t.day.startsWith(m)));
    const byDay: Record<string, number> = {};
    for (const t of trades) byDay[t.day] = Math.round((byDay[t.day] ?? 0) + t.pnl);
    (report.variants as Record<string, unknown>)[variant.name] = { env: variant.env, total: summarise(trades), byMonth, byDay, trades };
    process.stdout.write(`\n== ${variant.name}\n${JSON.stringify(summarise(trades))}\n`);
  }

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 1));
    process.stdout.write(`\nFull report: ${outPath}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`Backtest failed: ${String(error)}\n`);
  process.exit(1);
});
