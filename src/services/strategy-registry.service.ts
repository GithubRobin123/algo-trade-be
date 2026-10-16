/**
 * strategy-registry.service.ts
 *
 * Pluggable strategy registry. Each strategy implements the StrategyPlugin
 * interface and registers itself here.
 *
 * All indicators run on 5-minute candle closes (ctx.candles[] = previous-session warm-up + today,
 * completed candles only — see historical-candle.service.ts). There is NO tick fallback: raw
 * 1-second ticks gave ATR ≈ 1 point and RSI 97 on noise. A plugin that has too few candles is
 * skipped, and every plugin records why it produced no signal in ctx.diagnostics.
 *
 * Additional fixes in this revision:
 *   - VWAP = session-only typical-price average (resets at 9:15 AM)
 *   - Standard Supertrend computed over the candle series (deterministic)
 *   - dayHigh / dayLow from candle metadata, not rolling tick window
 *   - prevDayClose from candle.prevClose (Upstox full-quote OHLC)
 *   - ATM OI wired in from StrategyContext (no more hardcoded 0)
 *
 * Registered strategies (priority order):
 *   1. SUPERTREND        — ATR-based, ADX-gated
 *   2. EMA_CROSS         — 9/21 EMA crossover
 *   3. VWAP_BOUNCE       — VWAP retest with RSI confirmation
 *   4. BOLLINGER_BREAKOUT — BB extremes + squeeze breakout
 *   5. STOCHASTIC_MOMENTUM — Stoch %K/%D crossover in extremes
 *   6. SMA_PCR           — SMA crossover + PCR (most permissive, last resort)
 */

import { env } from '../config/env';
import { StrategySignal, StrategySource } from '../types/trading.types';
import type { StrategyCandle } from './historical-candle.service';

// ── Plugin interface ───────────────────────────────────────────────────────

export interface StrategyContext {
  underlying: string;
  prices: number[];          // today's LTP ticks, oldest first (not used for indicators)
  candles: StrategyCandle[]; // 5-min candles: warm-up sessions + today, oldest first
  sessionCandles: StrategyCandle[]; // today's 5-min candles only (VWAP)
  diagnostics?: Record<string, string>; // plugin name → why it produced no signal
  lastPrice: number;
  pcr: number;               // put-call ratio from ±10 ATM strikes
  atmStrike: number;
  callLtp: number;
  putLtp: number;
  callInstrumentKey: string | null;
  putInstrumentKey: string | null;
  expiryDate: string;
  timeIST: string;
  minutesToClose: number;
  lotSize: number;
  atmCallOi: number;         // actual ATM call OI from chain
  atmPutOi: number;          // actual ATM put OI from chain
  atmIv: number | null;      // ATM implied volatility from chain
  dayHigh: number;           // session high from Upstox OHLC
  dayLow: number;            // session low from Upstox OHLC
  prevDayClose: number;      // previous trading day's close
  vix: number;               // India VIX
}

export interface StrategyPlugin {
  name: string;
  enabled: boolean;
  minCandleLength: number;   // minimum 5-min candles needed (warm-up included)
  evaluate(ctx: StrategyContext): StrategySignal | null;
}

// ── Candle helpers ─────────────────────────────────────────────────────────

/** Close prices of the 5-minute candles (warm-up + today). */
function closePrices(ctx: StrategyContext): number[] {
  return ctx.candles.map((c) => Number(c.close));
}

/** Session VWAP from today's candles (typical price = (H+L+C)/3). Resets at 9:15 AM IST. */
function sessionVwap(ctx: StrategyContext): number {
  if (!ctx.sessionCandles.length) return ctx.lastPrice;
  const sumTP = ctx.sessionCandles.reduce((s, c) => s + (Number(c.high) + Number(c.low) + Number(c.close)) / 3, 0);
  return sumTP / ctx.sessionCandles.length;
}

/** Records why a plugin produced no signal (logged with NO_SIGNAL decisions) and returns null. */
function skip(ctx: StrategyContext, plugin: string, reason: string): null {
  if (ctx.diagnostics) ctx.diagnostics[plugin] = reason;
  return null;
}

// ── Math helpers ──────────────────────────────────────────────────────────

function avg(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = avg(values);
  return Math.sqrt(values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length);
}

export function ema(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  // Seed with SMA of first `period` values (more accurate than seeding with prices[0])
  const seed = prices.slice(0, Math.min(period, prices.length));
  let e = avg(seed);
  const k = 2 / (period + 1);
  for (let i = seed.length; i < prices.length; i++) e = prices[i] * k + e * (1 - k);
  return e;
}

