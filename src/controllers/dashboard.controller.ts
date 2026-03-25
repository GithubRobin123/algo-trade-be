import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../middleware/error.middleware';
import { dashboardService } from '../services/dashboard.service';

export const getDashboardSnapshot = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const data = await dashboardService.getDashboardSnapshot();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const getDecisionLogs = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const decision = typeof req.query.decision === 'string' ? req.query.decision : undefined;
    const underlying = typeof req.query.underlying === 'string' ? req.query.underlying : undefined;
    const daysBack = req.query.daysBack ? Number(req.query.daysBack) : 7;

    const logs = await dashboardService.getDecisionLogs({ limit, decision, underlying, daysBack });
    res.json({ success: true, data: logs });
  } catch (error) {
    next(error);
  }
};

export const getPositionPnlChart = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const positionId = Number(req.params.positionId);
    if (Number.isNaN(positionId)) throw new ApiError(400, 'Invalid positionId');

    const limit = req.query.limit ? Number(req.query.limit) : 300;
    const ticks = await dashboardService.getPositionPnlChart(positionId, limit);
    res.json({ success: true, data: ticks });
  } catch (error) {
    next(error);
  }
};

export const getDailyPnlBreakdown = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const daysBack = req.query.daysBack ? Number(req.query.daysBack) : 30;
    const data = await dashboardService.getDailyPnlBreakdown(daysBack);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
