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

import { DataTypes, InferAttributes, InferCreationAttributes, Model, Sequelize, CreationOptional } from 'sequelize';
import { sequelize } from '../config/database';
import { websocketService } from './websocket.service';

// ── Event types ────────────────────────────────────────────────────────────
export type TradeEventType =
  | 'SIGNAL_GENERATED'       // strategy produced a signal
  | 'SIGNAL_REJECTED'        // signal failed rule/AI/confidence gate
  | 'INTENT_CREATED'         // TradeIntent row created, pending approval
  | 'INTENT_APPROVED'        // intent approved (by user or auto)
  | 'INTENT_REJECTED'        // intent rejected by user
  | 'INTENT_EXPIRED'         // intent expired before action
  | 'ORDER_PLACED'           // order sent to Upstox (or paper)
  | 'ORDER_FAILED'           // Upstox rejected the order
  | 'POSITION_OPENED'        // StrategyPosition created
  | 'POSITION_SL_UPDATED'    // trailing SL moved up
  | 'POSITION_TRAIL_STARTED' // trailing SL activated (profit threshold hit)
  | 'POSITION_CLOSED'        // position exited (SL / target / manual / EOD)
  | 'EOD_SQUAREOFF_START'    // EOD square-off sweep initiated
  | 'EOD_SQUAREOFF_DONE'     // EOD square-off completed
  | 'RISK_BLOCKED'           // daily loss / trade count limit hit
  | 'SYSTEM_ERROR';          // unexpected error in strategy cycle

export interface TradeEvent {
  type: TradeEventType;
  underlying: string;          // 'NIFTY' | 'SENSEX' etc.
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
  strategy?: string;           // 'SMA_PCR' | 'VWAP_BOUNCE' | 'EMA_CROSS'
  metadata?: Record<string, unknown>;
}

// ── Sequelize model ────────────────────────────────────────────────────────
export class TradeEventLog extends Model<
  InferAttributes<TradeEventLog, { omit: 'createdAt' }>,
  InferCreationAttributes<TradeEventLog, { omit: 'createdAt' }>
> {
  declare id: CreationOptional<number>;
  declare eventType: TradeEventType;
  declare underlying: string;
  declare positionId: number | null;
  declare intentId: number | null;
  declare orderId: number | null;
  declare symbol: string | null;
  declare side: string | null;
  declare price: number | null;
  declare quantity: number | null;
  declare pnl: number | null;
  declare pnlPct: number | null;
  declare stopLossPrice: number | null;
  declare reason: string | null;
  declare strategy: string | null;
  declare payload: Record<string, unknown>;
  declare readonly createdAt: Date;
}

export const initTradeEventLogModel = (seq: Sequelize): void => {
  TradeEventLog.init(
    {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      eventType: { type: DataTypes.STRING(50), allowNull: false, field: 'event_type' },
      underlying: { type: DataTypes.STRING(20), allowNull: false },
      positionId: { type: DataTypes.BIGINT, allowNull: true, field: 'position_id' },
      intentId: { type: DataTypes.BIGINT, allowNull: true, field: 'intent_id' },
      orderId: { type: DataTypes.BIGINT, allowNull: true, field: 'order_id' },
      symbol: { type: DataTypes.STRING(50), allowNull: true },
      side: { type: DataTypes.STRING(10), allowNull: true },
      price: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
      quantity: { type: DataTypes.INTEGER, allowNull: true },
      pnl: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
      pnlPct: { type: DataTypes.DECIMAL(8, 4), allowNull: true, field: 'pnl_pct' },
      stopLossPrice: { type: DataTypes.DECIMAL(14, 4), allowNull: true, field: 'stop_loss_price' },
      reason: { type: DataTypes.TEXT, allowNull: true },
      strategy: { type: DataTypes.STRING(50), allowNull: true },
      payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    },
    {
      sequelize: seq,
      tableName: 'trade_event_logs',
      modelName: 'TradeEventLog',
      underscored: true,
      updatedAt: false,
      indexes: [
        { fields: ['event_type'] },
        { fields: ['underlying', 'created_at'] },
        { fields: ['position_id'] },
        { fields: ['created_at'] },
      ],
    },
  );
};

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
