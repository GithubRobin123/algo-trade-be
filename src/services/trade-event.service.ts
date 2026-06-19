/**
 * trade-event.service.ts
 *
 * Central event bus for the trading system.
 * Every meaningful state change — signal generated, intent created,
 * order placed, position opened, SL updated, position closed — flows
 * through here. Two things happen for every event:
 *   1. It is broadcast over WebSocket so the dashboard updates live.
 *   2. It is written to the trade_events table for full audit trail.
 *
 * The rest of the system just calls `tradeEventService.emit(...)` and
 * doesn't need to know about WS or DB details.
 */

import { TradeEventLog, TradeEventType, initTradeEventLogModel } from '../models/trade-event-log.model';
import { websocketService } from './websocket.service';

export { TradeEventLog, TradeEventType, initTradeEventLogModel };

export interface TradeEvent {
  type: TradeEventType;
  underlying: string;
  positionId?: number;
  intentId?: number;
  orderId?: number;
  symbol?: string;
  side?: string;
  price?: number;
  quantity?: number;
  pnl?: number;
  pnlPct?: number;
  stopLossPrice?: number;
  reason?: string;
  strategy?: string;
  metadata?: Record<string, unknown>;
}

// ── Service ────────────────────────────────────────────────────────────────
class TradeEventService {
  /**
   * Emit a trade event. Writes to DB and broadcasts via WebSocket.
   * Never throws — trading logic must never fail because of event logging.
   */
  async emit(event: TradeEvent): Promise<void> {
    // 1. Broadcast immediately over WebSocket (dashboard updates live)
    websocketService.broadcast('trade_event', {
      type: event.type,
      underlying: event.underlying,
      positionId: event.positionId ?? null,
      intentId: event.intentId ?? null,
      symbol: event.symbol ?? null,
      side: event.side ?? null,
      price: event.price ?? null,
      pnl: event.pnl ?? null,
      pnlPct: event.pnlPct ?? null,
      stopLossPrice: event.stopLossPrice ?? null,
      reason: event.reason ?? null,
      strategy: event.strategy ?? null,
      ts: new Date().toISOString(),
    });

    // 2. Persist to DB for audit trail
    try {
      await TradeEventLog.create({
        eventType: event.type,
        underlying: event.underlying,
        positionId: event.positionId ?? null,
        intentId: event.intentId ?? null,
        orderId: event.orderId ?? null,
        symbol: event.symbol ?? null,
        side: event.side ?? null,
        price: event.price ?? null,
        quantity: event.quantity ?? null,
        pnl: event.pnl ?? null,
        pnlPct: event.pnlPct ?? null,
        stopLossPrice: event.stopLossPrice ?? null,
        reason: event.reason ?? null,
        strategy: event.strategy ?? null,
        payload: event.metadata ?? {},
      });
    } catch (err) {
      process.stderr.write('[TradeEvent] DB write failed: ' + String(err) + '\n');
    }
  }

  /** Fetch recent events for the dashboard feed */
  async getRecentEvents(underlying?: string, limit = 100): Promise<TradeEventLog[]> {
    const where: Record<string, unknown> = {};
    if (underlying) where['underlying'] = underlying;
    return TradeEventLog.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: Math.min(limit, 500),
    });
  }

  /** Get all events for a specific position (full lifecycle) */
  async getPositionEvents(positionId: number): Promise<TradeEventLog[]> {
    return TradeEventLog.findAll({
      where: { positionId },
      order: [['createdAt', 'ASC']],
    });
  }
}

export const tradeEventService = new TradeEventService();
