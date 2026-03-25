import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../middleware/error.middleware';
import { underlyingService } from '../services/underlying.service';
import { serializeUnderlying } from './serializers';

export const listUnderlyings = (_req: Request, res: Response): void => {
  const underlyings = underlyingService.list();

  res.json({
    success: true,
    data: underlyings.map(serializeUnderlying),
  });
};

export const getActiveUnderlying = (_req: Request, res: Response): void => {
  const active = underlyingService.getActive();

  res.json({
    success: true,
    data: serializeUnderlying(active),
  });
};

export const setActiveUnderlying = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const symbol = req.body?.symbol;

    if (typeof symbol !== 'string' || !symbol.trim()) {
      throw new ApiError(400, 'symbol is required.');
    }

    const active = underlyingService.setActive(symbol);

    res.json({
      success: true,
      data: serializeUnderlying(active),
    });
  } catch (error) {
    next(error);
  }
};