export function rsi(prices: number[], period = 14): number {
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

export function macd(prices: number[], fast = 12, slow = 26, signal = 9): {
  macdLine: number; signalLine: number; histogram: number;
} {
  if (prices.length < slow + signal) return { macdLine: 0, signalLine: 0, histogram: 0 };
  const macdHistory: number[] = [];
  const start = Math.max(0, prices.length - (slow + signal + 5));
  for (let i = start + slow - 1; i < prices.length; i++) {
    const slice = prices.slice(start, i + 1);
    macdHistory.push(ema(slice, fast) - ema(slice, slow));
  }
  const macdLine = macdHistory[macdHistory.length - 1] ?? 0;
  const signalLine = ema(macdHistory, signal);
  return { macdLine, signalLine, histogram: macdLine - signalLine };
}

export function atr(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 0;
  const trValues: number[] = [];
  for (let i = 1; i < prices.length; i++) trValues.push(Math.abs(prices[i] - prices[i - 1]));
  // Wilder's smoothing (RMA)
  let rma = avg(trValues.slice(0, period));
  for (let i = period; i < trValues.length; i++) rma = (rma * (period - 1) + trValues[i]) / period;
  return rma;
}

export function bollingerBands(prices: number[], period = 20, multiplier = 2): {
  upper: number; middle: number; lower: number; bandwidth: number; percentB: number;
} {
  if (prices.length < period) {
    const p = prices[prices.length - 1] ?? 0;
    return { upper: p, middle: p, lower: p, bandwidth: 0, percentB: 0.5 };
  }
  const slice = prices.slice(-period);
  const middle = avg(slice);
  const sd = stdDev(slice);
  const upper = middle + multiplier * sd;
  const lower = middle - multiplier * sd;
  const bandwidth = middle > 0 ? ((upper - lower) / middle) * 100 : 0;
  const lastP = prices[prices.length - 1];
  const percentB = (upper - lower) > 0 ? (lastP - lower) / (upper - lower) : 0.5;
  return { upper, middle, lower, bandwidth, percentB };
}

/**
 * Wilder ADX over the whole series (close-to-close moves). The DX series runs bar by bar up
 * to the latest price, so the newest candles always count — the previous windowed version
 * stopped at the middle of the series and ignored the most recent data.
 */
export function adx(prices: number[], period = 14): { adx: number; trending: boolean } {
  if (prices.length < period * 2) return { adx: 0, trending: false };
  const dmPlus: number[] = [], dmMinus: number[] = [], trValues: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    dmPlus.push(diff > 0 ? diff : 0);
    dmMinus.push(diff < 0 ? Math.abs(diff) : 0);
    trValues.push(Math.abs(diff));
  }

  // Wilder running sums: seed with the first `period` values, then S = S − S/period + x
  let sTr = trValues.slice(0, period).reduce((s, v) => s + v, 0);
  let sPlus = dmPlus.slice(0, period).reduce((s, v) => s + v, 0);
  let sMinus = dmMinus.slice(0, period).reduce((s, v) => s + v, 0);
  const dx: number[] = [];
  const pushDx = (): void => {
    if (sTr === 0) { dx.push(0); return; }
    const diPlus = (sPlus / sTr) * 100;
    const diMinus = (sMinus / sTr) * 100;
    dx.push(diPlus + diMinus > 0 ? (Math.abs(diPlus - diMinus) / (diPlus + diMinus)) * 100 : 0);
  };
  pushDx();
  for (let i = period; i < trValues.length; i++) {
    sTr = sTr - sTr / period + trValues[i];
    sPlus = sPlus - sPlus / period + dmPlus[i];
    sMinus = sMinus - sMinus / period + dmMinus[i];
    pushDx();
  }

  // ADX = Wilder average of DX
  let adxVal = avg(dx.slice(0, period));
  for (let i = period; i < dx.length; i++) adxVal = (adxVal * (period - 1) + dx[i]) / period;
  return { adx: Math.min(100, adxVal), trending: adxVal > 20 };
}

/**
 * Standard Supertrend (HL2 ± multiplier × Wilder true-range ATR, ratcheting final bands) computed
 * bar by bar over the whole candle series, so the result depends only on the candles. The
 * previous version kept the direction in a module-level cache between calls, so the same candles
 * could give BULLISH or BEARISH depending on call history (process restart, entry vs exit check).
 */
export function supertrend(
  candles: StrategyCandle[],
  period = 10,
  multiplier = 3.0,
): 'BULLISH' | 'BEARISH' | null {
  if (candles.length < period * 2 + 2) return null;

  let atrValue = 0;
  let finalUpper = 0;
  let finalLower = 0;
  let direction: 'BULLISH' | 'BEARISH' = 'BULLISH';

  for (let i = 1; i < candles.length; i++) {
    const { high, low, close } = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrValue = i <= period ? atrValue + tr / period : (atrValue * (period - 1) + tr) / period;
    if (i < period) continue;

    const hl2 = (high + low) / 2;
    const basicUpper = hl2 + multiplier * atrValue;
    const basicLower = hl2 - multiplier * atrValue;
    if (i === period) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      direction = close >= hl2 ? 'BULLISH' : 'BEARISH';
      continue;
    }

    finalUpper = basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
    finalLower = basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;
    if (direction === 'BEARISH' && close > finalUpper) direction = 'BULLISH';
    else if (direction === 'BULLISH' && close < finalLower) direction = 'BEARISH';
  }

  return direction;
}

