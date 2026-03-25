import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../middleware/error.middleware';
import { orderService } from '../services/order.service';
import { TradeOrder } from '../models/trade-order.model';

const placeOrderSchema = z.object({
  symbol: z.string().min(1),
  instrumentKey: z.string().min(1),
  quantity: z.number().int().positive(),
  orderType: z.string().min(1).optional(),
  product: z.string().min(1).optional(),
  validity: z.string().min(1).optional(),
  price: z.number().positive().optional(),
  triggerPrice: z.number().positive().optional(),
  disclosedQuantity: z.number().int().positive().optional(),
  tag: z.string().max(20).optional(),
});

const serializeOrder = (order: TradeOrder) => ({
  id: Number(order.id),
  provider: order.provider,
  providerOrderId: order.providerOrderId,
  side: order.side,
  symbol: order.symbol,
  instrumentKey: order.instrumentKey,
  quantity: order.quantity,
  product: order.product,
  orderType: order.orderType,
  validity: order.validity,
  price: order.price !== null ? Number(order.price) : null,
  triggerPrice: order.triggerPrice !== null ? Number(order.triggerPrice) : null,
  status: order.status,
  isPaper: order.isPaper,
  errorMessage: order.errorMessage,
  createdAt: order.createdAt?.toISOString() ?? null,
  updatedAt: order.updatedAt?.toISOString() ?? null,
});

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

const createOrderHandler = (side: 'BUY' | 'SELL') => async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = placeOrderSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const order = await orderService.placeOrder(side, parsed.data);

    res.status(201).json({
      success: true,
      data: serializeOrder(order),
    });
  } catch (error) {
    next(error);
  }
};

export const buyOrder = createOrderHandler('BUY');
export const sellOrder = createOrderHandler('SELL');

export const listOrders = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = parseLimit(req.query.limit, 25);
    const orders = await orderService.listOrders(limit);

    res.json({
      success: true,
      data: orders.map(serializeOrder),
    });
  } catch (error) {
    next(error);
  }
};
