/**
 * strategy-registry.service.ts
 *
 * Pluggable strategy registry. Each strategy implements the StrategyPlugin
 * interface and registers itself here. The main strategy service just calls
 * registry.runAll() and gets back a prioritised list of signals.
 *
 * Currently registered:
 *   - SMA_PCR      (original — SMA crossover + Put-Call Ratio)
 *   - VWAP_BOUNCE  (price bouncing off VWAP with volume confirmation)
 *   - EMA_CROSS    (9/21 EMA crossover with RSI filter)
 *
 * To add a new strategy: implement StrategyPlugin and call registry.register().
 */

import { env } from '../config/env';
import { StrategySignal, StrategySource } from '../types/trading.types';

// ── Plugin interface ───────────────────────────────────────────────────────

export interface StrategyContext {
  underlying: string;
  prices: number[];          // last N LTP ticks, oldest first
  lastPrice: number;
  pcr: number;               // put-call ratio from option chain
  atmStrike: number;
  callLtp: number;
  putLtp: number;
  callInstrumentKey: string | null;
  putInstrumentKey: string | null;
  expiryDate: string;
  timeIST: string;
  minutesToClose: number;
  lotSize: number;
}

export interface StrategyPlugin {
  name: string;              // e.g. 'SMA_PCR'
  enabled: boolean;
  minHistoryLength: number;  // minimum ticks needed
  evaluate(ctx: StrategyContext): StrategySignal | null;
}

// ── Math helpers shared across strategies ──────────────────────────────────

