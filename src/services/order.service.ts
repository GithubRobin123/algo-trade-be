import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { ApiError } from '../middleware/error.middleware';
import { TradeOrder, TradeSide } from '../models/trade-order.model';
import { PlaceOrderPayload } from '../types/upstox.types';
import { accountService } from './account.service';
import { tokenService } from './token.service';
import { upstoxService } from './upstox.service';

const FILL_POLL_ATTEMPTS = 5;
const FILL_POLL_INTERVAL_MS = 700;

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

    // Paper trading mode: skip wallet/margin check entirely.
    // All trades are simulated for P&L tracking without any real execution.
    if (!env.enableLiveOrders) {
      // For MARKET orders with no price, fetch current LTP so P&L can be tracked
      let paperPrice = input.price ?? null;
      if (paperPrice == null && (input.orderType ?? 'MARKET') === 'MARKET') {
        try {
          const accessToken = await tokenService.getValidAccessToken().catch(() => null);
          if (accessToken) {
            const quote = await upstoxService.getNiftyLtp(accessToken, input.instrumentKey);
            paperPrice = quote.ltp;
          }
        } catch { /* ignore — price stays null */ }
      }

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
        price: paperPrice,
        triggerPrice: input.triggerPrice ?? null,
        status: 'SIMULATED',
        isPaper: true,
        requestPayload: payload,
        responsePayload: { message: 'Paper trading — no real order sent to Upstox.', entryPrice: paperPrice },
        errorMessage: null,
      });
    }

    // Live orders only: enforce wallet/margin check before sending to Upstox
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

    const accessToken = await tokenService.getValidAccessToken();

    let response: Record<string, unknown>;
    try {
      response = await upstoxService.placeOrder(accessToken, payload);
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

    // Accepted by the API ≠ filled: read the real average price and catch RMS rejections
    // (e.g. margin, lot size), so a rejected order never opens or closes a position.
    const providerOrderId = this.extractProviderOrderId(response);
    const fill = providerOrderId ? await this.waitForFinalStatus(accessToken, providerOrderId) : null;
    const rejected = fill?.status === 'rejected' || fill?.status === 'cancelled';

    const order = await TradeOrder.create({
      provider: 'upstox',
      providerOrderId,
      side,
      symbol: input.symbol,
      instrumentKey: input.instrumentKey,
      quantity: input.quantity,
      product: payload.product,
      orderType: payload.order_type,
      validity: payload.validity,
      price: !rejected && fill?.averagePrice ? fill.averagePrice : input.price ?? null,
      triggerPrice: input.triggerPrice ?? null,
      status: rejected ? 'REJECTED' : fill?.status === 'complete' ? 'COMPLETE' : 'PLACED',
      isPaper: false,
      requestPayload: payload,
      responsePayload: response,
      errorMessage: rejected ? fill?.statusMessage ?? `Order ${fill?.status} by Upstox` : null,
    });

    if (rejected) {
      throw new ApiError(400, `Upstox ${fill?.status} the order: ${fill?.statusMessage ?? 'no reason given'}`);
    }

    return order;
  }

  /** Poll order details until complete/rejected/cancelled (MARKET orders settle in ~1s); null if still open. */
  private async waitForFinalStatus(accessToken: string, orderId: string): Promise<{
    status: string;
    averagePrice: number | null;
    statusMessage: string | null;
  } | null> {
    for (let attempt = 0; attempt < FILL_POLL_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, FILL_POLL_INTERVAL_MS));
      try {
        const details = await upstoxService.getOrderDetails(accessToken, orderId);
        const status = details.status?.toLowerCase() ?? '';
        if (status === 'complete' || status === 'rejected' || status === 'cancelled') {
          return { status, averagePrice: details.averagePrice, statusMessage: details.statusMessage };
        }
      } catch { /* keep polling */ }
    }
    return null;
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
