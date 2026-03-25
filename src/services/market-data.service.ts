import { Op, WhereOptions } from 'sequelize';
import { env } from '../config/env';
import { ApiError } from '../middleware/error.middleware';
import { MarketTick } from '../models/market-tick.model';
import { OptionChainSnapshot } from '../models/option-chain-snapshot.model';
import {
  NormalizedOptionChain,
  NormalizedOptionChainRow,
} from '../types/upstox.types';
import { tokenService } from './token.service';
import { underlyingService } from './underlying.service';
import { upstoxService } from './upstox.service';
import { websocketService } from './websocket.service';

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

class MarketDataService {
  private pollTimer: NodeJS.Timeout | null = null;
  private hasLoggedAuthWarning = false;

  startPolling(): void {
    if (this.pollTimer) {
      return;
    }

    void this.pollOnce();

    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, env.marketPollIntervalMs);
  }

  stopPolling(): void {
    if (!this.pollTimer) {
      return;
    }

    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async fetchAndStoreNiftyTick(): Promise<{
    symbol: string;
    instrumentKey: string;
    ltp: number;
    sourceTimestamp: string;
  }> {
    const active = underlyingService.getActive();

    return this.fetchAndStoreTick(active.instrumentKey, active.symbol);
  }

  async fetchAndStoreTick(
    instrumentKey: string,
    fallbackSymbol?: string,
  ): Promise<{
    symbol: string;
    instrumentKey: string;
    ltp: number;
    sourceTimestamp: string;
  }> {
    const accessToken = await tokenService.getValidAccessToken();
    const quote = await upstoxService.getNiftyLtp(accessToken, instrumentKey);

    const tick = await MarketTick.create({
      symbol: quote.symbol || fallbackSymbol || 'UNKNOWN',
      instrumentKey: quote.instrumentKey,
      ltp: quote.ltp,
      sourceTimestamp: new Date(quote.timestamp),
      rawPayload: quote.raw,
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

    return {
      symbol: payload.symbol,
      instrumentKey: payload.instrumentKey,
      ltp: payload.ltp,
      sourceTimestamp: payload.sourceTimestamp,
    };
  }

  async getLatestTick(instrumentKey?: string): Promise<{
    symbol: string;
    instrumentKey: string;
    ltp: number;
    sourceTimestamp: string;
  } | null> {
    const where = instrumentKey ? { instrumentKey } : undefined;

    const tick = await MarketTick.findOne({
      ...(where ? { where } : {}),
      order: [['sourceTimestamp', 'DESC']],
    });

    if (!tick) {
      return null;
    }

    return {
      symbol: tick.symbol,
      instrumentKey: tick.instrumentKey,
      ltp: Number(tick.ltp),
      sourceTimestamp: tick.sourceTimestamp.toISOString(),
    };
  }

  async getTickHistory(limit: number, instrumentKey?: string): Promise<
    {
      symbol: string;
      instrumentKey: string;
      ltp: number;
      sourceTimestamp: string;
    }[]
  > {
    const safeLimit = Math.min(Math.max(limit, 1), env.marketHistoryLimit);
    const where = instrumentKey ? { instrumentKey } : undefined;

    const ticks = await MarketTick.findAll({
      ...(where ? { where } : {}),
      order: [['sourceTimestamp', 'DESC']],
      limit: safeLimit,
    });

    return ticks
      .map((tick) => ({
        symbol: tick.symbol,
        instrumentKey: tick.instrumentKey,
        ltp: Number(tick.ltp),
        sourceTimestamp: tick.sourceTimestamp.toISOString(),
      }))
      .reverse();
  }

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
    const raw = await upstoxService.getOptionChain(
      accessToken,
      underlying.optionChainInstrumentKey,
      resolvedExpiryDate,
    );

    const normalized = this.normalizeOptionChain(raw, resolvedExpiryDate, underlying.symbol, underlying.optionChainInstrumentKey);

    await OptionChainSnapshot.create({
      symbol: normalized.symbol,
      instrumentKey: normalized.instrumentKey,
      expiryDate: normalized.expiryDate,
      underlyingPrice: normalized.underlyingPrice,
      snapshotTime: new Date(normalized.snapshotTime),
      chainRows: normalized.rows,
    });

    websocketService.broadcast('option_chain', normalized);

    return normalized;
  }

  async getLatestOptionChain(
    expiryDate?: string,
    symbolOrInstrument?: string,
  ): Promise<NormalizedOptionChain | null> {
    const underlying = underlyingService.resolve(symbolOrInstrument);

    const where: WhereOptions = {
      instrumentKey: underlying.optionChainInstrumentKey,
      ...(expiryDate ? { expiryDate } : {}),
    };

    const snapshot = await OptionChainSnapshot.findOne({
      where,
      order: [['snapshotTime', 'DESC']],
    });

    if (!snapshot) {
      return null;
    }

    return {
      symbol: snapshot.symbol,
      instrumentKey: snapshot.instrumentKey,
      underlyingPrice: snapshot.underlyingPrice !== null ? Number(snapshot.underlyingPrice) : null,
      expiryDate: snapshot.expiryDate,
      snapshotTime: snapshot.snapshotTime.toISOString(),
      rows: snapshot.chainRows,
    };
  }

  async getRecentVolatility(instrumentKey: string, sampleSize = 30): Promise<number> {
    const ticks = await MarketTick.findAll({
      where: {
        instrumentKey,
        sourceTimestamp: {
          [Op.gte]: new Date(Date.now() - 30 * 60 * 1000),
        },
      },
      order: [['sourceTimestamp', 'DESC']],
      limit: sampleSize,
    });

    if (ticks.length < 3) {
      return 0;
    }

    const prices = ticks.map((item) => Number(item.ltp)).reverse();
    let sumReturns = 0;

    for (let index = 1; index < prices.length; index += 1) {
      const prev = prices[index - 1];
      const curr = prices[index];
      if (prev > 0) {
        sumReturns += Math.abs((curr - prev) / prev);
      }
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
    const inferredExpiry =
      expiryDate ||
      (firstRow.expiry as string | undefined) ||
      (firstRow.expiry_date as string | undefined) ||
      null;

    const underlyingPrice =
      toNumber(root.underlying_spot_price) ??
      toNumber(root.underlying_price) ??
      toNumber((firstRow as Record<string, unknown>).underlying_price);

    return {
      symbol,
      instrumentKey,
      underlyingPrice,
      expiryDate: inferredExpiry,
      snapshotTime: new Date().toISOString(),
      rows: normalizedRows,
    };
  }

  private extractChainRows(root: Record<string, unknown>): Record<string, unknown>[] {
    const candidates: unknown[] = [
      root,
      root.data,
      root.records,
      root.option_chain,
      root.optionChain,
      root.options,
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate.map((item) => asRecord(item));
      }

      if (candidate && typeof candidate === 'object') {
        const candidateRecord = candidate as Record<string, unknown>;
        const nestedArrays = [
          candidateRecord.records,
          candidateRecord.option_chain,
          candidateRecord.optionChain,
          candidateRecord.options,
          candidateRecord.data,
        ];

        for (const nested of nestedArrays) {
          if (Array.isArray(nested)) {
            return nested.map((item) => asRecord(item));
          }
        }
      }
    }

    return [];
  }

  private normalizeChainRow(row: Record<string, unknown>): NormalizedOptionChainRow | null {
    const strikePrice = toNumber(row.strike_price ?? row.strikePrice);

    if (strikePrice === null) {
      return null;
    }

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
      iv:
        toNumber(callGreeks.iv) ??
        toNumber(putGreeks.iv) ??
        toNumber(callMarket.iv) ??
        toNumber(putMarket.iv) ??
        toNumber(row.iv),
      callInstrumentKey:
        (callNode.instrument_key as string | undefined) ??
        (callNode.instrumentKey as string | undefined) ??
        null,
      putInstrumentKey:
        (putNode.instrument_key as string | undefined) ??
        (putNode.instrumentKey as string | undefined) ??
        null,
    };
  }

  private async pollOnce(): Promise<void> {
    try {
      const status = await tokenService.getConnectionStatus();

      if (!status.connected) {
        this.handlePollError(
          new ApiError(
            401,
            'Upstox account is not connected. Complete OAuth login before requesting market data.',
          ),
        );
        return;
      }

      const active = underlyingService.getActive();
      await this.fetchAndStoreTick(active.instrumentKey, active.symbol);
    } catch (error) {
      this.handlePollError(error);
    }
  }

  private handlePollError(error: unknown): void {
    if (error instanceof ApiError && error.statusCode === 401) {
      if (!this.hasLoggedAuthWarning) {
        process.stderr.write('[Market] Poll paused: Upstox token unavailable. Complete OAuth and polling resumes.\n');
        this.hasLoggedAuthWarning = true;
      }
      return;
    }

    process.stderr.write('[Market] Poll failed: ' + String(error) + '\n');
  }
}

export const marketDataService = new MarketDataService();