function avg(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function ema(prices: number[], period: number): number {
  const k = 2 / (period + 1);
  let e = prices[0];
  for (let i = 1; i < prices.length; i++) e = prices[i] * k + e * (1 - k);
  return e;
}

function rsi(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const ag = gains / period;
  const al = losses / period;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

// ── Strategy 1: SMA_PCR (original — production-proven) ────────────────────

const smaPcrStrategy: StrategyPlugin = {
  name: 'SMA_PCR',
  enabled: true,
  minHistoryLength: 40,

  evaluate(ctx: StrategyContext): StrategySignal | null {
    const { prices, lastPrice, pcr, callInstrumentKey, putInstrumentKey, callLtp, putLtp, lotSize, underlying, expiryDate, timeIST, minutesToClose, atmStrike } = ctx;

    const smaFast = avg(prices.slice(-10));
    const smaSlow = avg(prices.slice(-30));
    const momentum = (lastPrice - prices[prices.length - 20]) / prices[prices.length - 20];

    const bullish = smaFast > smaSlow && momentum > 0 && pcr >= 1;
    const bearish = smaFast < smaSlow && momentum < 0 && pcr <= 1;
    if (!bullish && !bearish) return null;

    const optionKey = bullish ? callInstrumentKey : putInstrumentKey;
    const optionLtp = bullish ? callLtp : putLtp;
    if (!optionKey || !optionLtp || optionLtp <= 0) return null;

    const confidence = Math.min(0.99,
      0.5 + Math.abs((smaFast - smaSlow) / lastPrice) * 8
          + Math.abs(pcr - 1) * 0.18
          + Math.abs(momentum) * 4,
    );

    if (confidence < env.strategyConfidenceThreshold) return null;

    const rsi14 = rsi(prices, 14);
    const ema9 = ema(prices, 9);
    const ema21 = ema(prices, 21);
    const vwapApprox = avg(prices);
    const ema12 = ema(prices, 12);
    const ema26 = ema(prices, 26);
    const macdLine = ema12 - ema26;
    const macdSig = macdLine * (2 / 10) + macdLine * (1 - 2 / 10);

    return {
      source: 'SMA_PCR' as StrategySource,
      side: 'BUY',
      symbol: `${underlying}-${bullish ? 'CE' : 'PE'}`,
      instrumentKey: optionKey,
      quantity: lotSize,
      confidence,
      rationale: `SMA(${smaFast.toFixed(0)}>${smaSlow.toFixed(0)}), Mom=${(momentum*100).toFixed(2)}%, PCR=${pcr.toFixed(2)}, RSI=${rsi14.toFixed(0)}`,
      entryPrice: optionLtp,
      suggestedStopLoss: optionLtp * (1 - env.strategyEntryStopLossPct / 100),
      suggestedTarget: optionLtp * (1 + env.strategyProfitTargetPct / 100),
      metadata: {
        underlying, bullish, pcr, smaFast, smaSlow, momentum,
        strike: atmStrike, expiryDate, indexLtp: lastPrice,
        rsi14, ema9, ema21, macd: macdLine, macdSignal: macdSig,
        macdHistogram: macdLine - macdSig, vwap: vwapApprox,
        volumeRatio: 1, timeIST, minutesToClose,
        atmCallOI: 0, atmPutOI: 0, ivPercentile: 40,
        dayHigh: Math.max(...prices.slice(-20)),
        dayLow: Math.min(...prices.slice(-20)),
        prevDayClose: prices[0],
      },
    };
  },
};

// ── Strategy 2: VWAP_BOUNCE ────────────────────────────────────────────────
// Price dips to VWAP, bounces with volume confirmation + RSI not overbought.

const vwapBounceStrategy: StrategyPlugin = {
  name: 'VWAP_BOUNCE',
  enabled: true,
  minHistoryLength: 20,

  evaluate(ctx: StrategyContext): StrategySignal | null {
    const { prices, lastPrice, callInstrumentKey, putInstrumentKey, callLtp, putLtp, lotSize, underlying, expiryDate, timeIST, minutesToClose, atmStrike } = ctx;

    const vwapVal = avg(prices);
    const rsi14 = rsi(prices, 14);
    const ema9Val = ema(prices, 9);

    // Bullish VWAP bounce: price just crossed above VWAP from below
    const prev = prices[prices.length - 2] ?? lastPrice;
    const crossedAbove = prev < vwapVal && lastPrice > vwapVal;
    // Bearish VWAP rejection: price crossed below VWAP from above
    const crossedBelow = prev > vwapVal && lastPrice < vwapVal;

    if (!crossedAbove && !crossedBelow) return null;

    const bullish = crossedAbove && rsi14 < 70 && ema9Val > vwapVal;
    const bearish = crossedBelow && rsi14 > 30 && ema9Val < vwapVal;
    if (!bullish && !bearish) return null;

    const optionKey = bullish ? callInstrumentKey : putInstrumentKey;
    const optionLtp = bullish ? callLtp : putLtp;
    if (!optionKey || !optionLtp || optionLtp <= 0) return null;

    // VWAP bounce has a tighter confidence band
    const vwapDist = Math.abs(lastPrice - vwapVal) / vwapVal;
    const confidence = Math.min(0.85, 0.55 + (1 - vwapDist * 200) * 0.3);
    if (confidence < env.strategyConfidenceThreshold) return null;

    return {
      source: 'VWAP_BOUNCE' as StrategySource,
      side: 'BUY',
      symbol: `${underlying}-${bullish ? 'CE' : 'PE'}`,
      instrumentKey: optionKey,
      quantity: lotSize,
      confidence,
      rationale: `VWAP_BOUNCE: Price ${bullish ? 'crossed above' : 'rejected below'} VWAP(${vwapVal.toFixed(0)}), RSI=${rsi14.toFixed(0)}`,
      entryPrice: optionLtp,
      suggestedStopLoss: optionLtp * (1 - env.strategyEntryStopLossPct / 100),
      suggestedTarget: optionLtp * (1 + env.strategyProfitTargetPct / 100),
      metadata: {
        underlying, bullish, pcr: ctx.pcr, strike: atmStrike,
        expiryDate, indexLtp: lastPrice, vwap: vwapVal,
        rsi14, ema9: ema9Val, timeIST, minutesToClose,
        dayHigh: Math.max(...prices.slice(-20)),
        dayLow: Math.min(...prices.slice(-20)),
        prevDayClose: prices[0],
        strategyName: 'VWAP_BOUNCE',
      },
    };
  },
};

// ── Strategy 3: EMA_CROSS ──────────────────────────────────────────────────
// 9/21 EMA crossover with RSI filter — classic momentum entry.

const emaCrossStrategy: StrategyPlugin = {
  name: 'EMA_CROSS',
  enabled: true,
  minHistoryLength: 30,

  evaluate(ctx: StrategyContext): StrategySignal | null {
    const { prices, lastPrice, callInstrumentKey, putInstrumentKey, callLtp, putLtp, lotSize, underlying, expiryDate, timeIST, minutesToClose, atmStrike, pcr } = ctx;

    if (prices.length < 22) return null;

    const ema9Now = ema(prices, 9);
    const ema21Now = ema(prices, 21);
    const ema9Prev = ema(prices.slice(0, -1), 9);
    const ema21Prev = ema(prices.slice(0, -1), 21);

    // Golden cross: 9 EMA crossed above 21 EMA this candle
    const goldenCross = ema9Prev <= ema21Prev && ema9Now > ema21Now;
    // Death cross: 9 EMA crossed below 21 EMA this candle
    const deathCross = ema9Prev >= ema21Prev && ema9Now < ema21Now;

    if (!goldenCross && !deathCross) return null;

    const rsi14 = rsi(prices, 14);
    // Filter: golden cross only valid if RSI not already overbought
    if (goldenCross && rsi14 > 72) return null;
    // Filter: death cross only valid if RSI not already oversold
    if (deathCross && rsi14 < 28) return null;

    const bullish = goldenCross;
    const optionKey = bullish ? callInstrumentKey : putInstrumentKey;
    const optionLtp = bullish ? callLtp : putLtp;
    if (!optionKey || !optionLtp || optionLtp <= 0) return null;

    const emaDiff = Math.abs(ema9Now - ema21Now) / lastPrice;
    const confidence = Math.min(0.88, 0.58 + emaDiff * 50 + Math.abs(rsi14 - 50) * 0.004);
    if (confidence < env.strategyConfidenceThreshold) return null;

    return {
      source: 'EMA_CROSS' as StrategySource,
      side: 'BUY',
      symbol: `${underlying}-${bullish ? 'CE' : 'PE'}`,
      instrumentKey: optionKey,
      quantity: lotSize,
      confidence,
      rationale: `EMA_CROSS: ${bullish ? 'Golden' : 'Death'} cross — 9EMA(${ema9Now.toFixed(0)}) vs 21EMA(${ema21Now.toFixed(0)}), RSI=${rsi14.toFixed(0)}`,
      entryPrice: optionLtp,
      suggestedStopLoss: optionLtp * (1 - env.strategyEntryStopLossPct / 100),
      suggestedTarget: optionLtp * (1 + env.strategyProfitTargetPct / 100),
      metadata: {
        underlying, bullish, pcr, strike: atmStrike,
        expiryDate, indexLtp: lastPrice,
        ema9: ema9Now, ema21: ema21Now, rsi14, timeIST, minutesToClose,
        dayHigh: Math.max(...prices.slice(-20)),
        dayLow: Math.min(...prices.slice(-20)),
        prevDayClose: prices[0],
        strategyName: 'EMA_CROSS',
      },
    };
  },
};

// ── Registry ───────────────────────────────────────────────────────────────

class StrategyRegistry {
  private plugins: StrategyPlugin[] = [];

  constructor() {
    // Register all strategies in priority order
    // The first signal that passes all gates wins in a given cycle
    this.register(smaPcrStrategy);
    this.register(vwapBounceStrategy);
    this.register(emaCrossStrategy);
  }

  register(plugin: StrategyPlugin): void {
    this.plugins.push(plugin);
  }

  /**
   * Run all enabled strategies on the given context.
   * Returns the highest-confidence signal that meets minimum requirements,
   * or null if none qualify.
   */
  runAll(ctx: StrategyContext): { signal: StrategySignal; strategyName: string } | null {
    const candidates: { signal: StrategySignal; strategyName: string }[] = [];

    for (const plugin of this.plugins) {
      if (!plugin.enabled) continue;
      if (ctx.prices.length < plugin.minHistoryLength) continue;

      try {
        const signal = plugin.evaluate(ctx);
        if (signal) {
          candidates.push({ signal, strategyName: plugin.name });
        }
      } catch (err) {
        process.stderr.write(`[StrategyRegistry] ${plugin.name} threw: ${String(err)}\n`);
      }
    }

    if (!candidates.length) return null;

    // Pick highest confidence
    candidates.sort((a, b) => b.signal.confidence - a.signal.confidence);
    return candidates[0];
  }

  getEnabled(): string[] {
    return this.plugins.filter((p) => p.enabled).map((p) => p.name);
  }

  setEnabled(name: string, enabled: boolean): boolean {
    const plugin = this.plugins.find((p) => p.name === name);
    if (!plugin) return false;
    plugin.enabled = enabled;
    return true;
  }
}

export const strategyRegistry = new StrategyRegistry();
