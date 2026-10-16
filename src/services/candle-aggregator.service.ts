/**
 * candle-aggregator.service.ts
 *
 * Aggregates 5-second raw market_ticks into 5-minute OHLCV candles.
 *
 * Why this matters:
 *   All technical indicators (RSI, MACD, EMA, Supertrend, Bollinger Bands)
 *   are designed for candle-level data. Running them on 5-second ticks
 *   produces meaningless values (e.g., RSI(14) on 70 seconds of data).
 *   This service fixes the root data-quality problem.
 *
 * How it works:
 *   - Every 5 minutes (triggered by market-data.service after each poll batch)
 *   - Collects all ticks from the most recently COMPLETED 5-minute window
 *   - Computes open/high/low/close from LTP values
 *   - Extracts dayHigh, dayLow, prevClose from rawPayload.ohlc (Upstox full-quote)
 *   - Extracts volume from rawPayload.volume if available
 *   - Upserts the candle (idempotent — safe to call multiple times per window)
 *
 * 5-minute window boundary (IST):
 *   09:15, 09:20, 09:25 ... 15:25, 15:30
 *   e.g. ticks at 09:18:04 and 09:19:55 → candleStart = 09:15 IST
 */

import { Op } from 'sequelize';
import { Candle } from '../models/candle.model';
import { MarketTick } from '../models/market-tick.model';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

/** Floor a UTC Date to the nearest 5-min IST window boundary, returned as UTC. */
function floor5MinIst(date: Date): Date {
  const istMs = date.getTime() + IST_OFFSET_MS;
  const istDate = new Date(istMs);
  const floored = new Date(istDate);
  floored.setUTCMinutes(Math.floor(istDate.getUTCMinutes() / 5) * 5, 0, 0);
  return new Date(floored.getTime() - IST_OFFSET_MS);
}

/** Returns today's session start (9:15 AM IST) as a UTC Date. */
export function sessionStart(): Date {
  const now = new Date();
  const istMs = now.getTime() + IST_OFFSET_MS;
  const istDate = new Date(istMs);
  const sessionIst = new Date(istDate);
  // istDate's UTC fields hold IST wall-clock time, so 09:15 here means 09:15 IST
  sessionIst.setUTCHours(9, 15, 0, 0);
  if (istDate.getUTCHours() < 9 || (istDate.getUTCHours() === 9 && istDate.getUTCMinutes() < 15)) {
    sessionIst.setUTCDate(sessionIst.getUTCDate() - 1);
  }
  return new Date(sessionIst.getTime() - IST_OFFSET_MS);
}

const toNumber = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

class CandleAggregatorService {
  private lastAggregatedWindow: Map<string, Date> = new Map();

  /**
   * Aggregate all pending 5-min windows that are now complete.
   * Call this after each market data poll.
   */
  async aggregatePendingWindows(): Promise<void> {
    const now = new Date();
    const currentWindow = floor5MinIst(now);

    // Collect all distinct instrument_keys that have ticks since session start
    const sessionFrom = sessionStart();
    const distinctInstruments = await MarketTick.findAll({
      attributes: ['instrumentKey', 'symbol'],
      where: { sourceTimestamp: { [Op.gte]: sessionFrom } },
      group: ['instrument_key', 'symbol'],
      raw: true,
    }) as unknown as { instrumentKey: string; symbol: string }[];

    for (const { instrumentKey, symbol } of distinctInstruments) {
      await this.aggregateForInstrument(instrumentKey, symbol, currentWindow, sessionFrom);
    }
  }

  private async aggregateForInstrument(
    instrumentKey: string,
    symbol: string,
    currentWindow: Date,
    sessionFrom: Date,
  ): Promise<void> {
    const lastDone = this.lastAggregatedWindow.get(instrumentKey) ?? sessionFrom;

    // Walk each 5-min window from lastDone up to (but not including) currentWindow
    let windowStart = floor5MinIst(new Date(lastDone.getTime() + 1));

    while (windowStart < currentWindow) {
      const windowEnd = new Date(windowStart.getTime() + 5 * 60 * 1000);

      await this.buildCandle(instrumentKey, symbol, windowStart, windowEnd);

      this.lastAggregatedWindow.set(instrumentKey, windowStart);
      windowStart = new Date(windowStart.getTime() + 5 * 60 * 1000);
    }
  }

  private async buildCandle(
    instrumentKey: string,
    symbol: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<void> {
    const ticks = await MarketTick.findAll({
      where: {
        instrumentKey,
        sourceTimestamp: {
          [Op.gte]: windowStart,
          [Op.lt]: windowEnd,
        },
      },
      order: [['sourceTimestamp', 'ASC']],
    });

    if (ticks.length === 0) return;

    const prices = ticks.map((t) => Number(t.ltp));
    const open = prices[0];
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const close = prices[prices.length - 1];

    // Extract richer data from rawPayload (available after switch to full-quote endpoint)
    const lastPayload = asRecord(ticks[ticks.length - 1].rawPayload);
    const ohlc = asRecord(lastPayload.ohlc);

    const dayHigh = toNumber(ohlc.high ?? lastPayload.day_high);
    const dayLow = toNumber(ohlc.low ?? lastPayload.day_low);
    const prevClose = toNumber(ohlc.close ?? lastPayload.prev_close ?? lastPayload.close);

    // Volume: sum of all tick volumes (if available in payload)
    let totalVolume: number | null = null;
    for (const tick of ticks) {
      const p = asRecord(tick.rawPayload);
      const v = toNumber(p.volume ?? p.total_buy_quantity);
      if (v !== null) {
        totalVolume = (totalVolume ?? 0) + v;
      }
    }

    // VIX from payload (if fetched alongside Nifty)
    const vix = toNumber(lastPayload.vix ?? lastPayload.india_vix);

    // Upsert so re-runs are idempotent
    const existing = await Candle.findOne({
      where: { instrumentKey, candleStart: windowStart },
    });

    if (existing) {
      existing.open = open;
      existing.high = Math.max(existing.high, high);
      existing.low = Math.min(existing.low, low);
      existing.close = close;
      if (totalVolume !== null) existing.volume = totalVolume;
      existing.tickCount = ticks.length;
      if (dayHigh !== null) existing.dayHigh = dayHigh;
      if (dayLow !== null) existing.dayLow = dayLow;
      if (prevClose !== null) existing.prevClose = prevClose;
      if (vix !== null) existing.vix = vix;
      await existing.save();
    } else {
      await Candle.create({
        symbol,
        instrumentKey,
        candleStart: windowStart,
        open,
        high,
        low,
        close,
        volume: totalVolume,
        tickCount: ticks.length,
        dayHigh,
        dayLow,
        prevClose,
        vix,
      });
    }
  }

  /** Force immediate aggregation of the current (incomplete) candle. */
  async aggregateCurrentWindow(instrumentKey: string, symbol: string): Promise<void> {
    const now = new Date();
    const windowStart = floor5MinIst(now);
    const windowEnd = now;
    await this.buildCandle(instrumentKey, symbol, windowStart, windowEnd);
  }
}

export const candleAggregator = new CandleAggregatorService();
export { floor5MinIst };
