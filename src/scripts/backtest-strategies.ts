/**
 * Offline backtest of the strategy pipeline on Upstox historical NIFTY candles.
 *
 *   npm run build && node dist/scripts/backtest-strategies.js [tradingDays=20] [out.json]
 *
 * Mirrors the live engine at 1-minute resolution (live scans every 20 s): entries are evaluated at
 * every 1-minute close on COMPLETED 5-minute candles with the same warm-up, plugins, rules gate,
 * entry window (09:30–14:35 IST), 5-minute cooldown and one-position limit. Exits replay the stop
 * loss, target, trailing stop, technical-reversal and 15:10 square-off rules on 1-minute bars.
 *
 * The option premium is MODELLED — ATM premium ≈ 0.45% of spot at entry, moving with delta 0.5,
 * no theta or IV change. Use the results to compare strategy versions, not as a P&L forecast.
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
const UNDERLYING = 'NIFTY';
const LOT_SIZE = 65;
const PREMIUM_PCT_OF_SPOT = 0.0045;
const CHARGES_PER_ROUND_TRIP = 60;
const WARMUP_SESSIONS = env.strategyWarmupSessions;
const COOLDOWN_MS = 5 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Bar extends StrategyCandle { volume: number }

interface Trade {
  day: string;
  entryTime: string;
  exitTime: string;
  strategy: string;
  side: 'CE' | 'PE';
  indexEntry: number;
  indexExit: number;
  premiumEntry: number;
  premiumExit: number;
  returnPct: number;
  pnl: number;
  exitReason: string;
  confidence: number;
}

interface OpenPosition {
  strategy: string;
  side: 'CE' | 'PE';
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

const istDay = (ms: number): string => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const istMinutes = (ms: number): number => Math.floor(((ms + IST_OFFSET_MS) % DAY_MS) / 60000);
const istClock = (ms: number): string => new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16);

async function fetchCandles(intervalMinutes: number, fromMs: number, toMs: number): Promise<Bar[]> {
  const byTime = new Map<number, Bar>();
  // Upstox serves at most ~1 month of minute candles per request
  for (let start = fromMs; start <= toMs; start += 25 * DAY_MS) {
    const end = Math.min(start + 24 * DAY_MS, toMs);
    const rows = await upstoxService.getCandles(INSTRUMENT_KEY, intervalMinutes, { fromDate: istDay(start), toDate: istDay(end) });
    for (const r of rows) byTime.set(r.candleStart.getTime(), r);
  }
  const now = Date.now();
  for (const r of await upstoxService.getCandles(INSTRUMENT_KEY, intervalMinutes)) {
    if (r.candleStart.getTime() + intervalMinutes * 60000 <= now) byTime.set(r.candleStart.getTime(), r);
  }
  return [...byTime.values()].sort((a, b) => a.candleStart.getTime() - b.candleStart.getTime());
}

const groupByDay = (bars: Bar[]): Map<string, Bar[]> => {
  const map = new Map<string, Bar[]>();
  for (const b of bars) {
    const day = istDay(b.candleStart.getTime());
    map.set(day, [...(map.get(day) ?? []), b]);
  }
  return map;
};

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

function runVariant(
  name: string,
  sessions: string[],
  fiveByDay: Map<string, Bar[]>,
  oneByDay: Map<string, Bar[]>,
  opts: { warmup: boolean; disable: string[] },
): Trade[] {
  for (const s of strategyRegistry.listNames()) strategyRegistry.setEnabled(s, !opts.disable.includes(s));

  const trades: Trade[] = [];

  for (let d = WARMUP_SESSIONS; d < sessions.length; d++) {
    const day = sessions[d];
    const warm = opts.warmup ? sessions.slice(d - WARMUP_SESSIONS, d).flatMap((s) => fiveByDay.get(s) ?? []) : [];
    const five = fiveByDay.get(day) ?? [];
    const ones = oneByDay.get(day) ?? [];
    let position: OpenPosition | null = null;
    let lastSignalAt = 0;
    let tradesToday = 0;
    let dayPnl = 0;
    const dailyLossLimit = -(env.strategyCapital * env.strategyDailyMaxLossPct) / 100; // same risk gate as live

    const premiumAt = (p: OpenPosition, index: number): number =>
      Math.max(0.5, p.premiumEntry + (p.side === 'CE' ? 1 : -1) * ATM_DELTA * (index - p.indexEntry));

    const close = (p: OpenPosition, at: number, index: number, premium: number, reason: string): void => {
      const ret = (premium - p.premiumEntry) / p.premiumEntry;
      const pnl = (premium - p.premiumEntry) * LOT_SIZE - CHARGES_PER_ROUND_TRIP;
      dayPnl += pnl;
      trades.push({
        day, entryTime: istClock(p.entryTime), exitTime: istClock(at), strategy: p.strategy, side: p.side,
        indexEntry: p.indexEntry, indexExit: index, premiumEntry: p.premiumEntry, premiumExit: premium,
        returnPct: ret * 100, pnl, exitReason: reason, confidence: p.confidence,
      });
    };

    for (const bar of ones) {
      const now = bar.candleStart.getTime() + 60000; // this 1-minute bar just closed
      const minute = istMinutes(now);
      const sessionCandles = five.filter((c) => c.candleStart.getTime() + 5 * 60000 <= now);
      const candles = [...warm, ...sessionCandles];

      // ── Manage the open position on this bar ──
      if (position) {
        const p = position;
        const [lowIdx, highIdx] = p.side === 'CE' ? [bar.low, bar.high] : [bar.high, bar.low];
        const premOpen = premiumAt(p, bar.open);
        const premLow = premiumAt(p, lowIdx);
        const premHigh = premiumAt(p, highIdx);
        const premClose = premiumAt(p, bar.close);

        if (premLow <= p.stopLoss) {
          close(p, now, lowIdx, Math.min(p.stopLoss, premOpen), 'STOP_LOSS_HIT');
          position = null;
        } else {
          p.best = Math.max(p.best, premHigh);
          if (((p.best - p.premiumEntry) / p.premiumEntry) * 100 >= env.strategyTrailActivationPct) {
            p.trailActive = true;
            const atrDistance = p.entryAtr * ATM_DELTA * env.strategyTrailAtrMultiplier;
            const distance = Math.max(p.best * (env.strategyTrailOffsetPct / 100), atrDistance);
            p.stopLoss = Math.max(p.stopLoss, p.best - distance, p.premiumEntry * 1.01);
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
          } else if (p.trailActive && candles.length >= 40) {
            const reason = technicalReversal(candles, p.side, pnlPct);
            if (reason) { close(p, now, bar.close, premClose, reason); position = null; }
          }
        }
      }

      // ── Entry scan (same gates as strategyService.evaluateAndQueueSignal) ──
      const minutesSinceOpen = minute - (9 * 60 + 15);
      const minutesToClose = 15 * 60 + 15 - minute;
      if (position || minutesSinceOpen < 15 || minutesToClose < 40) continue;
      if (tradesToday >= env.strategyMaxAutoTradesPerDay || dayPnl <= dailyLossLimit || now - lastSignalAt < COOLDOWN_MS) continue;
      if (candles.length < 40) continue;

      const lastPrice = bar.close;
      const premium = Math.round(lastPrice * PREMIUM_PCT_OF_SPOT * 20) / 20;
      const ctx: StrategyContext = {
        underlying: UNDERLYING, prices: [], candles, sessionCandles, diagnostics: {}, lastPrice,
        pcr: 1, atmStrike: Math.round(lastPrice / 50) * 50, callLtp: premium, putLtp: premium,
        callInstrumentKey: 'SIM-CE', putInstrumentKey: 'SIM-PE', expiryDate: 'SIM',
        timeIST: istClock(now), minutesToClose, lotSize: LOT_SIZE, atmCallOi: 0, atmPutOi: 0, atmIv: null,
        dayHigh: Math.max(lastPrice, ...sessionCandles.map((c) => c.high)),
        dayLow: Math.min(lastPrice, ...sessionCandles.map((c) => c.low)),
        prevDayClose: warm.length ? warm[warm.length - 1].close : lastPrice,
        vix: 0,
      };

      const candidates = strategyRegistry.evaluateAll(ctx);
      if (!candidates.length) continue;
      const { chosen } = selectByRules(ctx, candidates, lastPrice, env.strategyRulesGateEnabled);
      if (env.strategyRulesGateEnabled && chosen.blockReason) continue;
      const { signal, strategyName } = chosen.candidate;
      const bullish = Boolean((signal.metadata as Record<string, unknown>).bullish);

      lastSignalAt = now;
      tradesToday += 1;
      position = {
        strategy: strategyName, side: bullish ? 'CE' : 'PE', entryTime: now, indexEntry: lastPrice,
        premiumEntry: signal.entryPrice, stopLoss: signal.suggestedStopLoss, target: signal.suggestedTarget,
        best: signal.entryPrice, trailActive: false,
        entryAtr: Number((signal.metadata as Record<string, unknown>).atr ?? 0), confidence: signal.confidence,
      };
    }

    if (position) {
      const last = ones[ones.length - 1];
      close(position, last.candleStart.getTime() + 60000, last.close, premiumAt(position, last.close), 'EOD_SQUAREOFF');
    }
  }

  process.stdout.write(`  ${name}: ${trades.length} trades\n`);
  return trades;
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

async function main(): Promise<void> {
  const tradingDays = Math.max(3, Number(process.argv[2] ?? 20));
  const outPath = process.argv[3];
  const toMs = Date.now() - DAY_MS;
  const fromMs = toMs - Math.ceil((tradingDays + WARMUP_SESSIONS) * 1.6 + 4) * DAY_MS;

  // BACKTEST_CACHE=<file>: reuse the same candles across runs (parameter sweeps compare like with like)
  const { existsSync, readFileSync, writeFileSync } = await import('fs');
  const cacheFile = process.env.BACKTEST_CACHE;
  let five: Bar[];
  let one: Bar[];
  if (cacheFile && existsSync(cacheFile)) {
    const revive = (rows: Bar[]): Bar[] => rows.map((r) => ({ ...r, candleStart: new Date(r.candleStart) }));
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as { five: Bar[]; one: Bar[] };
    [five, one] = [revive(cached.five), revive(cached.one)];
  } else {
    process.stdout.write(`Fetching NIFTY candles ${istDay(fromMs)} → today…\n`);
    [five, one] = await Promise.all([fetchCandles(5, fromMs, toMs), fetchCandles(1, fromMs, toMs)]);
    if (cacheFile) writeFileSync(cacheFile, JSON.stringify({ five, one }));
  }
  const fiveByDay = groupByDay(five);
  const oneByDay = groupByDay(one);
  // BACKTEST_SKIP_RECENT=N leaves out the N most recent sessions (out-of-sample checks on older data)
  const skipRecent = Math.max(0, Number(process.env.BACKTEST_SKIP_RECENT ?? 0));
  const allSessions = [...fiveByDay.keys()].filter((d) => oneByDay.has(d)).sort();
  const sessions = allSessions.slice(0, allSessions.length - skipRecent).slice(-(tradingDays + WARMUP_SESSIONS));
  process.stdout.write(`Sessions: ${sessions.length - WARMUP_SESSIONS} tested (${sessions[WARMUP_SESSIONS]} → ${sessions[sessions.length - 1]}) + ${WARMUP_SESSIONS} warm-up\n`);

  // BACKTEST_MAIN_ONLY=1 runs just the main variant (for parameter sweeps via env overrides)
  const variants: Record<string, Trade[]> = {
    'v2.0 (all fixes)': runVariant('v2.0', sessions, fiveByDay, oneByDay, { warmup: true, disable: [] }),
  };
  if (process.env.BACKTEST_MAIN_ONLY !== '1') {
    variants['old data: today-only candles'] = runVariant('no-warmup', sessions, fiveByDay, oneByDay, { warmup: false, disable: [] });
  }

  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), sessions: sessions.slice(WARMUP_SESSIONS), variants: {} };
  for (const [label, trades] of Object.entries(variants)) {
    const byStrategy: Record<string, unknown> = {};
    for (const s of [...new Set(trades.map((t) => t.strategy))]) byStrategy[s] = summarise(trades.filter((t) => t.strategy === s));
    const byDay: Record<string, number> = {};
    for (const t of trades) byDay[t.day] = Math.round((byDay[t.day] ?? 0) + t.pnl);
    (report.variants as Record<string, unknown>)[label] = { total: summarise(trades), byStrategy, byDay, trades };
    process.stdout.write(`\n== ${label}\n${JSON.stringify(summarise(trades))}\n`);
    for (const [s, v] of Object.entries(byStrategy)) process.stdout.write(`   ${s.padEnd(20)} ${JSON.stringify(v)}\n`);
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