export function stochastic(prices: number[], period = 14, smoothing = 3): { k: number; d: number } {
  if (prices.length < period + smoothing) return { k: 50, d: 50 };
  const kValues: number[] = [];
  for (let i = period - 1; i < prices.length; i++) {
    const window = prices.slice(i - period + 1, i + 1);
    const highest = Math.max(...window);
    const lowest = Math.min(...window);
    const range = highest - lowest;
    kValues.push(range > 0 ? ((prices[i] - lowest) / range) * 100 : 50);
  }
  const kLast = kValues[kValues.length - 1] ?? 50;
  const dLast = avg(kValues.slice(-smoothing));
  return { k: kLast, d: dLast };
}

// An ATM option moves roughly half as many points as the index
export const ATM_DELTA = 0.5;

/**
 * ATR-based stop-loss distance as a fraction of the option premium. The index ATR is first
 * converted to premium points (× ATM delta) — comparing index-ATR% with premium% always hit
 * the floor, so the stop was a fixed 10%. Clamped to STRATEGY_SL_MIN_PCT … STRATEGY_SL_MAX_PCT.
 */
export function atrStopLossPct(optionLtp: number, underlyingAtr: number): number {
  const minPct = env.strategySlMinPct / 100;
  const maxPct = Math.max(minPct, env.strategySlMaxPct / 100);
  if (optionLtp <= 0 || underlyingAtr <= 0) return minPct;
  const premiumAtr = underlyingAtr * ATM_DELTA;
  return Math.min(maxPct, Math.max(minPct, (premiumAtr * env.strategySlAtrMultiplier) / optionLtp));
}

function atrStopLoss(optionLtp: number, underlyingAtr: number): number {
  return optionLtp * (1 - atrStopLossPct(optionLtp, underlyingAtr));
}

// ── Strategy 1: SUPERTREND ─────────────────────────────────────────────────

const supertrendStrategy: StrategyPlugin = {
  name: 'SUPERTREND',
  enabled: true,
  minCandleLength: 30, // adx() needs 28

  evaluate(ctx: StrategyContext): StrategySignal | null {
    const prices = closePrices(ctx);
    const { lastPrice, callInstrumentKey, putInstrumentKey, callLtp, putLtp, lotSize, underlying, expiryDate, timeIST, minutesToClose, atmStrike, pcr } = ctx;

    const stDirection = supertrend(ctx.candles, 10, 3.0);
    if (!stDirection) return skip(ctx, this.name, 'supertrend not ready');

    const { adx: adxVal, trending } = adx(prices, 14);
    if (!trending) return skip(ctx, this.name, `ADX ${adxVal.toFixed(0)} < 20 (choppy)`);

    const rsi14 = rsi(prices, 14);
    const ema9Val = ema(prices, 9);
    const ema21Val = ema(prices, 21);
    const vwapVal = sessionVwap(ctx);

    const bullish = stDirection === 'BULLISH';
    const bearish = stDirection === 'BEARISH';

    if (bullish && ema9Val < ema21Val) return skip(ctx, this.name, 'supertrend BULLISH but EMA9 < EMA21');
    if (bearish && ema9Val > ema21Val) return skip(ctx, this.name, 'supertrend BEARISH but EMA9 > EMA21');
    // A strong trend (ADX ≥ 25) runs at high RSI for long stretches — only block real blow-offs there
    const rsiCap = adxVal >= 25 ? 82 : 75;
    if (bullish && rsi14 > rsiCap) return skip(ctx, this.name, `RSI ${rsi14.toFixed(0)} > ${rsiCap} (overbought)`);
    if (bearish && rsi14 < 100 - rsiCap) return skip(ctx, this.name, `RSI ${rsi14.toFixed(0)} < ${100 - rsiCap} (oversold)`);

    const optionKey = bullish ? callInstrumentKey : putInstrumentKey;
    const optionLtp = bullish ? callLtp : putLtp;
    if (!optionKey || !optionLtp || optionLtp <= 0) return skip(ctx, this.name, 'ATM option price unavailable');

    const priceAboveVwap = lastPrice > vwapVal;
    const adxBonus = Math.min(0.15, (adxVal - 20) / 200);
    const vwapBonus = (bullish && priceAboveVwap) || (!bullish && !priceAboveVwap) ? 0.07 : 0;
    const rsiBonus = bullish ? Math.max(0, (55 - rsi14) / 200) : Math.max(0, (rsi14 - 45) / 200);
    const confidence = Math.min(0.90, 0.62 + adxBonus + vwapBonus + rsiBonus);
    if (confidence < env.strategyConfidenceThreshold) return skip(ctx, this.name, `confidence ${confidence.toFixed(2)} < ${env.strategyConfidenceThreshold}`);

    const atrVal = atr(prices, 14);
    const sl = atrStopLoss(optionLtp, atrVal);
    const { macdLine, signalLine, histogram } = macd(prices);

    return {
      source: 'SUPERTREND' as StrategySource, side: 'BUY',
      symbol: `${underlying}-${bullish ? 'CE' : 'PE'}`,
      instrumentKey: optionKey, quantity: lotSize, confidence,
      rationale: `SUPERTREND ${stDirection}: ADX=${adxVal.toFixed(0)}, RSI=${rsi14.toFixed(0)}, VWAP ${priceAboveVwap ? 'above' : 'below'}(${vwapVal.toFixed(0)})`,
      entryPrice: optionLtp, suggestedStopLoss: sl,
      suggestedTarget: optionLtp * (1 + env.strategyProfitTargetPct / 100),
      metadata: {
        underlying, bullish, pcr, strike: atmStrike, expiryDate, indexLtp: lastPrice,
        supertrendDirection: stDirection, adx: adxVal,
        ema9: ema9Val, ema21: ema21Val, rsi14, vwap: vwapVal, atr: atrVal,
        macd: macdLine, macdSignal: signalLine, macdHistogram: histogram,
        timeIST, minutesToClose,
        dayHigh: ctx.dayHigh, dayLow: ctx.dayLow, prevDayClose: ctx.prevDayClose,
        atmCallOI: ctx.atmCallOi, atmPutOI: ctx.atmPutOi,
        ivPercentile: ctx.atmIv ?? 40, indiaVix: ctx.vix,
        strategyName: 'SUPERTREND',
      },
    };
  },
};

