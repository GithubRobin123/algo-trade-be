import { NextFunction, Request, Response } from 'express';
import { tradeHistoryService } from '../services/trade-history.service';

export const getTradeHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const days = Math.min(Number(req.query['days'] ?? 30), 365);
    const status = (req.query['status'] as 'OPEN' | 'CLOSED' | 'ALL' | undefined) ?? 'ALL';
    const data = await tradeHistoryService.getTradeHistory(days, status);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getDecisionLog = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const days = Math.min(Number(req.query['days'] ?? 7), 90);
    const decision = req.query['decision'] as string | undefined;
    const data = await tradeHistoryService.getDecisionLog(days, decision);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getTradeSummary = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const days = Math.min(Number(req.query['days'] ?? 30), 365);
    const data = await tradeHistoryService.getTradeSummary(days);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
