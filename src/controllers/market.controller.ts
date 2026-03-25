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


    console.log('req.query', req.query);
    

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