// ── Strategy 2: EMA_CROSS ──────────────────────────────────────────────────

const emaCrossStrategy: StrategyPlugin = {
  name: 'EMA_CROSS',
  enabled: true,
  minCandleLength: 25,

  evaluate(ctx: StrategyContext): StrategySignal | null {
    const prices = closePrices(ctx);
    const { lastPrice, callInstrumentKey, putInstrumentKey, callLtp, putLtp, lotSize, underlying, expiryDate, timeIST, minutesToClose, atmStrike, pcr } = ctx;

    const ema9Now = ema(prices, 9);
    const ema21Now = ema(prices, 21);
    const ema9Prev = ema(prices.slice(0, -1), 9);
    const ema21Prev = ema(prices.slice(0, -1), 21);

    const goldenCross = ema9Prev <= ema21Prev && ema9Now > ema21Now;
    const deathCross = ema9Prev >= ema21Prev && ema9Now < ema21Now;
    if (!goldenCross && !deathCross) return skip(ctx, this.name, 'no EMA9/EMA21 cross on the last candle');

    const rsi14 = rsi(prices, 14);
    if (goldenCross && rsi14 > 72) return skip(ctx, this.name, `golden cross but RSI ${rsi14.toFixed(0)} > 72`);
    if (deathCross && rsi14 < 28) return skip(ctx, this.name, `death cross but RSI ${rsi14.toFixed(0)} < 28`);

    const bullish = goldenCross;
    const optionKey = bullish ? callInstrumentKey : putInstrumentKey;
    const optionLtp = bullish ? callLtp : putLtp;
    if (!optionKey || !optionLtp || optionLtp <= 0) return skip(ctx, this.name, 'ATM option price unavailable');

    const emaDiff = Math.abs(ema9Now - ema21Now) / lastPrice;
    const confidence = Math.min(0.88, 0.58 + emaDiff * 50 + Math.abs(rsi14 - 50) * 0.004);
    if (confidence < env.strategyConfidenceThreshold) return skip(ctx, this.name, `confidence ${confidence.toFixed(2)} < ${env.strategyConfidenceThreshold}`);

    const atrVal = atr(prices, 14);
    const sl = atrStopLoss(optionLtp, atrVal);
    const { macdLine, signalLine, histogram } = macd(prices);
    const vwapVal = sessionVwap(ctx);

    return {
      source: 'EMA_CROSS' as StrategySource, side: 'BUY',
      symbol: `${underlying}-${bullish ? 'CE' : 'PE'}`,
      instrumentKey: optionKey, quantity: lotSize, confidence,
      rationale: `EMA_CROSS: ${bullish ? 'Golden' : 'Death'} cross — 9EMA(${ema9Now.toFixed(0)}) vs 21EMA(${ema21Now.toFixed(0)}), RSI=${rsi14.toFixed(0)}`,
      entryPrice: optionLtp, suggestedStopLoss: sl,
      suggestedTarget: optionLtp * (1 + env.strategyProfitTargetPct / 100),
      metadata: {
        underlying, bullish, pcr, strike: atmStrike, expiryDate, indexLtp: lastPrice,
        ema9: ema9Now, ema21: ema21Now, rsi14,
        macd: macdLine, macdSignal: signalLine, macdHistogram: histogram,
        vwap: vwapVal, atr: atrVal, timeIST, minutesToClose,
        dayHigh: ctx.dayHigh, dayLow: ctx.dayLow, prevDayClose: ctx.prevDayClose,
        atmCallOI: ctx.atmCallOi, atmPutOI: ctx.atmPutOi,
        ivPercentile: ctx.atmIv ?? 40, strategyName: 'EMA_CROSS',
      },
    };
  },
};

