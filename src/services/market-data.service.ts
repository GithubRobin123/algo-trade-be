import { Op, WhereOptions } from 'sequelize';
import { env } from '../config/env';
import { ApiError } from '../middleware/error.middleware';
import { Candle } from '../models/candle.model';
import { MarketTick } from '../models/market-tick.model';
import { OptionChainSnapshot } from '../models/option-chain-snapshot.model';
import {
  NormalizedOptionChain,
  NormalizedOptionChainRow,
} from '../types/upstox.types';
import { candleAggregator, sessionStart } from './candle-aggregator.service';
import { tokenService } from './token.service';
import { underlyingService } from './underlying.service';
import { upstoxService } from './upstox.service';
import { websocketService } from './websocket.service';

// Returns true during NSE regular session: Mon–Fri, 09:15–15:30 IST
export function isMarketOpen(): boolean {
  const now = new Date();
  const ist = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const day = ist.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = parseInt(ist.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const min = parseInt(ist.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const totalMin = hour * 60 + min;

  if (day === 'Sat' || day === 'Sun') return false;
  return totalMin >= 555 && totalMin <= 930; // 9:15 (555) to 3:30 (930)
}

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

// ── India VIX in-memory cache (fetched alongside Nifty on each poll) ──────
let cachedVix: number | null = null;
let vixFetchedAt: number = 0;
const VIX_INSTRUMENT_KEY = 'NSE_INDEX|India VIX';
const VIX_CACHE_TTL_MS = 60_000; // refresh VIX every minute at most

export function getLatestVix(): number {
  if (env.indiaVixOverride > 0) return env.indiaVixOverride;
  return cachedVix ?? 14;
}

// ── Option chain snapshot: only insert if last snapshot is >4 min old ─────
const MIN_CHAIN_SNAPSHOT_GAP_MS = 4 * 60 * 1000;

class MarketDataService {
  private pollTimer: NodeJS.Timeout | null = null;
  private hasLoggedAuthWarning = false;
  private pollCount = 0;

  startPolling(): void {
    if (this.pollTimer) return;
    void this.pollOnce();
    this.pollTimer = setInterval(() => { void this.pollOnce(); }, env.marketPollIntervalMs);
  }

  stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async fetchAndStoreNiftyTick(): Promise<{
    symbol: string; instrumentKey: string; ltp: number; sourceTimestamp: string;
  }> {
    const active = underlyingService.getActive();
    return this.fetchAndStoreTick(active.instrumentKey, active.symbol);
  }

  /**
   * Fetch using full-quote endpoint (gives OHLC + volume).
   * Falls back to LTP endpoint if full-quote fails.
   * Also co-fetches India VIX when requested.
   */
  async fetchAndStoreTick(
    instrumentKey: string,
    fallbackSymbol?: string,
  ): Promise<{ symbol: string; instrumentKey: string; ltp: number; sourceTimestamp: string }> {
    const accessToken = await tokenService.getValidAccessToken();

    // Fetch full market quote (includes OHLC, volume) + VIX in one API call
    const shouldFetchVix =
      env.indiaVixOverride === 0 &&
      Date.now() - vixFetchedAt > VIX_CACHE_TTL_MS;

    const keysToFetch = shouldFetchVix
      ? [instrumentKey, VIX_INSTRUMENT_KEY]
      : [instrumentKey];

    let richPayload: Record<string, unknown> = {};
    let ltp: number;
    let symbol = fallbackSymbol ?? 'UNKNOWN';
    let timestamp = new Date().toISOString();

    try {
      const quotes = await upstoxService.getFullMarketQuote(accessToken, keysToFetch);

      const main = quotes[instrumentKey];
      if (!main || main.ltp === null) throw new Error('No LTP in full-quote response');

      ltp = main.ltp;
      richPayload = main.raw;
      symbol = (main.raw.trading_symbol as string | undefined) ?? (main.raw.symbol as string | undefined) ?? fallbackSymbol ?? 'UNKNOWN';
      timestamp = (main.raw.last_trade_time as string | undefined) ?? (main.raw.timestamp as string | undefined) ?? new Date().toISOString();

      // Update VIX cache
      if (shouldFetchVix && quotes[VIX_INSTRUMENT_KEY]?.ltp !== null) {
        const vixVal = quotes[VIX_INSTRUMENT_KEY]?.ltp;
        if (vixVal !== null && vixVal !== undefined) {
          cachedVix = vixVal;
          vixFetchedAt = Date.now();
        }
      }
    } catch {
      // Fallback to lightweight LTP endpoint
      const quote = await upstoxService.getNiftyLtp(accessToken, instrumentKey);
      ltp = quote.ltp;
      richPayload = asRecord(quote.raw);
      symbol = quote.symbol || fallbackSymbol || 'UNKNOWN';
      timestamp = quote.timestamp;
    }

    const tick = await MarketTick.create({
      symbol,
      instrumentKey,
      ltp,
      sourceTimestamp: new Date(timestamp),
      rawPayload: richPayload,
    });

    const payload = {
      id: Number(tick.id),
      symbol: tick.symbol,
      instrumentKey: tick.instrumentKey,
      ltp: Number(tick.ltp),
      sourceTimestamp: tick.sourceTimestamp.toISOString(),
      createdAt: tick.createdAt?.toISOString() ?? new Date().toISOString(),
    };

    websocketService.broadcast('tick', payload);
    this.hasLoggedAuthWarning = false;

    return { symbol: payload.symbol, instrumentKey: payload.instrumentKey, ltp: payload.ltp, sourceTimestamp: payload.sourceTimestamp };
  }

  /** Latest tick for a given instrument (no date filter — for live display). */
  async getLatestTick(instrumentKey?: string): Promise<{
    symbol: string; instrumentKey: string; ltp: number; sourceTimestamp: string;
  } | null> {
    const where = instrumentKey ? { instrumentKey } : undefined;
    const tick = await MarketTick.findOne({
      ...(where ? { where } : {}),
      order: [['sourceTimestamp', 'DESC']],
    });
    if (!tick) return null;
    return { symbol: tick.symbol, instrumentKey: tick.instrumentKey, ltp: Number(tick.ltp), sourceTimestamp: tick.sourceTimestamp.toISOString() };
  }

  /**
   * Session-filtered tick history — TODAY's ticks only, from 9:15 AM IST.
   * This is the fix for indicators getting contaminated by yesterday's prices.
   */
  async getSessionTickHistory(limit: number, instrumentKey?: string): Promise<
    { symbol: string; instrumentKey: string; ltp: number; sourceTimestamp: string }[]
  > {
    const safeLimit = Math.min(Math.max(limit, 1), env.marketHistoryLimit);
    const from = sessionStart();
    const where: WhereOptions = { sourceTimestamp: { [Op.gte]: from } };
    if (instrumentKey) (where as Record<string, unknown>).instrumentKey = instrumentKey;

    const ticks = await MarketTick.findAll({
      where,
      order: [['sourceTimestamp', 'DESC']],
      limit: safeLimit,
    });

    return ticks
      .map((t) => ({ symbol: t.symbol, instrumentKey: t.instrumentKey, ltp: Number(t.ltp), sourceTimestamp: t.sourceTimestamp.toISOString() }))
      .reverse();
  }

  /** Legacy API kept for backwards compat — now calls session-filtered version. */
  async getTickHistory(limit: number, instrumentKey?: string): Promise<
    { symbol: string; instrumentKey: string; ltp: number; sourceTimestamp: string }[]
  > {
    return this.getSessionTickHistory(limit, instrumentKey);
  }

  /** Returns today's 5-minute candles, oldest first. */
  async getCandleHistory(limit: number, instrumentKey?: string): Promise<Candle[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const from = sessionStart();
    const where: WhereOptions = { candleStart: { [Op.gte]: from } };
    if (instrumentKey) (where as Record<string, unknown>).instrumentKey = instrumentKey;

    return Candle.findAll({
      where,
      order: [['candleStart', 'ASC']],
      limit: safeLimit,
    });
  }

  /** Fetch and store option chain. Inserts a new snapshot (not upsert) if last one is >4 min old. */
  async fetchAndStoreOptionChain(
    expiryDate?: string,
    symbolOrInstrument?: string,
  ): Promise<NormalizedOptionChain> {
    const underlying = underlyingService.resolve(symbolOrInstrument);

    if (!underlying.supportsOptions) {
      throw new ApiError(400, `${underlying.symbol} does not support option chain in current config.`);
    }

    const accessToken = await tokenService.getValidAccessToken();
    const resolvedExpiryDate = expiryDate || env.optionChainExpiryDate || undefined;
    const raw = await upstoxService.getOptionChain(accessToken, underlying.optionChainInstrumentKey, resolvedExpiryDate);
    const normalized = this.normalizeOptionChain(raw, resolvedExpiryDate, underlying.symbol, underlying.optionChainInstrumentKey);

    await this.insertOptionChainSnapshot(normalized);
    websocketService.broadcast('option_chain', normalized);
    return normalized;
  }

  /** Inserts a new snapshot row (history preserved). */
  private async insertOptionChainSnapshot(normalized: NormalizedOptionChain): Promise<void> {
    const latest = await OptionChainSnapshot.findOne({
      where: {
        instrumentKey: normalized.instrumentKey,
        ...(normalized.expiryDate ? { expiryDate: normalized.expiryDate } : {}),
      },
      order: [['snapshotTime', 'DESC']],
    });

    const ageMs = latest
      ? Date.now() - new Date(latest.snapshotTime).getTime()
      : Infinity;

    if (ageMs < MIN_CHAIN_SNAPSHOT_GAP_MS) {
      // Update the most-recent row instead of inserting a new one (rate-limit inserts)
      if (latest) {
        latest.underlyingPrice = normalized.underlyingPrice;
        latest.snapshotTime = new Date(normalized.snapshotTime);
        latest.chainRows = normalized.rows;
        await latest.save();
      }
      return;
    }

    await OptionChainSnapshot.create({
      symbol: normalized.symbol,
      instrumentKey: normalized.instrumentKey,
      expiryDate: normalized.expiryDate,
      underlyingPrice: normalized.underlyingPrice,
      snapshotTime: new Date(normalized.snapshotTime),
      chainRows: normalized.rows,
    });
  }

  async getLatestOptionChain(expiryDate?: string, symbolOrInstrument?: string): Promise<NormalizedOptionChain | null> {
    const underlying = underlyingService.resolve(symbolOrInstrument);
    const where: WhereOptions = {
      instrumentKey: underlying.optionChainInstrumentKey,
      ...(expiryDate ? { expiryDate } : {}),
    };
    const snapshot = await OptionChainSnapshot.findOne({ where, order: [['snapshotTime', 'DESC']] });
    if (!snapshot) return null;
    return {
      symbol: snapshot.symbol,
      instrumentKey: snapshot.instrumentKey,
      underlyingPrice: snapshot.underlyingPrice !== null ? Number(snapshot.underlyingPrice) : null,
      expiryDate: snapshot.expiryDate,
      snapshotTime: snapshot.snapshotTime.toISOString(),
      rows: snapshot.chainRows,
    };
  }

  /** Volatility based on session candles (more meaningful than raw tick variance). */
  async getRecentVolatility(instrumentKey: string, sampleSize = 30): Promise<number> {
    const candles = await this.getCandleHistory(sampleSize, instrumentKey);

    if (candles.length >= 3) {
      const prices = candles.map((c) => Number(c.close));
      let sumReturns = 0;
      for (let i = 1; i < prices.length; i++) {
        const prev = prices[i - 1];
        if (prev > 0) sumReturns += Math.abs((prices[i] - prev) / prev);
      }
      return sumReturns / (prices.length - 1);
    }

    // Fallback: use session ticks
    const ticks = await this.getSessionTickHistory(sampleSize, instrumentKey);
    if (ticks.length < 3) return 0;
    const prices = ticks.map((t) => t.ltp);
    let sumReturns = 0;
    for (let i = 1; i < prices.length; i++) {
      const prev = prices[i - 1];
      if (prev > 0) sumReturns += Math.abs((prices[i] - prev) / prev);
    }
    return sumReturns / (prices.length - 1);
  }

  private normalizeOptionChain(
    raw: Record<string, unknown>,
    expiryDate: string | undefined,
    symbol: string,
    instrumentKey: string,
  ): NormalizedOptionChain {
    const root = asRecord(raw.data ?? raw);
    const chainRowsSource = this.extractChainRows(root);

    const normalizedRows: NormalizedOptionChainRow[] = chainRowsSource
      .map((entry) => this.normalizeChainRow(entry))
      .filter((entry): entry is NormalizedOptionChainRow => entry !== null)
      .sort((a, b) => a.strikePrice - b.strikePrice);

    const firstRow = chainRowsSource[0] ?? {};
    const inferredExpiry = expiryDate || (firstRow.expiry as string | undefined) || (firstRow.expiry_date as string | undefined) || null;
    const underlyingPrice =
      toNumber(root.underlying_spot_price) ??
      toNumber(root.underlying_price) ??
      toNumber((firstRow as Record<string, unknown>).underlying_price);

    return { symbol, instrumentKey, underlyingPrice, expiryDate: inferredExpiry, snapshotTime: new Date().toISOString(), rows: normalizedRows };
  }

  private extractChainRows(root: Record<string, unknown>): Record<string, unknown>[] {
    const candidates: unknown[] = [root, root.data, root.records, root.option_chain, root.optionChain, root.options];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate.map((item) => asRecord(item));
      if (candidate && typeof candidate === 'object') {
        const r = candidate as Record<string, unknown>;
        for (const nested of [r.records, r.option_chain, r.optionChain, r.options, r.data]) {
          if (Array.isArray(nested)) return nested.map((item) => asRecord(item));
        }
      }
    }
    return [];
  }

  private normalizeChainRow(row: Record<string, unknown>): NormalizedOptionChainRow | null {
    const strikePrice = toNumber(row.strike_price ?? row.strikePrice);
    if (strikePrice === null) return null;

    const callNode = asRecord(row.call_options ?? row.callOptions ?? row.call_option ?? row.call);
    const putNode = asRecord(row.put_options ?? row.putOptions ?? row.put_option ?? row.put);
    const callMarket = asRecord(callNode.market_data ?? callNode.marketData ?? callNode);
    const putMarket = asRecord(putNode.market_data ?? putNode.marketData ?? putNode);
    const callGreeks = asRecord(callNode.option_greeks ?? callNode.optionGreeks);
    const putGreeks = asRecord(putNode.option_greeks ?? putNode.optionGreeks);

    return {
      strikePrice,
      callLtp: toNumber(callMarket.ltp ?? callNode.ltp),
      callOi: toNumber(callMarket.oi ?? callMarket.open_interest ?? callNode.oi),
      putLtp: toNumber(putMarket.ltp ?? putNode.ltp),
      putOi: toNumber(putMarket.oi ?? putMarket.open_interest ?? putNode.oi),
      iv: toNumber(callGreeks.iv) ?? toNumber(putGreeks.iv) ?? toNumber(callMarket.iv) ?? toNumber(putMarket.iv) ?? toNumber(row.iv),
      callInstrumentKey: (callNode.instrument_key as string | undefined) ?? (callNode.instrumentKey as string | undefined) ?? null,
      putInstrumentKey: (putNode.instrument_key as string | undefined) ?? (putNode.instrumentKey as string | undefined) ?? null,
    };
  }

  private async pollOnce(): Promise<void> {
    try {
      if (!isMarketOpen()) return;

      const status = await tokenService.getConnectionStatus();
      if (!status.connected) {
        this.handlePollError(new ApiError(401, 'Upstox account not connected.'));
        return;
      }

      const active = underlyingService.getActive();

      await Promise.allSettled([
        this.fetchAndStoreTick(active.instrumentKey, active.symbol),
        active.supportsOptions ? this.fetchAndStoreOptionChain(undefined, active.symbol) : Promise.resolve(),
      ]);

      // Aggregate candles every 5 polls (~25 seconds) to keep overhead low
      this.pollCount++;
      if (this.pollCount % 5 === 0) {
        void candleAggregator.aggregatePendingWindows();
      }
    } catch (error) {
      this.handlePollError(error);
    }
  }

  private handlePollError(error: unknown): void {
    if (error instanceof ApiError && error.statusCode === 401) {
      if (!this.hasLoggedAuthWarning) {
        process.stderr.write('[Market] Poll paused: Upstox token unavailable.\n');
        this.hasLoggedAuthWarning = true;
      }
      return;
    }
    process.stderr.write('[Market] Poll failed: ' + String(error) + '\n');
  }
}

export const marketDataService = new MarketDataService();
