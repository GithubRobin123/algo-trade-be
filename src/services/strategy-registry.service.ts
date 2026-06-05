/**
 * strategy-registry.service.ts
 *
 * Pluggable strategy registry. Each strategy implements the StrategyPlugin
 * interface and registers itself here.
 *
 * KEY FIX: All indicators now run on 5-minute candle closes (via ctx.candles[]).
 * If candles are unavailable (early in the session), falls back to ctx.prices[]
 * which are now session-only ticks (9:15 AM IST onwards).
 *
 * Additional fixes in this revision:
 *   - VWAP = session-only typical-price average (resets at 9:15 AM)
 *   - Stateful Supertrend: band state cached between calls
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

import { Candle } from '../models/candle.model';
import { env } from '../config/env';
import { StrategySignal, StrategySource } from '../types/trading.types';

// ── Plugin interface ───────────────────────────────────────────────────────

export interface StrategyContext {
  underlying: string;
  prices: number[];          // session-only LTP ticks, oldest first (fallback)
  candles: Candle[];         // 5-min OHLCV candles, oldest first (primary)
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
  minCandleLength: number;   // minimum 5-min candles needed
  minTickLength: number;     // fallback minimum ticks if candles unavailable
  evaluate(ctx: StrategyContext): StrategySignal | null;
}

// ── Candle helpers ─────────────────────────────────────────────────────────

/** Extract close prices from candles (primary) or raw ticks (fallback). */
function closePrices(ctx: StrategyContext): number[] {
  if (ctx.candles.length >= 5) {
    return ctx.candles.map((c) => Number(c.close));
  }
  return ctx.prices;
}

/** Session VWAP using candles (typical price = (H+L+C)/3). Resets at 9:15 AM IST. */
function sessionVwap(ctx: StrategyContext): number {
  if (ctx.candles.length >= 2) {
    let sumTP = 0, count = 0;
    for (const c of ctx.candles) {
      sumTP += (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
      count++;
    }
    return sumTP / count;
  }
  // Fallback: session-tick average (already date-filtered)
  if (ctx.prices.length > 0) {
    return ctx.prices.reduce((s, v) => s + v, 0) / ctx.prices.length;
  }
  return ctx.lastPrice;
}

// ── Stateful Supertrend band cache ─────────────────────────────────────────
// Maps instrumentKey → {upperBand, lowerBand, direction}
// Prevents direction oscillation between calls (key property of real Supertrend).
interface SupertrendState { upperBand: number; lowerBand: number; direction: 'BULLISH' | 'BEARISH' }
const supertrendStateCache = new Map<string, SupertrendState>();

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

export function adx(prices: number[], period = 14): { adx: number; trending: boolean } {
  if (prices.length < period * 2) return { adx: 0, trending: false };
  const dmPlus: number[] = [], dmMinus: number[] = [], trValues: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    dmPlus.push(diff > 0 ? diff : 0);
    dmMinus.push(diff < 0 ? Math.abs(diff) : 0);
    trValues.push(Math.abs(diff));
  }
  const smooth = (arr: number[]): number => {
    let rma = avg(arr.slice(0, period));
    for (let i = period; i < arr.length; i++) rma = (rma * (period - 1) + arr[i]) / period;
    return rma;
  };
  const atrVal = smooth(trValues);
  if (atrVal === 0) return { adx: 0, trending: false };
  const diPlus = (smooth(dmPlus) / atrVal) * 100;
  const diMinus = (smooth(dmMinus) / atrVal) * 100;
  const dxVal = diPlus + diMinus > 0 ? (Math.abs(diPlus - diMinus) / (diPlus + diMinus)) * 100 : 0;
  const dx: number[] = [];
  const halfLen = Math.floor(prices.length / 2);
  for (let w = period; w <= halfLen; w++) {
    const s = prices.slice(w - period, w + period);
    const dm1: number[] = [], dm2: number[] = [], tr1: number[] = [];
    for (let i = 1; i < s.length; i++) {
      const d = s[i] - s[i - 1];
      dm1.push(d > 0 ? d : 0); dm2.push(d < 0 ? Math.abs(d) : 0); tr1.push(Math.abs(d));
    }
    const atrW = smooth(tr1);
    if (atrW === 0) continue;
    const dp = (smooth(dm1) / atrW) * 100;
    const dn = (smooth(dm2) / atrW) * 100;
    dx.push(dp + dn > 0 ? (Math.abs(dp - dn) / (dp + dn)) * 100 : 0);
  }
  const adxVal = dx.length > 0 ? avg(dx.slice(-period)) : dxVal;
  return { adx: Math.min(100, adxVal), trending: adxVal > 20 };
}