// ── Strategy 3: VWAP_BOUNCE ────────────────────────────────────────────────

const vwapBounceStrategy: StrategyPlugin = {
  name: 'VWAP_BOUNCE',
  enabled: true,
  minCandleLength: 15,

  evaluate(ctx: StrategyContext): StrategySignal | null {
    const prices = closePrices(ctx);
    if (!ctx.sessionCandles.length) return skip(ctx, this.name, 'no completed candle today yet (VWAP)');

    const { lastPrice, callInstrumentKey, putInstrumentKey, callLtp, putLtp, lotSize, underlying, expiryDate, timeIST, minutesToClose, atmStrike } = ctx;

    const vwapVal = sessionVwap(ctx);
    const rsi14 = rsi(prices, 14);
    const ema9Val = ema(prices, 9);
    const prev = prices[prices.length - 2] ?? lastPrice;

    const crossedAbove = prev < vwapVal && lastPrice > vwapVal;
    const crossedBelow = prev > vwapVal && lastPrice < vwapVal;
    if (!crossedAbove && !crossedBelow) {
      return skip(ctx, this.name, `no VWAP cross (price staying ${lastPrice > vwapVal ? 'above' : 'below'} VWAP ${vwapVal.toFixed(0)})`);
    }

    const bullish = crossedAbove && rsi14 < 70 && ema9Val > vwapVal;
    const bearish = crossedBelow && rsi14 > 30 && ema9Val < vwapVal;
    if (!bullish && !bearish) return skip(ctx, this.name, `VWAP cross not confirmed by RSI ${rsi14.toFixed(0)} / EMA9`);

    const optionKey = bullish ? callInstrumentKey : putInstrumentKey;
    const optionLtp = bullish ? callLtp : putLtp;
    if (!optionKey || !optionLtp || optionLtp <= 0) return skip(ctx, this.name, 'ATM option price unavailable');

    const vwapDist = Math.abs(lastPrice - vwapVal) / (vwapVal || 1);
    const proximityBonus = Math.max(0, 1 - vwapDist * 100) * 0.25;
    const rsiBonus = bullish ? Math.max(0, (60 - rsi14) / 100) * 0.1 : Math.max(0, (rsi14 - 40) / 100) * 0.1;
    const confidence = Math.min(0.85, 0.55 + proximityBonus + rsiBonus);
    if (confidence < env.strategyConfidenceThreshold) return skip(ctx, this.name, `confidence ${confidence.toFixed(2)} < ${env.strategyConfidenceThreshold}`);

    const atrVal = atr(prices, 14);
    const sl = atrStopLoss(optionLtp, atrVal);

    return {
      source: 'VWAP_BOUNCE' as StrategySource, side: 'BUY',
      symbol: `${underlying}-${bullish ? 'CE' : 'PE'}`,
      instrumentKey: optionKey, quantity: lotSize, confidence,
      rationale: `VWAP_BOUNCE: Price ${bullish ? 'crossed above' : 'rejected below'} VWAP(${vwapVal.toFixed(0)}), RSI=${rsi14.toFixed(0)}`,
      entryPrice: optionLtp, suggestedStopLoss: sl,
      suggestedTarget: optionLtp * (1 + env.strategyProfitTargetPct / 100),
      metadata: {
        underlying, bullish, pcr: ctx.pcr, strike: atmStrike, expiryDate, indexLtp: lastPrice,
        vwap: vwapVal, rsi14, ema9: ema9Val, atr: atrVal, timeIST, minutesToClose,
        dayHigh: ctx.dayHigh, dayLow: ctx.dayLow, prevDayClose: ctx.prevDayClose,
        atmCallOI: ctx.atmCallOi, atmPutOI: ctx.atmPutOi,
        ivPercentile: ctx.atmIv ?? 40, strategyName: 'VWAP_BOUNCE',
      },
    };
  },
};

// ── Strategy 4: BOLLINGER_BREAKOUT ────────────────────────────────────────

