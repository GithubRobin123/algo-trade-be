import { ApiError } from '../middleware/error.middleware';
import { StockInstrument } from '../models/stock-instrument.model';
import { WatchlistItem } from '../models/watchlist-item.model';
import { tokenService } from './token.service';
import { upstoxService } from './upstox.service';

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

export interface WatchlistItemView {
  id: number;
  symbol: string;
  instrumentKey: string;
  displayName: string;
  exchange: string | null;
  segment: string | null;
  notes: string | null;
  lastPrice: number | null;
  closePrice: number | null;
  change: number | null;
  changePct: number | null;
  createdAt: string;
  updatedAt: string;
}

class WatchlistService {
  async list(includeQuotes = true): Promise<WatchlistItemView[]> {
    const rows = await WatchlistItem.findAll({
      order: [['createdAt', 'DESC']],
      limit: 500,
    });

    if (!rows.length) {
      return [];
    }

    let quoteMap: Record<string, { ltp: number | null; close: number | null }> = {};

    if (includeQuotes) {
      const status = await tokenService.getConnectionStatus();
      if (status.connected) {
        try {
          const accessToken = await tokenService.getValidAccessToken();
          const fetched = await upstoxService.getFullMarketQuote(
            accessToken,
            rows.map((item) => item.instrumentKey),
          );

          quoteMap = Object.entries(fetched).reduce(
            (acc, [instrumentKey, quote]) => {
              acc[instrumentKey] = {
                ltp: quote.ltp,
                close: quote.close,
              };
              return acc;
            },
            {} as Record<string, { ltp: number | null; close: number | null }>,
          );
        } catch {
          quoteMap = {};
        }
      }
    }

    return rows.map((item) => {
      const quote = quoteMap[item.instrumentKey];
      const lastPrice = quote?.ltp ?? null;
      const closePrice = quote?.close ?? null;
      const change =
        lastPrice !== null && closePrice !== null ? lastPrice - closePrice : null;
      const changePct =
        change !== null && closePrice && closePrice !== 0
          ? (change / closePrice) * 100
          : null;

      return {
        id: Number(item.id),
        symbol: item.symbol,
        instrumentKey: item.instrumentKey,
        displayName: item.displayName,
        exchange: item.exchange,
        segment: item.segment,
        notes: item.notes,
        lastPrice,
        closePrice,
        change,
        changePct,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      };
    });
  }

  async add(input: {
    symbol?: string;
    instrumentKey: string;
    displayName?: string;
    exchange?: string | null;
    segment?: string | null;
    notes?: string | null;
  }): Promise<WatchlistItem> {
    const existing = await WatchlistItem.findOne({
      where: {
        instrumentKey: input.instrumentKey,
      },
    });

    if (existing) {
      return existing;
    }

    const fromCatalog = await StockInstrument.findOne({
      where: {
        instrumentKey: input.instrumentKey,
      },
    });

    const symbol = input.symbol || fromCatalog?.symbol;
    const displayName = input.displayName || fromCatalog?.displayName;

    if (!symbol || !displayName) {
      throw new ApiError(400, 'symbol and displayName are required for a new watchlist item.');
    }

    return WatchlistItem.create({
      symbol,
      instrumentKey: input.instrumentKey,
      displayName,
      exchange: input.exchange ?? fromCatalog?.exchange ?? null,
      segment: input.segment ?? fromCatalog?.segment ?? null,
      notes: input.notes ?? null,
    });
  }

  async remove(id: number): Promise<void> {
    const deleted = await WatchlistItem.destroy({
      where: {
        id,
      },
    });

    if (!deleted) {
      throw new ApiError(404, `Watchlist item ${id} not found.`);
    }
  }

  async upsertNote(id: number, notes: string | null): Promise<WatchlistItem> {
    const item = await WatchlistItem.findByPk(id);

    if (!item) {
      throw new ApiError(404, `Watchlist item ${id} not found.`);
    }

    item.notes = notes;
    await item.save();

    return item;
  }

  toView(item: WatchlistItem): WatchlistItemView {
    return {
      id: Number(item.id),
      symbol: item.symbol,
      instrumentKey: item.instrumentKey,
      displayName: item.displayName,
      exchange: item.exchange,
      segment: item.segment,
      notes: item.notes,
      lastPrice: null,
      closePrice: null,
      change: null,
      changePct: null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  }
}

export const watchlistService = new WatchlistService();
