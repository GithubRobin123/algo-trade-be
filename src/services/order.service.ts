import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { ApiError } from '../middleware/error.middleware';
import { TradeOrder, TradeSide } from '../models/trade-order.model';
import { PlaceOrderPayload } from '../types/upstox.types';
import { accountService } from './account.service';
import { tokenService } from './token.service';
import { upstoxService } from './upstox.service';

export interface PlaceOrderRequest {
  symbol: string;
  instrumentKey: string;
  quantity: number;
  orderType?: string;
  product?: string;
  validity?: string;
  price?: number;
  triggerPrice?: number;
  disclosedQuantity?: number;
  tag?: string;
}

class OrderService {
  async placeOrder(side: TradeSide, input: PlaceOrderRequest): Promise<TradeOrder> {
    const payload: PlaceOrderPayload = {
      instrument_token: input.instrumentKey,
      transaction_type: side,
      quantity: input.quantity,
      order_type: input.orderType ?? 'MARKET',
      product: input.product ?? env.defaultOrderProduct,
      validity: input.validity ?? env.defaultOrderValidity,
      ...(input.price !== undefined ? { price: input.price } : {}),
      ...(input.triggerPrice !== undefined ? { trigger_price: input.triggerPrice } : {}),
      ...(input.disclosedQuantity !== undefined
        ? { disclosed_quantity: input.disclosedQuantity }
        : {}),
      ...(input.tag ? { tag: input.tag } : {}),
    };

    const orderCheck = await accountService.checkOrder(side, {
      instrumentKey: input.instrumentKey,
      quantity: input.quantity,
      price: input.price,
      orderType: input.orderType,
      product: input.product,
    });

    if (!orderCheck.allowed) {
      throw new ApiError(400, orderCheck.reason ?? 'Order blocked by wallet/holding validation.');
    }

    if (!env.enableLiveOrders) {
      return TradeOrder.create({
        provider: 'upstox',
        providerOrderId: `paper-${randomUUID()}`,
        side,
        symbol: input.symbol,
        instrumentKey: input.instrumentKey,
        quantity: input.quantity,
        product: payload.product,
        orderType: payload.order_type,
        validity: payload.validity,
        price: input.price ?? null,
        triggerPrice: input.triggerPrice ?? null,
        status: 'SIMULATED',
        isPaper: true,
        requestPayload: payload,
        responsePayload: {
          message: 'Paper trading mode active. Set ENABLE_LIVE_ORDERS=true to place real orders on Upstox.',
          orderCheck,
        },
        errorMessage: null,
      });
    }

    const accessToken = await tokenService.getValidAccessToken();

    try {
      const response = await upstoxService.placeOrder(accessToken, payload);
      const providerOrderId = this.extractProviderOrderId(response);

      return TradeOrder.create({
        provider: 'upstox',
        providerOrderId,
        side,
        symbol: input.symbol,
        instrumentKey: input.instrumentKey,
        quantity: input.quantity,
        product: payload.product,
        orderType: payload.order_type,
        validity: payload.validity,
        price: input.price ?? null,
        triggerPrice: input.triggerPrice ?? null,
        status: 'PLACED',
        isPaper: false,
        requestPayload: payload,
        responsePayload: response,
        errorMessage: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Order placement failed';

      await TradeOrder.create({
        provider: 'upstox',
        providerOrderId: null,
        side,
        symbol: input.symbol,
        instrumentKey: input.instrumentKey,
        quantity: input.quantity,
        product: payload.product,
        orderType: payload.order_type,
        validity: payload.validity,
        price: input.price ?? null,
        triggerPrice: input.triggerPrice ?? null,
        status: 'FAILED',
        isPaper: false,
        requestPayload: payload,
        responsePayload: null,
        errorMessage: message,
      });

      throw new ApiError(502, message);
    }
  }

  async listOrders(limit: number): Promise<TradeOrder[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 200);

    return TradeOrder.findAll({
      order: [['createdAt', 'DESC']],
      limit: safeLimit,
    });
  }

  private extractProviderOrderId(response: Record<string, unknown>): string | null {
    const data = (response.data as Record<string, unknown> | undefined) ?? response;

    const directOrderId =
      (data.order_id as string | undefined) ||
      (data.orderId as string | undefined) ||
      (response.order_id as string | undefined) ||
      (response.orderId as string | undefined);

    return directOrderId ?? null;
  }
}

export const orderService = new OrderService();