const bollingerBreakoutStrategy: StrategyPlugin = {
  name: 'BOLLINGER_BREAKOUT',
  enabled: true,
  minCandleLength: 25,

  evaluate(ctx: StrategyContext): StrategySignal | null {
    const prices = closePrices(ctx);
    const { lastPrice, callInstrumentKey, putInstrumentKey, callLtp, putLtp, lotSize, underlying, expiryDate, timeIST, minutesToClose, atmStrike, pcr } = ctx;

    const bb = bollingerBands(prices, 20, 2.0);
    const rsi14 = rsi(prices, 14);
    const ema9Val = ema(prices, 9);
    const ema21Val = ema(prices, 21);

    let bullish: boolean | null = null;
    let signalType = '';

    if (bb.percentB <= 0.05 && rsi14 < 38 && ema9Val >= ema21Val * 0.998) {
      // In a clear downtrend (EMA9 < EMA21) with wide/expanding bands, a lower-bounce CALL has
      // negative edge — only allow if it's a tight squeeze (bandwidth < 0.20%) where mean
      // reversion is structurally favoured (as confirmed by June 5 vs June 10 data).
      if (ema9Val < ema21Val && bb.bandwidth > 0.20) return skip(ctx, this.name, 'lower-band touch in a downtrend with wide bands');
      bullish = true; signalType = 'BB_LOWER_BOUNCE';
    } else if (bb.percentB >= 0.95 && rsi14 > 62 && ema9Val <= ema21Val * 1.002) {
      bullish = false; signalType = 'BB_UPPER_REVERSAL';
    }

    if (bullish === null && prices.length >= 25) {
      const prevBb = bollingerBands(prices.slice(0, -5), 20, 2.0);
      const wasSqueezed = prevBb.bandwidth < 0.8;
      const isExpanding = bb.bandwidth > prevBb.bandwidth * 1.2;
      if (wasSqueezed && isExpanding) {
        const breakDirection = lastPrice > bb.middle ? 'UP' : 'DOWN';
        if (breakDirection === 'UP' && rsi14 < 72) { bullish = true; signalType = 'BB_SQUEEZE_BREAKOUT_UP'; }
        else if (breakDirection === 'DOWN' && rsi14 > 28) { bullish = false; signalType = 'BB_SQUEEZE_BREAKOUT_DOWN'; }
      }
    }

    if (bullish === null) return skip(ctx, this.name, `no band setup (%B ${(bb.percentB * 100).toFixed(0)}%, bandwidth ${bb.bandwidth.toFixed(2)}%)`);

    const optionKey = bullish ? callInstrumentKey : putInstrumentKey;
    const optionLtp = bullish ? callLtp : putLtp;
    if (!optionKey || !optionLtp || optionLtp <= 0) return skip(ctx, this.name, 'ATM option price unavailable');

    const extremeBonus = signalType.includes('BOUNCE') || signalType.includes('REVERSAL')
      ? Math.min(0.15, (bullish ? (0.05 - bb.percentB) : (bb.percentB - 0.95)) * 5) : 0.05;
    const rsiBonus = bullish ? Math.max(0, (38 - rsi14) / 200) : Math.max(0, (rsi14 - 62) / 200);
    const confidence = Math.min(0.87, 0.57 + extremeBonus + rsiBonus);
    if (confidence < env.strategyConfidenceThreshold) return skip(ctx, this.name, `${signalType} confidence ${confidence.toFixed(2)} < ${env.strategyConfidenceThreshold}`);

    const atrVal = atr(prices, 14);
    const sl = atrStopLoss(optionLtp, atrVal);

    return {
      source: 'BOLLINGER_BREAKOUT' as StrategySource, side: 'BUY',
      symbol: `${underlying}-${bullish ? 'CE' : 'PE'}`,
      instrumentKey: optionKey, quantity: lotSize, confidence,
      rationale: `BB ${signalType}: price %B=${(bb.percentB * 100).toFixed(0)}%, bandwidth=${bb.bandwidth.toFixed(2)}%, RSI=${rsi14.toFixed(0)}`,
      entryPrice: optionLtp, suggestedStopLoss: sl,
      suggestedTarget: optionLtp * (1 + env.strategyProfitTargetPct / 100),
      metadata: {
        underlying, bullish, pcr, strike: atmStrike, expiryDate, indexLtp: lastPrice,
        bbUpper: bb.upper, bbMiddle: bb.middle, bbLower: bb.lower,
        bbBandwidth: bb.bandwidth, bbPercentB: bb.percentB, signalType,
        rsi14, ema9: ema9Val, ema21: ema21Val, atr: atrVal, timeIST, minutesToClose,
        dayHigh: ctx.dayHigh, dayLow: ctx.dayLow, prevDayClose: ctx.prevDayClose,
        atmCallOI: ctx.atmCallOi, atmPutOI: ctx.atmPutOi,
        ivPercentile: ctx.atmIv ?? 40, strategyName: 'BOLLINGER_BREAKOUT',
      },
    };
  },
};

// ── Strategy 5: STOCHASTIC_MOMENTUM ───────────────────────────────────────

