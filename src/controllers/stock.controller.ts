import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../middleware/error.middleware';
import { stockCatalogService } from '../services/stock-catalog.service';
import { watchlistService } from '../services/watchlist.service';
import { StockInstrument } from '../models/stock-instrument.model';

const searchSchema = z.object({
  q: z.string().optional(),
  exchange: z.string().optional(),
  segment: z.string().optional(),
  assetClass: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  syncRemote: z.coerce.boolean().optional(),
});

const addWatchlistSchema = z.object({
  symbol: z.string().optional(),
  instrumentKey: z.string().min(1),
  displayName: z.string().optional(),
  exchange: z.string().optional(),
  segment: z.string().optional(),
  notes: z.string().max(500).optional(),
});

const updateWatchlistSchema = z.object({
  notes: z.string().max(500).nullable(),
});

const syncBodSchema = z.object({
  url: z.string().url().optional(),
  maxRecords: z.number().int().positive().max(50000).optional(),
});

const serializeInstrument = (item: StockInstrument) => ({
  id: Number(item.id),
  instrumentKey: item.instrumentKey,
  symbol: item.symbol,
  tradingSymbol: item.tradingSymbol,
  displayName: item.displayName,
  exchange: item.exchange,
  segment: item.segment,
  assetClass: item.assetClass,
  instrumentType: item.instrumentType,
  expiryDate: item.expiryDate,
  strikePrice: item.strikePrice !== null ? Number(item.strikePrice) : null,
  optionType: item.optionType,
  lotSize: item.lotSize,
  tickSize: item.tickSize !== null ? Number(item.tickSize) : null,
  isTradable: item.isTradable,
  createdAt: item.createdAt?.toISOString() ?? null,
  updatedAt: item.updatedAt?.toISOString() ?? null,
});

export const searchStocks = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = searchSchema.safeParse(req.query);

    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    if (parsed.data.syncRemote && parsed.data.q) {
      await stockCatalogService.syncFromUpstoxSearch(parsed.data.q);
    }

    const rows = await stockCatalogService.search({
      q: parsed.data.q,
      exchange: parsed.data.exchange,
      segment: parsed.data.segment,
      assetClass: parsed.data.assetClass,
      limit: parsed.data.limit,
    });

    res.json({
      success: true,
      data: rows.map(serializeInstrument),
    });
  } catch (error) {
    next(error);
  }
};

export const syncStockCatalog = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = syncBodSchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const result = await stockCatalogService.syncFromBod(parsed.data.url, parsed.data.maxRecords);

    res.json({
      success: true,
      data: result,
      message: `Synced ${result.synced} instruments from BOD source.`,
    });
  } catch (error) {
    next(error);
  }
};

export const listWatchlist = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const includeQuotes = req.query.includeQuotes !== 'false';
    const rows = await watchlistService.list(includeQuotes);

    res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
};

export const addWatchlistItem = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = addWatchlistSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const created = await watchlistService.add(parsed.data);

    res.status(201).json({
      success: true,
      data: watchlistService.toView(created),
    });
  } catch (error) {
    next(error);
  }
};

export const updateWatchlistItem = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      throw new ApiError(400, 'Invalid watchlist id.');
    }

    const parsed = updateWatchlistSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const item = await watchlistService.upsertNote(id, parsed.data.notes);

    res.json({
      success: true,
      data: watchlistService.toView(item),
    });
  } catch (error) {
    next(error);
  }
};

export const removeWatchlistItem = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = Number(req.params.id);

    if (Number.isNaN(id)) {
      throw new ApiError(400, 'Invalid watchlist id.');
    }

    await watchlistService.remove(id);

    res.json({
      success: true,
      message: 'Watchlist item removed.',
    });
  } catch (error) {
    next(error);
  }
};
