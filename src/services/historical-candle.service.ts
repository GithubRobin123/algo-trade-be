/**
 * historical-candle.service.ts
 *
 * Candle series the strategies and exit checks run on: previous sessions (warm-up) + today.
 *
 * Why: indicators used to start cold every morning from today's self-built candles only, so
 * 5 of 6 strategies could not evaluate until 10:55–12:35 IST, and before 5 candles existed
 * everything ran on raw 1-second ticks (ATR ≈ 1 point, RSI 97 on noise).
 *
 *   - Previous sessions: Upstox V3 historical candles, fetched once per IST day per instrument.
 *   - Today: Upstox V3 intraday candles (refreshed at most every INTRADAY_TTL_MS) merged with our
 *     own DB candles, so a gap in our tick capture (restart, DB outage) is filled by Upstox and a
 *     window Upstox has not published yet is filled by us.
 *   - Only COMPLETED 5-minute candles are returned; the forming candle is excluded.
 *   - If Upstox is unreachable, falls back to whatever candles the DB holds.
 */

import { Op } from 'sequelize';
import { env } from '../config/env';
import { Candle } from '../models/candle.model';
import { sessionStart } from './candle-aggregator.service';
import { upstoxService } from './upstox.service';

export interface StrategyCandle {
  candleStart: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface StrategyCandleSeries {
  /** Warm-up sessions + today, oldest first (completed candles only). */
  candles: StrategyCandle[];
  /** Today's completed candles only (for VWAP, day high/low). */
  sessionCandles: StrategyCandle[];
  /** Last close of the previous session, or null if unknown. */
  prevSessionClose: number | null;
  source: 'upstox' | 'db-fallback';
}

const CANDLE_MINUTES = 5;
const CANDLE_MS = CANDLE_MINUTES * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const INTRADAY_TTL_MS = 60 * 1000;
const HISTORY_LOOKBACK_DAYS = 10; // calendar days — covers weekends and holidays
const CANDLES_PER_SESSION = 75;

const istDate = (date: Date): string => new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

const fromDb = (c: Candle): StrategyCandle => ({
  candleStart: new Date(c.candleStart),
  open: Number(c.open),
  high: Number(c.high),
  low: Number(c.low),
  close: Number(c.close),
});

class HistoricalCandleService {
  private history = new Map<string, { day: string; candles: StrategyCandle[] }>();
  private intraday = new Map<string, { fetchedAt: number; candles: StrategyCandle[] }>();
  private inFlight = new Map<string, Promise<StrategyCandleSeries>>();
  private lastErrorLogAt = 0;

  async getSeries(instrumentKey: string): Promise<StrategyCandleSeries> {
    const pending = this.inFlight.get(instrumentKey);
    if (pending) return pending;

    const request = this.buildSeries(instrumentKey).finally(() => this.inFlight.delete(instrumentKey));
    this.inFlight.set(instrumentKey, request);
    return request;
  }

  private async buildSeries(instrumentKey: string): Promise<StrategyCandleSeries> {
    const now = Date.now();
    const session = sessionStart();
    const isCompleted = (c: StrategyCandle): boolean => c.candleStart.getTime() + CANDLE_MS <= now;

    let previous: StrategyCandle[];
    let todayUpstox: StrategyCandle[];
    let source: StrategyCandleSeries['source'] = 'upstox';

    try {
      [previous, todayUpstox] = await Promise.all([
        this.getPreviousSessions(instrumentKey, session),
        this.getIntraday(instrumentKey),
      ]);
    } catch (error) {
      if (now - this.lastErrorLogAt > 60_000) {
        this.lastErrorLogAt = now;
        process.stderr.write(`[Candles] Upstox candle fetch failed for ${instrumentKey}, using DB candles: ${String(error)}\n`);
      }
      source = 'db-fallback';
      previous = (await Candle.findAll({
        where: { instrumentKey, candleStart: { [Op.lt]: session } },
        order: [['candleStart', 'DESC']],
        limit: env.strategyWarmupSessions * CANDLES_PER_SESSION,
      })).map(fromDb).reverse();
      todayUpstox = [];
    }

    // Today: Upstox candles win (exchange-accurate); our DB candles fill windows Upstox lacks
    const ownToday = (await Candle.findAll({
      where: { instrumentKey, candleStart: { [Op.gte]: session } },
      order: [['candleStart', 'ASC']],
    })).map(fromDb);

    const merged = new Map<number, StrategyCandle>();
    for (const c of ownToday) merged.set(c.candleStart.getTime(), c);
    for (const c of todayUpstox) merged.set(c.candleStart.getTime(), c);

    const sessionCandles = [...merged.values()]
      .filter((c) => c.candleStart.getTime() >= session.getTime() && isCompleted(c))
      .sort((a, b) => a.candleStart.getTime() - b.candleStart.getTime());

    return {
      candles: [...previous, ...sessionCandles],
      sessionCandles,
      prevSessionClose: previous.length ? previous[previous.length - 1].close : null,
      source,
    };
  }

  /** Last STRATEGY_WARMUP_SESSIONS full sessions before today (cached for the IST day). */
  private async getPreviousSessions(instrumentKey: string, session: Date): Promise<StrategyCandle[]> {
    const today = istDate(session);
    const cached = this.history.get(instrumentKey);
    if (cached?.day === today) return cached.candles;

    const toDate = istDate(new Date(session.getTime() - 24 * 60 * 60 * 1000));
    const fromDate = istDate(new Date(session.getTime() - HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000));
    const candles = (await upstoxService.getCandles(instrumentKey, CANDLE_MINUTES, { toDate, fromDate }))
      .filter((c) => c.candleStart.getTime() < session.getTime())
      .slice(-env.strategyWarmupSessions * CANDLES_PER_SESSION);

    this.history.set(instrumentKey, { day: today, candles });
    return candles;
  }

  private async getIntraday(instrumentKey: string): Promise<StrategyCandle[]> {
    const cached = this.intraday.get(instrumentKey);
    if (cached && Date.now() - cached.fetchedAt < INTRADAY_TTL_MS) return cached.candles;

    const candles = await upstoxService.getCandles(instrumentKey, CANDLE_MINUTES);
    this.intraday.set(instrumentKey, { fetchedAt: Date.now(), candles });
    return candles;
  }
}

export const historicalCandleService = new HistoricalCandleService();