const stochasticMomentumStrategy: StrategyPlugin = {
  name: 'STOCHASTIC_MOMENTUM',
  enabled: true,
  minCandleLength: 35, // MACD needs 35

  evaluate(ctx: StrategyContext): StrategySignal | null {
    const prices = closePrices(ctx);
    const { lastPrice, callInstrumentKey, putInstrumentKey, callLtp, putLtp, lotSize, underlying, expiryDate, timeIST, minutesToClose, atmStrike, pcr } = ctx;

    const curr = stochastic(prices, 14, 3);
    const prev = stochastic(prices.slice(0, -1), 14, 3);

    // Require %K >= 5 (bullish) / <= 95 (bearish) — a cross at single-digit values is noise
    const bullishCross = prev.k < prev.d && curr.k > curr.d && curr.k < 30 && curr.d < 30 && curr.k >= 5;
    const bearishCross = prev.k > prev.d && curr.k < curr.d && curr.k > 70 && curr.d > 70 && curr.k <= 95;
    if (!bullishCross && !bearishCross) return skip(ctx, this.name, `no %K/%D cross in an extreme zone (%K ${curr.k.toFixed(0)})`);

    const { macdLine, signalLine, histogram } = macd(prices);
    const prevMacd = macd(prices.slice(0, -1));
    if (bullishCross && histogram < prevMacd.histogram) return skip(ctx, this.name, 'bullish stochastic cross but MACD histogram falling');
    if (bearishCross && histogram > prevMacd.histogram) return skip(ctx, this.name, 'bearish stochastic cross but MACD histogram rising');

    const ema9Val = ema(prices, 9);
    const ema21Val = ema(prices, 21);
    if (bullishCross && ema9Val < ema21Val * 0.995) return skip(ctx, this.name, 'bullish stochastic cross against EMA downtrend');
    if (bearishCross && ema9Val > ema21Val * 1.005) return skip(ctx, this.name, 'bearish stochastic cross against EMA uptrend');

    const bullish = bullishCross;
    const optionKey = bullish ? callInstrumentKey : putInstrumentKey;
    const optionLtp = bullish ? callLtp : putLtp;
    if (!optionKey || !optionLtp || optionLtp <= 0) return skip(ctx, this.name, 'ATM option price unavailable');

    const extremeDepth = bullish ? Math.max(0, 20 - curr.k) / 100 : Math.max(0, curr.k - 80) / 100;
    const macdBonus = bullish ? Math.min(0.08, Math.max(0, histogram) * 10) : Math.min(0.08, Math.max(0, -histogram) * 10);
    const confidence = Math.min(0.86, 0.60 + extremeDepth + macdBonus);
    if (confidence < env.strategyConfidenceThreshold) return skip(ctx, this.name, `confidence ${confidence.toFixed(2)} < ${env.strategyConfidenceThreshold}`);

    const atrVal = atr(prices, 14);
    const sl = atrStopLoss(optionLtp, atrVal);
    const vwapVal = sessionVwap(ctx);

    return {
      source: 'STOCHASTIC_MOMENTUM' as StrategySource, side: 'BUY',
      symbol: `${underlying}-${bullish ? 'CE' : 'PE'}`,
      instrumentKey: optionKey, quantity: lotSize, confidence,
      rationale: `STOCH ${bullish ? 'BULLISH' : 'BEARISH'} cross: %K=${curr.k.toFixed(0)}, %D=${curr.d.toFixed(0)}, MACD hist=${histogram.toFixed(2)}`,
      entryPrice: optionLtp, suggestedStopLoss: sl,
      suggestedTarget: optionLtp * (1 + env.strategyProfitTargetPct / 100),
      metadata: {
        underlying, bullish, pcr, strike: atmStrike, expiryDate, indexLtp: lastPrice,
        stochK: curr.k, stochD: curr.d, macd: macdLine, macdSignal: signalLine, macdHistogram: histogram,
        ema9: ema9Val, ema21: ema21Val, atr: atrVal, vwap: vwapVal, timeIST, minutesToClose,
        dayHigh: ctx.dayHigh, dayLow: ctx.dayLow, prevDayClose: ctx.prevDayClose,
        atmCallOI: ctx.atmCallOi, atmPutOI: ctx.atmPutOi,
        ivPercentile: ctx.atmIv ?? 40, strategyName: 'STOCHASTIC_MOMENTUM',
      },
    };
  },
};

// ── Strategy 6: SMA_PCR ───────────────────────────────────────────────────

