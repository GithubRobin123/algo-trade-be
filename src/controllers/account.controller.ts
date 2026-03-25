import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../middleware/error.middleware';
import { accountService } from '../services/account.service';

const checkOrderSchema = z.object({
  side: z.enum(['BUY', 'SELL']),
  instrumentKey: z.string().min(1),
  quantity: z.number().int().positive(),
  price: z.number().positive().optional(),
  orderType: z.string().min(1).optional(),
  product: z.string().min(1).optional(),
});

export const getAccountSummary = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const summary = await accountService.getAccountSummary();

    res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    next(error);
  }
};

export const checkOrderFeasibility = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = checkOrderSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const result = await accountService.checkOrder(parsed.data.side, parsed.data);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
