import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../middleware/error.middleware';
import { TradeIntentStatus } from '../types/trading.types';
import { tradeIntentService } from '../services/trade-intent.service';
import { serializeIntent, serializeOrder } from './serializers';

const createIntentSchema = z.object({
  side: z.enum(['BUY', 'SELL']),
  symbol: z.string().min(1),
  instrumentKey: z.string().min(1),
  quantity: z.number().int().positive(),
  orderType: z.string().min(1).optional(),
  product: z.string().min(1).optional(),
  validity: z.string().min(1).optional(),
  price: z.number().positive().optional(),
  triggerPrice: z.number().positive().optional(),
  tag: z.string().max(20).optional(),
  source: z.enum(['MANUAL', 'STRATEGY']).optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().max(500).optional(),
  requiresApproval: z.boolean().optional(),
  metadata: z.record(z.any()).optional(),
  expiresInMinutes: z.number().int().positive().optional(),
});

const actionSchema = z.object({
  reason: z.string().max(500).optional(),
  actor: z.string().max(100).optional(),
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

export const createIntent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = createIntentSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const intent = await tradeIntentService.createIntent({
      ...parsed.data,
      source: parsed.data.source ?? 'MANUAL',
    });

    res.status(201).json({
      success: true,
      data: serializeIntent(intent),
    });
  } catch (error) {
    next(error);
  }
};

export const listIntents = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const status =
      typeof req.query.status === 'string' ? (req.query.status as TradeIntentStatus) : undefined;
    const source =
      typeof req.query.source === 'string' && ['MANUAL', 'STRATEGY'].includes(req.query.source)
        ? (req.query.source as 'MANUAL' | 'STRATEGY')
        : undefined;
    const limit = parseLimit(req.query.limit, 50);

    const intents = await tradeIntentService.listIntents({
      limit,
      status,
      source,
    });

    res.json({
      success: true,
      data: intents.map(serializeIntent),
    });
  } catch (error) {
    next(error);
  }
};

export const approveIntent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = Number(req.params.id);

    if (Number.isNaN(id)) {
      throw new ApiError(400, 'Invalid intent id.');
    }

    const parsed = actionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const actor = parsed.data.actor ?? 'ui-user';
    const result = await tradeIntentService.approveIntent(id, actor);

    res.json({
      success: true,
      data: {
        intent: serializeIntent(result.intent),
        order: serializeOrder(result.order),
      },
    });
  } catch (error) {
    next(error);
  }
};

export const rejectIntent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = Number(req.params.id);

    if (Number.isNaN(id)) {
      throw new ApiError(400, 'Invalid intent id.');
    }

    const parsed = actionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const reason = parsed.data.reason ?? 'Rejected by user';
    const actor = parsed.data.actor ?? 'ui-user';

    const intent = await tradeIntentService.rejectIntent(id, reason, actor);

    res.json({
      success: true,
      data: serializeIntent(intent),
    });
  } catch (error) {
    next(error);
  }
};