const smaPcrStrategy: StrategyPlugin = {
  name: 'SMA_PCR',
  enabled: true,
  minCandleLength: 40,

  evaluate(ctx: StrategyContext): StrategySignal | null {
    const prices = closePrices(ctx);
    const { lastPrice, pcr, callInstrumentKey, putInstrumentKey, callLtp, putLtp, lotSize, underlying, expiryDate, timeIST, minutesToClose, atmStrike } = ctx;

    const smaFast = avg(prices.slice(-10));
    const smaSlow = avg(prices.slice(-30));
    const momentum = (lastPrice - prices[prices.length - 20]) / prices[prices.length - 20];

    const bullish = smaFast > smaSlow && momentum > 0 && pcr >= 1;
    const bearish = smaFast < smaSlow && momentum < 0 && pcr <= 1;
    if (!bullish && !bearish) return skip(ctx, this.name, `SMA10/30, momentum and PCR ${pcr.toFixed(2)} not aligned`);

    const optionKey = bullish ? callInstrumentKey : putInstrumentKey;
    const optionLtp = bullish ? callLtp : putLtp;
    if (!optionKey || !optionLtp || optionLtp <= 0) return skip(ctx, this.name, 'ATM option price unavailable');

    const confidence = Math.min(0.99,
      0.5 + Math.abs((smaFast - smaSlow) / lastPrice) * 8
          + Math.abs(pcr - 1) * 0.18
          + Math.abs(momentum) * 4,
    );
    if (confidence < env.strategyConfidenceThreshold) return skip(ctx, this.name, `confidence ${confidence.toFixed(2)} < ${env.strategyConfidenceThreshold}`);

    const rsi14 = rsi(prices, 14);
    const ema9 = ema(prices, 9);
    const ema21 = ema(prices, 21);
    const vwapVal = sessionVwap(ctx);
    const { macdLine, signalLine, histogram } = macd(prices);
    const atrVal = atr(prices, 14);
    const sl = atrStopLoss(optionLtp, atrVal);
    const target = optionLtp * (1 + env.strategyProfitTargetPct / 100);

    return {
      source: 'SMA_PCR' as StrategySource, side: 'BUY',
      symbol: `${underlying}-${bullish ? 'CE' : 'PE'}`,
      instrumentKey: optionKey, quantity: lotSize, confidence,
      rationale: `SMA_PCR: fast(${smaFast.toFixed(0)}) ${bullish ? '>' : '<'} slow(${smaSlow.toFixed(0)}), Mom=${(momentum * 100).toFixed(2)}%, PCR=${pcr.toFixed(2)}, RSI=${rsi14.toFixed(0)}, ${lastPrice > vwapVal ? 'above' : 'below'} VWAP`,
      entryPrice: optionLtp, suggestedStopLoss: sl, suggestedTarget: target,
      metadata: {
        underlying, bullish, pcr, smaFast, smaSlow, momentum, strike: atmStrike, expiryDate, indexLtp: lastPrice,
        rsi14, ema9, ema21, macd: macdLine, macdSignal: signalLine, macdHistogram: histogram,
        vwap: vwapVal, atr: atrVal, volumeRatio: 1, timeIST, minutesToClose,
        atmCallOI: ctx.atmCallOi, atmPutOI: ctx.atmPutOi,
        ivPercentile: ctx.atmIv ?? 40,
        dayHigh: ctx.dayHigh, dayLow: ctx.dayLow, prevDayClose: ctx.prevDayClose,
        strategyName: 'SMA_PCR',
      },
    };
  },
};

// ── Registry ───────────────────────────────────────────────────────────────

class StrategyRegistry {
  private plugins: StrategyPlugin[] = [];

  constructor() {
    this.register(supertrendStrategy);
    this.register(emaCrossStrategy);
    this.register(vwapBounceStrategy);
    this.register(bollingerBreakoutStrategy);
    this.register(stochasticMomentumStrategy);
    this.register(smaPcrStrategy);
  }

  register(plugin: StrategyPlugin): void { this.plugins.push(plugin); }

  /** Best signal by confidence, or null. */
  runAll(ctx: StrategyContext): { signal: StrategySignal; strategyName: string } | null {
    return this.evaluateAll(ctx)[0] ?? null;
  }

  /** Every plugin's signal, highest confidence first (plugins that returned null are in ctx.diagnostics). */
  evaluateAll(ctx: StrategyContext): { signal: StrategySignal; strategyName: string }[] {
    const candidates: { signal: StrategySignal; strategyName: string }[] = [];

    for (const plugin of this.plugins) {
      if (!plugin.enabled) continue;
      if (ctx.candles.length < plugin.minCandleLength) {
        skip(ctx, plugin.name, `warming up: ${ctx.candles.length}/${plugin.minCandleLength} candles`);
        continue;
      }

      try {
        const signal = plugin.evaluate(ctx);
        if (signal) candidates.push({ signal, strategyName: plugin.name });
      } catch (err) {
        process.stderr.write(`[StrategyRegistry] ${plugin.name} threw: ${String(err)}\n`);
      }
    }

    return candidates.sort((a, b) => b.signal.confidence - a.signal.confidence);
  }

  getEnabled(): string[] { return this.plugins.filter((p) => p.enabled).map((p) => p.name); }

  listNames(): string[] { return this.plugins.map((p) => p.name); }

  setEnabled(name: string, enabled: boolean): boolean {
    const plugin = this.plugins.find((p) => p.name === name);
    if (!plugin) return false;
    plugin.enabled = enabled;
    return true;
  }
}

export const strategyRegistry = new StrategyRegistry();
