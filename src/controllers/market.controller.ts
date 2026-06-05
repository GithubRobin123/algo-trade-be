import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../middleware/error.middleware';
import { marketDataService } from '../services/market-data.service';
import { underlyingService } from '../services/underlying.service';

const parseLimit = (value: unknown, fallback: number): number => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return parsed;
};

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value !== 'string') {
    return fallback;
  }

  return value.toLowerCase() === 'true';
};

const resolveInstrumentKey = (req: Request): string => {
  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
  const instrument = typeof req.query.instrumentKey === 'string' ? req.query.instrumentKey : undefined;

  return underlyingService.resolve(symbol ?? instrument).instrumentKey;
};

const resolveUnderlyingForOption = (req: Request): string => {
  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
  const instrument = typeof req.query.instrumentKey === 'string' ? req.query.instrumentKey : undefined;

  return symbol ?? instrument ?? underlyingService.getActive().symbol;
};

// Simple in-memory cache for overview — refreshed only during market hours
let overviewCache: { data: unknown[]; cachedAt: number } | null = null;

// Batch LTP for the market overview bar — all popular indices in one call
export const getMarketOverview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { tokenService } = await import('../services/token.service');
    const { upstoxService } = await import('../services/upstox.service');
    const { underlyingService } = await import('../services/underlying.service');
    const { isMarketOpen } = await import('../services/market-data.service');

    // When market is closed, serve cached data (no Upstox API calls)
    if (!isMarketOpen()) {
      if (overviewCache) {
        res.json({ success: true, data: overviewCache.data, marketOpen: false, cachedAt: new Date(overviewCache.cachedAt).toISOString() });
        return;
      }
      // No cache yet — fetch once and cache it
    }

    const accessToken = await tokenService.getValidAccessToken();
    const allUnderlyings = underlyingService.list();

    // Fetch current LTP for all instruments in parallel
    const ltpResults = await Promise.allSettled(
      allUnderlyings.map((u) => upstoxService.getNiftyLtp(accessToken, u.instrumentKey)),
    );

    // Get today's first stored tick per instrument (used as day-open for change calc)
    const { MarketTick } = await import('../models/market-tick.model');
    const { Op } = await import('sequelize');
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const firstTicks = await MarketTick.findAll({
      attributes: ['instrumentKey', 'ltp'],
      where: { sourceTimestamp: { [Op.gte]: todayStart } } as never,
      order: [['sourceTimestamp', 'ASC']],
    });
    const dayOpenMap: Record<string, number> = {};
    for (const tick of firstTicks) {
      if (!(tick.instrumentKey in dayOpenMap)) {
        dayOpenMap[tick.instrumentKey] = Number(tick.ltp);
      }
    }

    const overview = allUnderlyings.map((u, idx) => {
      const ltpResult = ltpResults[idx];
      const ltp = ltpResult.status === 'fulfilled' ? ltpResult.value.ltp : null;
      const dayOpen = dayOpenMap[u.instrumentKey] ?? null;
      const change = ltp != null && dayOpen != null && dayOpen > 0 ? ltp - dayOpen : null;
      const changePct = change != null && dayOpen != null && dayOpen > 0 ? (change / dayOpen) * 100 : null;
      return {
        symbol: u.symbol,
        displayName: u.displayName,
        instrumentKey: u.instrumentKey,
        assetClass: u.assetClass,
        supportsOptions: u.supportsOptions,
        defaultLotSize: u.defaultLotSize,
        ltp,
        prevClose: dayOpen,
        change,
        changePct,
      };
    });

    // Cache the result
    overviewCache = { data: overview, cachedAt: Date.now() };

    res.json({ success: true, data: overview, marketOpen: isMarketOpen() });
  } catch (error) {
    next(error);
  }
};

// Fetch live LTP for any arbitrary instrument key (e.g. NSE_FO|NIFTY...CE)
export const getInstrumentLtp = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rawKey = typeof req.query.instrumentKey === 'string' ? req.query.instrumentKey.trim() : null;
    if (!rawKey) {
      res.status(400).json({ success: false, message: 'instrumentKey query param required' });
      return;
    }

    const { tokenService } = await import('../services/token.service');
    const { upstoxService } = await import('../services/upstox.service');
    const accessToken = await tokenService.getValidAccessToken();
    const quote = await upstoxService.getNiftyLtp(accessToken, rawKey);

    res.json({
      success: true,
      data: {
        instrumentKey: rawKey,
        symbol: quote.symbol,
        ltp: quote.ltp,
        sourceTimestamp: quote.timestamp,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getNiftyLivePrice = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const shouldRefresh = parseBoolean(req.query.refresh, false);
    const instrumentKey = resolveInstrumentKey(req);
    const underlying = underlyingService.resolve(instrumentKey);

    let data = shouldRefresh
      ? await marketDataService.fetchAndStoreTick(underlying.instrumentKey, underlying.symbol)
      : await marketDataService.getLatestTick(instrumentKey);

    if (!data) {
      data = await marketDataService.fetchAndStoreTick(underlying.instrumentKey, underlying.symbol);
    }

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export const getNiftyHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = parseLimit(req.query.limit, 200);
    const instrumentKey = resolveInstrumentKey(req);
    const data = await marketDataService.getTickHistory(limit, instrumentKey);

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};


export const getOptionChain = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const expiryDate = typeof req.query.expiryDate === 'string' ? req.query.expiryDate : undefined;
    const shouldRefresh = parseBoolean(req.query.refresh, false);
    const symbolOrInstrument = resolveUnderlyingForOption(req);

    let data = shouldRefresh
      ? await marketDataService.fetchAndStoreOptionChain(expiryDate, symbolOrInstrument)
      : await marketDataService.getLatestOptionChain(expiryDate, symbolOrInstrument);

    if (!data) {
      data = await marketDataService.fetchAndStoreOptionChain(expiryDate, symbolOrInstrument);
    }

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      next(error);
      return;
    }

    next(new ApiError(500, 'Failed to fetch option chain'));
  }
};
