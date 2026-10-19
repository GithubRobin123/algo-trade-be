import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../middleware/error.middleware';
import { marketDataService } from '../services/market-data.service';
import { marketStreamService } from '../services/market-stream.service';
import { underlyingService } from '../services/underlying.service';
import { UnderlyingInstrument } from '../types/trading.types';

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

/** Real-time feed health: state, subscribed instruments, last message, ticks received, last error. */
export const getStreamStatus = (_req: Request, res: Response): void => {
  res.json({ success: true, data: marketStreamService.getStatus() });
};

type OverviewRow = Pick<
  UnderlyingInstrument,
  'symbol' | 'displayName' | 'instrumentKey' | 'assetClass' | 'supportsOptions' | 'defaultLotSize'
> & { ltp: number | null; prevClose: number | null; change: number | null; changePct: number | null };

// All indices come from ONE batched Upstox quote call, shared by every dashboard tab for
// OVERVIEW_CACHE_MS. (One call per index on every 5s poll exceeded Upstox rate limits → 429 →
// every price blank.) During market-closed hours the cache is served as-is.
const OVERVIEW_CACHE_MS = 5_000;
let overviewCache: { data: OverviewRow[]; cachedAt: number } | null = null;
let overviewInFlight: Promise<OverviewRow[]> | null = null;
let overviewErrorLoggedAt = 0;

const buildMarketOverview = async (): Promise<OverviewRow[]> => {
  const { tokenService } = await import('../services/token.service');
  const { upstoxService } = await import('../services/upstox.service');

  const accessToken = await tokenService.getValidAccessToken();
  const allUnderlyings = underlyingService.list();

  let quotes: Awaited<ReturnType<typeof upstoxService.getFullMarketQuote>> = {};
  try {
    quotes = await upstoxService.getFullMarketQuote(accessToken, allUnderlyings.map((u) => u.instrumentKey));
  } catch (error) {
    // Keep the last known prices below instead of blanking the bar (e.g. on an Upstox 429)
    if (Date.now() - overviewErrorLoggedAt > 60_000) {
      overviewErrorLoggedAt = Date.now();
      process.stderr.write(`[Market] Overview quote fetch failed: ${String(error)}\n`);
    }
  }

  const previous = new Map((overviewCache?.data ?? []).map((row) => [row.instrumentKey, row]));

  return allUnderlyings.map((u) => {
    const quote = quotes[u.instrumentKey];
    const last = previous.get(u.instrumentKey);
    const ltp = quote?.ltp ?? last?.ltp ?? null;
    const change = quote ? quote.netChange : last?.change ?? null;
    const prevClose = ltp !== null && change !== null ? ltp - change : null;
    const changePct = change !== null && prevClose ? (change / prevClose) * 100 : null;
    return {
      symbol: u.symbol,
      displayName: u.displayName,
      instrumentKey: u.instrumentKey,
      assetClass: u.assetClass,
      supportsOptions: u.supportsOptions,
      defaultLotSize: u.defaultLotSize,
      ltp,
      prevClose,
      change,
      changePct,
    };
  });
};

export const getMarketOverview = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { isMarketOpen } = await import('../services/market-data.service');
    const marketOpen = isMarketOpen();
    const isFresh = overviewCache && (!marketOpen || Date.now() - overviewCache.cachedAt < OVERVIEW_CACHE_MS);

    if (!isFresh) {
      if (!overviewInFlight) {
        overviewInFlight = buildMarketOverview()
          .then((data) => {
            overviewCache = { data, cachedAt: Date.now() };
            return data;
          })
          .finally(() => {
            overviewInFlight = null;
          });
      }
      await overviewInFlight;
    }

    res.json({
      success: true,
      data: overviewCache?.data ?? [],
      marketOpen,
      cachedAt: overviewCache ? new Date(overviewCache.cachedAt).toISOString() : null,
    });
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
    // A chain viewed for a chosen expiry goes only to this caller, not to every dashboard
    const fetchChain = () => marketDataService.fetchAndStoreOptionChain(expiryDate, symbolOrInstrument, { broadcast: !expiryDate });

    let data = shouldRefresh
      ? await fetchChain()
      : await marketDataService.getLatestOptionChain(expiryDate, symbolOrInstrument);

    if (!data) {
      data = await fetchChain();
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

    process.stderr.write(`[Market] Option chain request failed: ${String(error)}\n`);
    next(new ApiError(500, 'Failed to fetch option chain'));
  }
};

/** Listed option expiries for the chain dropdown, and the expiry the strategy trades today. */
export const getOptionExpiries = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = await marketDataService.getExpiryInfo(resolveUnderlyingForOption(req));
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
