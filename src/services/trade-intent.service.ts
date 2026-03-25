import { Op } from 'sequelize';
import { env } from '../config/env';
import { ApiError } from '../middleware/error.middleware';
import { StrategyPosition } from '../models/strategy-position.model';
import { TradeIntent } from '../models/trade-intent.model';
import { TradeOrder, TradeSide } from '../models/trade-order.model';
import {
  TradeIntentSource,
  TradeIntentStatus,
} from '../types/trading.types';
import { PlaceOrderRequest, orderService } from './order.service';

export interface CreateTradeIntentInput extends PlaceOrderRequest {
  side: TradeSide;
  source: TradeIntentSource;
  confidence?: number;
  rationale?: string;
  requiresApproval?: boolean;
  metadata?: Record<string, unknown>;
  expiresInMinutes?: number;
}

class TradeIntentService {
  async createIntent(input: CreateTradeIntentInput): Promise<TradeIntent> {
    const expiresAt = input.expiresInMinutes
      ? new Date(Date.now() + input.expiresInMinutes * 60 * 1000)
      : null;

    const intent = await TradeIntent.create({
      source: input.source,
      status:
        (input.requiresApproval ?? env.requireTradeApproval)
          ? 'PENDING_APPROVAL'
          : 'APPROVED',
      side: this.normalizeTradeSide(input),
      symbol: input.symbol,
      instrumentKey: input.instrumentKey,
      quantity: input.quantity,
      orderType: input.orderType ?? 'MARKET',
      product: input.product ?? env.defaultOrderProduct,
      validity: input.validity ?? env.defaultOrderValidity,
      price: input.price ?? null,
      triggerPrice: input.triggerPrice ?? null,
      tag: input.tag ?? null,
      confidence: input.confidence ?? null,
      rationale: input.rationale ?? null,
      requiresApproval: input.requiresApproval ?? env.requireTradeApproval,
      approvedBy: null,
      approvedAt: null,
      rejectedReason: null,
      expiresAt,
      executedOrderId: null,
      metadata: input.metadata ?? {},
    });

    if (!intent.requiresApproval) {
      await this.approveIntent(Number(intent.id), 'system:auto', true);
      return (await this.getIntentById(Number(intent.id))) as TradeIntent;
    }

    return intent;
  }

  async getIntentById(id: number): Promise<TradeIntent | null> {
    return TradeIntent.findByPk(id);
  }

  async listIntents(params?: {
    limit?: number;
    status?: TradeIntentStatus;
    source?: TradeIntentSource;
  }): Promise<TradeIntent[]> {
    const limit = Math.min(Math.max(params?.limit ?? 50, 1), 200);

    return TradeIntent.findAll({
      where: {
        ...(params?.status ? { status: params.status } : {}),
        ...(params?.source ? { source: params.source } : {}),
      },
      order: [['createdAt', 'DESC']],
      limit,
    });
  }

  async approveIntent(id: number, approvedBy: string, force = false): Promise<{
    intent: TradeIntent;
    order: TradeOrder;
  }> {
    const intent = await TradeIntent.findByPk(id);

    if (!intent) {
      throw new ApiError(404, `Trade intent ${id} not found.`);
    }

    if (intent.status === 'EXECUTED') {
      const existingOrder = await TradeOrder.findByPk(intent.executedOrderId ?? 0);
      if (!existingOrder) {
        throw new ApiError(409, 'Intent already executed but linked order is missing.');
      }
      return { intent, order: existingOrder };
    }

    if (intent.status !== 'PENDING_APPROVAL' && !force) {
      throw new ApiError(409, `Intent ${id} is not pending approval.`);
    }

    if (intent.expiresAt && intent.expiresAt.getTime() < Date.now()) {
      intent.status = 'EXPIRED';
      await intent.save();
      throw new ApiError(410, `Intent ${id} has expired.`);
    }

    intent.status = 'APPROVED';
    intent.approvedBy = approvedBy;
    intent.approvedAt = new Date();
    await intent.save();

    try {
      const order = await orderService.placeOrder(intent.side, {
        symbol: intent.symbol,
        instrumentKey: intent.instrumentKey,
        quantity: intent.quantity,
        orderType: intent.orderType,
        product: intent.product,
        validity: intent.validity,
        price: intent.price !== null ? Number(intent.price) : undefined,
        triggerPrice: intent.triggerPrice !== null ? Number(intent.triggerPrice) : undefined,
        tag: intent.tag ?? undefined,
      });

      intent.status = 'EXECUTED';
      intent.executedOrderId = Number(order.id);
      await intent.save();

      if (intent.source === 'STRATEGY') {
        await this.createStrategyPosition(intent, order);
      }

      return {
        intent,
        order,
      };
    } catch (error) {
      intent.status = 'FAILED';
      intent.rejectedReason = error instanceof Error ? error.message : 'Execution failed';
      await intent.save();
      throw error;
    }
  }

  async rejectIntent(id: number, reason: string, rejectedBy: string): Promise<TradeIntent> {
    const intent = await TradeIntent.findByPk(id);

    if (!intent) {
      throw new ApiError(404, `Trade intent ${id} not found.`);
    }

    if (intent.status !== 'PENDING_APPROVAL') {
      throw new ApiError(409, `Intent ${id} is not pending approval.`);
    }

    intent.status = 'REJECTED';
    intent.rejectedReason = `${reason} (by ${rejectedBy})`;
    await intent.save();

    return intent;
  }

  async expireStaleIntents(): Promise<number> {
    const [updated] = await TradeIntent.update(
      {
        status: 'EXPIRED',
      },
      {
        where: {
          status: 'PENDING_APPROVAL',
          expiresAt: {
            [Op.lt]: new Date(),
          },
        },
      },
    );

    return updated;
  }

  private async createStrategyPosition(intent: TradeIntent, order: TradeOrder): Promise<void> {
    const metadata = (intent.metadata ?? {}) as Record<string, unknown>;

    if (metadata.isExitIntent === true) {
      return;
    }
    const entryPrice =
      order.price !== null
        ? Number(order.price)
        : this.toNumber(metadata.entryPrice) ?? this.toNumber(metadata.lastPrice) ?? 0;

    if (entryPrice <= 0) {
      return;
    }

    const stopLossPrice =
      this.toNumber(metadata.stopLossPrice) ??
      this.toNumber(metadata.suggestedStopLoss) ??
      entryPrice * (1 - env.strategyEntryStopLossPct / 100);
    const targetPrice =
      this.toNumber(metadata.targetPrice) ??
      this.toNumber(metadata.suggestedTarget) ??
      entryPrice * (1 + env.strategyProfitTargetPct / 100);

    await StrategyPosition.create({
      symbol: intent.symbol,
      instrumentKey: intent.instrumentKey,
      side: intent.side,
      quantity: intent.quantity,
      entryPrice,
      currentPrice: entryPrice,
      stopLossPrice,
      targetPrice,
      trailActive: false,
      bestPrice: entryPrice,
      status: 'OPEN',
      openedOrderId: Number(order.id),
      closedOrderId: null,
      exitReason: null,
      realizedPnl: null,
      unrealizedPnl: 0,
      metadata,
    });
  }

  private normalizeTradeSide(input: { side?: TradeSide; metadata?: Record<string, unknown> }): TradeSide {
    if (input.side) {
      return input.side;
    }

    const fallback = input.metadata?.side;
    if (fallback === 'SELL') {
      return 'SELL';
    }

    return 'BUY';
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }
}

export const tradeIntentService = new TradeIntentService();
