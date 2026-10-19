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

/** Live VIX from the WebSocket stream (also stops the REST poll re-fetching it for a minute). */
export function setLiveVix(vix: number): void {
  cachedVix = vix;
  vixFetchedAt = Date.now();
}

// While the WebSocket delivered the index within this window, the REST poll skips the index tick
const STREAM_FRESH_MS = 10_000;

// ── Option chain snapshot: only insert if last snapshot is >4 min old ─────
const MIN_CHAIN_SNAPSHOT_GAP_MS = 4 * 60 * 1000;

// Calendar date in IST (YYYY-MM-DD)
const istToday = (): string => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export interface OptionExpiryInfo {
  symbol: string;
  today: string;
  expiries: string[];
  nearestExpiry: string | null;
  /** Expiry the strategy buys: the nearest one, or the next one on expiry day */
  tradingExpiry: string | null;
  isExpiryDay: boolean;
}

class MarketDataService {
  private pollTimer: NodeJS.Timeout | null = null;
  private hasLoggedAuthWarning = false;
  private pollCount = 0;
  // In-memory cache for option chain API responses — skips redundant HTTP calls within the snapshot gap
  private lastChainFetchAt = new Map<string, number>();
  private lastChainData = new Map<string, NormalizedOptionChain>();
  private lotSizeCache = new Map<string, number>();
  // Listed option expiries per instrument, refreshed once a day (the contract list is large)
  private expiryCache = new Map<string, { day: string; expiries: string[] }>();
  // Last time a tick for each instrument arrived from the WebSocket stream
  private lastStreamTickAt = new Map<string, number>();

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
   * Ingest a tick from any source — HTTP poll today, Upstox WebSocket tomorrow.
   * To switch to WebSocket: call this directly from the WS message handler instead
   * of pollOnce. No other changes needed in the rest of the system.
   */
  async ingestTick(
    instrumentKey: string,
    ltp: number,
    symbol: string,
    sourceTimestamp: string,
    richPayload: Record<string, unknown> = {},
  ): Promise<{ symbol: string; instrumentKey: string; ltp: number; sourceTimestamp: string }> {
    const tick = await MarketTick.create({
      symbol,
      instrumentKey,
      ltp,
      sourceTimestamp: new Date(sourceTimestamp),
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
    if (richPayload.source === 'upstox-ws') this.lastStreamTickAt.set(instrumentKey, Date.now());
    return { symbol: payload.symbol, instrumentKey: payload.instrumentKey, ltp: payload.ltp, sourceTimestamp: payload.sourceTimestamp };
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

    return this.ingestTick(instrumentKey, ltp, symbol, timestamp, richPayload);
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

  /** Returns today's latest `limit` 5-minute candles, oldest first. */
  async getCandleHistory(limit: number, instrumentKey?: string): Promise<Candle[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const from = sessionStart();
    const where: WhereOptions = { candleStart: { [Op.gte]: from } };
    if (instrumentKey) (where as Record<string, unknown>).instrumentKey = instrumentKey;

    // Newest first + limit, then reverse — so the latest candles are never cut off
    const candles = await Candle.findAll({
      where,
      order: [['candleStart', 'DESC']],
      limit: safeLimit,
    });
    return candles.reverse();
  }

  /** Exchange lot size of an underlying's options for one expiry (cached); `fallback` if Upstox has none. */
  async getOptionLotSize(instrumentKey: string, expiryDate: string | null, fallback: number): Promise<number> {
    const cacheKey = `${instrumentKey}:${expiryDate ?? 'any'}`;
    const cached = this.lotSizeCache.get(cacheKey);
    if (cached) return cached;

    try {
      const accessToken = await tokenService.getValidAccessToken();
      const lotSize = await upstoxService.getOptionLotSize(accessToken, instrumentKey, expiryDate ?? undefined);
      if (lotSize) {
        if (lotSize !== fallback) {
          process.stdout.write(`[Market] Lot size for ${instrumentKey} ${expiryDate ?? ''} is ${lotSize} (config fallback ${fallback}).\n`);
        }
        this.lotSizeCache.set(cacheKey, lotSize);
        return lotSize;
      }
    } catch { /* fall back to configured lot size */ }

    return fallback;
  }

  /**
   * Chain the strategy trades from: the nearest expiry, or on expiry day the next one — contracts
   * expiring today are never bought, but the day is still traded. The next-expiry chain is not
   * broadcast, so the dashboard keeps showing the nearest expiry.
   */
  async fetchTradableOptionChain(symbol: string): Promise<NormalizedOptionChain> {
    const nearest = await this.fetchAndStoreOptionChain(undefined, symbol);
    if (nearest.expiryDate !== istToday()) return nearest;

    const { tradingExpiry } = await this.getExpiryInfo(symbol);
    return tradingExpiry && tradingExpiry !== nearest.expiryDate
      ? this.fetchAndStoreOptionChain(tradingExpiry, symbol, { broadcast: false })
      : nearest;
  }

  /** Listed expiries from today on, and the one the strategy trades (the next one on expiry day). */
  async getExpiryInfo(symbolOrInstrument?: string): Promise<OptionExpiryInfo> {
    const underlying = underlyingService.resolve(symbolOrInstrument);
    const today = istToday();
    const expiries = underlying.supportsOptions
      ? (await this.getOptionExpiries(underlying.optionChainInstrumentKey)).filter((e) => e >= today)
      : [];
    const isExpiryDay = expiries[0] === today;
    return {
      symbol: underlying.symbol,
      today,
      expiries,
      nearestExpiry: expiries[0] ?? null,
      tradingExpiry: (isExpiryDay ? expiries[1] : expiries[0]) ?? null,
      isExpiryDay,
    };
  }

  private async getOptionExpiries(instrumentKey: string): Promise<string[]> {
    const today = istToday();
    const cached = this.expiryCache.get(instrumentKey);
    if (cached?.day === today) return cached.expiries;

    const accessToken = await tokenService.getValidAccessToken();
    const expiries = await upstoxService.getAvailableExpiries(accessToken, instrumentKey);
    if (expiries.length) this.expiryCache.set(instrumentKey, { day: today, expiries });
    return expiries;
  }

  /** Fetch and store option chain. Inserts a new snapshot (not upsert) if last one is >4 min old. */
  async fetchAndStoreOptionChain(
    expiryDate?: string,
    symbolOrInstrument?: string,
    { broadcast = true }: { broadcast?: boolean } = {},
  ): Promise<NormalizedOptionChain> {
    const underlying = underlyingService.resolve(symbolOrInstrument);

    if (!underlying.supportsOptions) {
      throw new ApiError(400, `${underlying.symbol} does not support option chain in current config.`);
    }

    const today = new Date().toISOString().slice(0, 10);
    const configuredExpiry = env.optionChainExpiryDate;
    const resolvedExpiryDate = expiryDate || (configuredExpiry && configuredExpiry >= today ? configuredExpiry : undefined);
    const cacheKey = `${underlying.optionChainInstrumentKey}:${resolvedExpiryDate ?? 'default'}`;

    // Skip the Upstox API call if we fetched within OPTION_CHAIN_REFRESH_MS.
    // The spot price is polled separately every 5s, so strategy logic always has a fresh underlying price.
    const lastFetch = this.lastChainFetchAt.get(cacheKey) ?? 0;
    if (Date.now() - lastFetch < env.optionChainRefreshMs) {
      const cached = this.lastChainData.get(cacheKey);
      if (cached) return cached;
    }

    const accessToken = await tokenService.getValidAccessToken();
    const raw = await upstoxService.getOptionChain(accessToken, underlying.optionChainInstrumentKey, resolvedExpiryDate);
    const normalized = this.normalizeOptionChain(raw, resolvedExpiryDate, underlying.symbol, underlying.optionChainInstrumentKey);

    this.lastChainFetchAt.set(cacheKey, Date.now());
    this.lastChainData.set(cacheKey, normalized);

    await this.insertOptionChainSnapshot(normalized);
    if (broadcast) websocketService.broadcast('option_chain', normalized);
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
    const today = new Date().toISOString().slice(0, 10);
    const where: WhereOptions = {
      instrumentKey: underlying.optionChainInstrumentKey,
      // Only return snapshots whose expiry is today or in the future — never stale past-expiry data
      ...(expiryDate ? { expiryDate } : { expiryDate: { [Op.gte]: today } }),
    };
    // Nearest expiry first: on expiry day the strategy also stores next-expiry snapshots
    const snapshot = await OptionChainSnapshot.findOne({ where, order: [['expiryDate', 'ASC'], ['snapshotTime', 'DESC']] });
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
      toNumber((firstRow as Record<string, unknown>).underlying_spot_price) ??
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
      // The WebSocket stream already stores the index tick in real time; REST only fills gaps
      const streamFresh = Date.now() - (this.lastStreamTickAt.get(active.instrumentKey) ?? 0) < STREAM_FRESH_MS;

      await Promise.allSettled([
        streamFresh ? Promise.resolve() : this.fetchAndStoreTick(active.instrumentKey, active.symbol),
        active.supportsOptions ? this.fetchAndStoreOptionChain(undefined, active.symbol) : Promise.resolve(),
      ]);

      // Aggregate candles every 5 polls (~25 seconds) to keep overhead low
      this.pollCount++;
      if (this.pollCount % 5 === 0) {
        candleAggregator.aggregatePendingWindows().catch((err: unknown) => {
          process.stderr.write('[CandleAgg] ' + String(err) + '\n');
        });
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