/**
 * Stateful Supertrend — uses module-level cache to prevent direction oscillation.
 * @param cacheKey  unique key per instrument (e.g., instrumentKey)
 */
export function supertrend(
  prices: number[],
  period = 10,
  multiplier = 3.0,
  cacheKey = 'default',
): 'BULLISH' | 'BEARISH' | null {
  if (prices.length < period * 2 + 2) return null;

  const atrValue = atr(prices, period);
  if (atrValue === 0) return null;

  const computeBands = (slice: number[]): { upper: number; lower: number } => {
    const h = Math.max(...slice.slice(-period));
    const l = Math.min(...slice.slice(-period));
    const mid = (h + l) / 2;
    return { upper: mid + multiplier * atrValue, lower: mid - multiplier * atrValue };
  };

  const currBands = computeBands(prices);
  const currPrice = prices[prices.length - 1];

  const prev = supertrendStateCache.get(cacheKey);

  let direction: 'BULLISH' | 'BEARISH';

  if (!prev) {
    // No prior state: derive from current price vs bands
    direction = currPrice > currBands.upper ? 'BULLISH' : currPrice < currBands.lower ? 'BEARISH' : (ema(prices, 9) > ema(prices, 21) ? 'BULLISH' : 'BEARISH');
  } else {
    // Stateful: only flip direction when price crosses the band from the PREVIOUS state
    if (prev.direction === 'BULLISH' && currPrice < currBands.lower) {
      direction = 'BEARISH';
    } else if (prev.direction === 'BEARISH' && currPrice > currBands.upper) {
      direction = 'BULLISH';
    } else {
      direction = prev.direction; // sustain until confirmed breakout
    }
  }

  supertrendStateCache.set(cacheKey, { upperBand: currBands.upper, lowerBand: currBands.lower, direction });
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

/** ATR-based dynamic stop loss. Clamps SL between 10% and 30% of entry premium. */
function atrStopLoss(optionLtp: number, underlyingAtr: number, lastPrice: number): number {
  const atrPct = lastPrice > 0 ? underlyingAtr / lastPrice : 0;
  const slPct = Math.min(0.30, Math.max(0.10, atrPct * 2.5));
  return optionLtp * (1 - slPct);
}

// ── Strategy 1: SUPERTREND ─────────────────────────────────────────────────

const supertrendStrategy: StrategyPlugin = {
  name: 'SUPERTREND',
  enabled: true,
  minCandleLength: 25,
  minTickLength: 50,

  evaluate(ctx: StrategyContext): StrategySignal | null {
    const prices = closePrices(ctx);
    if (prices.length < this.minTickLength && ctx.candles.length < this.minCandleLength) return null;

    const { lastPrice, callInstrumentKey, putInstrumentKey, callLtp, putLtp, lotSize, underlying, expiryDate, timeIST, minutesToClose, atmStrike, pcr } = ctx;

    const stDirection = supertrend(prices, 10, 3.0, ctx.underlying + '_ST');
    if (!stDirection) return null;

    const { adx: adxVal, trending } = adx(prices, 14);
    if (!trending) return null; // ADX < 20: choppy — skip

    const rsi14 = rsi(prices, 14);
    const ema9Val = ema(prices, 9);
    const ema21Val = ema(prices, 21);
    const vwapVal = sessionVwap(ctx);

    const bullish = stDirection === 'BULLISH';
    const bearish = stDirection === 'BEARISH';

    if (bullish && ema9Val < ema21Val) return null; // EMA disagrees
    if (bearish && ema9Val > ema21Val) return null;
    if (bullish && rsi14 > 75) return null;          // overbought
    if (bearish && rsi14 < 25) return null;           // oversold

    const optionKey = bullish ? callInstrumentKey : putInstrumentKey;
    const optionLtp = bullish ? callLtp : putLtp;
    if (!optionKey || !optionLtp || optionLtp <= 0) return null;

    const priceAboveVwap = lastPrice > vwapVal;
    const adxBonus = Math.min(0.15, (adxVal - 20) / 200);
    const vwapBonus = (bullish && priceAboveVwap) || (!bullish && !priceAboveVwap) ? 0.07 : 0;
    const rsiBonus = bullish ? Math.max(0, (55 - rsi14) / 200) : Math.max(0, (rsi14 - 45) / 200);
    const confidence = Math.min(0.90, 0.62 + adxBonus + vwapBonus + rsiBonus);
    if (confidence < env.strategyConfidenceThreshold) return null;

    const atrVal = atr(prices, 14);
    const sl = atrStopLoss(optionLtp, atrVal, lastPrice);
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
  minTickLength: 50,

  evaluate(ctx: StrategyContext): StrategySignal | null {
    const prices = closePrices(ctx);
    if (prices.length < 22) return null;

    const { lastPrice, callInstrumentKey, putInstrumentKey, callLtp, putLtp, lotSize, underlying, expiryDate, timeIST, minutesToClose, atmStrike, pcr } = ctx;

    const ema9Now = ema(prices, 9);
    const ema21Now = ema(prices, 21);
    const ema9Prev = ema(prices.slice(0, -1), 9);
    const ema21Prev = ema(prices.slice(0, -1), 21);

    const goldenCross = ema9Prev <= ema21Prev && ema9Now > ema21Now;
    const deathCross = ema9Prev >= ema21Prev && ema9Now < ema21Now;
    if (!goldenCross && !deathCross) return null;

    const rsi14 = rsi(prices, 14);
    if (goldenCross && rsi14 > 72) return null;
    if (deathCross && rsi14 < 28) return null;

    const bullish = goldenCross;
    const optionKey = bullish ? callInstrumentKey : putInstrumentKey;
    const optionLtp = bullish ? callLtp : putLtp;
    if (!optionKey || !optionLtp || optionLtp <= 0) return null;

    const emaDiff = Math.abs(ema9Now - ema21Now) / lastPrice;
    const confidence = Math.min(0.88, 0.58 + emaDiff * 50 + Math.abs(rsi14 - 50) * 0.004);
    if (confidence < env.strategyConfidenceThreshold) return null;

    const atrVal = atr(prices, 14);
    const sl = atrStopLoss(optionLtp, atrVal, lastPrice);
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
  minCandleLength: 10,
  minTickLength: 20,

  evaluate(ctx: StrategyContext): StrategySignal | null {
    const prices = closePrices(ctx);
    if (prices.length < 5) return null;

    const { lastPrice, callInstrumentKey, putInstrumentKey, callLtp, putLtp, lotSize, underlying, expiryDate, timeIST, minutesToClose, atmStrike } = ctx;

    const vwapVal = sessionVwap(ctx);
    const rsi14 = rsi(prices, 14);
    const ema9Val = ema(prices, 9);
    const prev = prices[prices.length - 2] ?? lastPrice;

    const crossedAbove = prev < vwapVal && lastPrice > vwapVal;
    const crossedBelow = prev > vwapVal && lastPrice < vwapVal;
    if (!crossedAbove && !crossedBelow) return null;

    const bullish = crossedAbove && rsi14 < 70 && ema9Val > vwapVal;
    const bearish = crossedBelow && rsi14 > 30 && ema9Val < vwapVal;
    if (!bullish && !bearish) return null;

    const optionKey = bullish ? callInstrumentKey : putInstrumentKey;
    const optionLtp = bullish ? callLtp : putLtp;
    if (!optionKey || !optionLtp || optionLtp <= 0) return null;

    const vwapDist = Math.abs(lastPrice - vwapVal) / (vwapVal || 1);
    const proximityBonus = Math.max(0, 1 - vwapDist * 100) * 0.25;
    const rsiBonus = bullish ? Math.max(0, (60 - rsi14) / 100) * 0.1 : Math.max(0, (rsi14 - 40) / 100) * 0.1;
    const confidence = Math.min(0.85, 0.55 + proximityBonus + rsiBonus);
    if (confidence < env.strategyConfidenceThreshold) return null;

    const atrVal = atr(prices, 14);
    const sl = atrStopLoss(optionLtp, atrVal, lastPrice);

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
  minCandleLength: 20,
  minTickLength: 40,

  evaluate(ctx: StrategyContext): StrategySignal | null {
    const prices = closePrices(ctx);
    if (prices.length < 20) return null;

    const { lastPrice, callInstrumentKey, putInstrumentKey, callLtp, putLtp, lotSize, underlying, expiryDate, timeIST, minutesToClose, atmStrike, pcr } = ctx;

    const bb = bollingerBands(prices, 20, 2.0);
    const rsi14 = rsi(prices, 14);
    const ema9Val = ema(prices, 9);
    const ema21Val = ema(prices, 21);

    let bullish: boolean | null = null;
    let signalType = '';

    if (bb.percentB <= 0.05 && rsi14 < 38 && ema9Val >= ema21Val * 0.998) {
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

    if (bullish === null) return null;

    const optionKey = bullish ? callInstrumentKey : putInstrumentKey;
    const optionLtp = bullish ? callLtp : putLtp;
    if (!optionKey || !optionLtp || optionLtp <= 0) return null;

    const extremeBonus = signalType.includes('BOUNCE') || signalType.includes('REVERSAL')
      ? Math.min(0.15, (bullish ? (0.05 - bb.percentB) : (bb.percentB - 0.95)) * 5) : 0.05;
    const rsiBonus = bullish ? Math.max(0, (38 - rsi14) / 200) : Math.max(0, (rsi14 - 62) / 200);
    const confidence = Math.min(0.87, 0.57 + extremeBonus + rsiBonus);
    if (confidence < env.strategyConfidenceThreshold) return null;

    const atrVal = atr(prices, 14);
    const sl = atrStopLoss(optionLtp, atrVal, lastPrice);

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
  minCandleLength: 20,
  minTickLength: 40,

  evaluate(ctx: StrategyContext): StrategySignal | null {
    const prices = closePrices(ctx);
    if (prices.length < 20) return null;

    const { lastPrice, callInstrumentKey, putInstrumentKey, callLtp, putLtp, lotSize, underlying, expiryDate, timeIST, minutesToClose, atmStrike, pcr } = ctx;

    const curr = stochastic(prices, 14, 3);
    const prev = stochastic(prices.slice(0, -1), 14, 3);

    const bullishCross = prev.k < prev.d && curr.k > curr.d && curr.k < 30 && curr.d < 30;
    const bearishCross = prev.k > prev.d && curr.k < curr.d && curr.k > 70 && curr.d > 70;
    if (!bullishCross && !bearishCross) return null;

    const { macdLine, signalLine, histogram } = macd(prices);
    const prevMacd = macd(prices.slice(0, -1));
    if (bullishCross && histogram < prevMacd.histogram) return null;
    if (bearishCross && histogram > prevMacd.histogram) return null;

    const ema9Val = ema(prices, 9);
    const ema21Val = ema(prices, 21);
    if (bullishCross && ema9Val < ema21Val * 0.995) return null;
    if (bearishCross && ema9Val > ema21Val * 1.005) return null;

    const bullish = bullishCross;
    const optionKey = bullish ? callInstrumentKey : putInstrumentKey;
    const optionLtp = bullish ? callLtp : putLtp;
    if (!optionKey || !optionLtp || optionLtp <= 0) return null;

    const extremeDepth = bullish ? Math.max(0, 20 - curr.k) / 100 : Math.max(0, curr.k - 80) / 100;
    const macdBonus = bullish ? Math.min(0.08, Math.max(0, histogram) * 10) : Math.min(0.08, Math.max(0, -histogram) * 10);
    const confidence = Math.min(0.86, 0.60 + extremeDepth + macdBonus);
    if (confidence < env.strategyConfidenceThreshold) return null;

    const atrVal = atr(prices, 14);
    const sl = atrStopLoss(optionLtp, atrVal, lastPrice);
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
  minCandleLength: 30,
  minTickLength: 60,

  evaluate(ctx: StrategyContext): StrategySignal | null {
    const prices = closePrices(ctx);
    if (prices.length < 40) return null;

    const { lastPrice, pcr, callInstrumentKey, putInstrumentKey, callLtp, putLtp, lotSize, underlying, expiryDate, timeIST, minutesToClose, atmStrike } = ctx;

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
    const vwapVal = sessionVwap(ctx);
    const { macdLine, signalLine, histogram } = macd(prices);
    const atrVal = atr(prices, 14);
    const sl = atrStopLoss(optionLtp, atrVal, lastPrice);
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

  runAll(ctx: StrategyContext): { signal: StrategySignal; strategyName: string } | null {
    const candidates: { signal: StrategySignal; strategyName: string }[] = [];

    for (const plugin of this.plugins) {
      if (!plugin.enabled) continue;
      const hasEnoughCandles = ctx.candles.length >= plugin.minCandleLength;
      const hasEnoughTicks = ctx.prices.length >= plugin.minTickLength;
      if (!hasEnoughCandles && !hasEnoughTicks) continue;

      try {
        const signal = plugin.evaluate(ctx);
        if (signal) candidates.push({ signal, strategyName: plugin.name });
      } catch (err) {
        process.stderr.write(`[StrategyRegistry] ${plugin.name} threw: ${String(err)}\n`);
      }
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.signal.confidence - a.signal.confidence);
    return candidates[0];
  }

  getEnabled(): string[] { return this.plugins.filter((p) => p.enabled).map((p) => p.name); }

  setEnabled(name: string, enabled: boolean): boolean {
    const plugin = this.plugins.find((p) => p.name === name);
    if (!plugin) return false;
    plugin.enabled = enabled;
    return true;
  }
}

export const strategyRegistry = new StrategyRegistry();
