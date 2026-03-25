import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../middleware/error.middleware';
import { reportService } from '../services/report.service';

const parseDays = (value: unknown, fallback: number): number => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const parsed = Number(value);

  if (Number.isNaN(parsed)) {
    throw new ApiError(400, 'days must be a number.');
  }

  return parsed;
};

export const getReportSummary = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const days = parseDays(req.query.days, 30);
    const summary = await reportService.getSummary(days);

    res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    next(error);
  }
};

export const getDailyReport = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const days = parseDays(req.query.days, 30);
    const rows = await reportService.getDaily(days);

    res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
};
