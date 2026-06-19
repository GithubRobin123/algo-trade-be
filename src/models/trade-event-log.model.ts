import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Sequelize,
} from 'sequelize';

export type TradeEventType =
  | 'SIGNAL_GENERATED'
  | 'SIGNAL_REJECTED'
  | 'INTENT_CREATED'
  | 'INTENT_APPROVED'
  | 'INTENT_REJECTED'
  | 'INTENT_EXPIRED'
  | 'ORDER_PLACED'
  | 'ORDER_FAILED'
  | 'POSITION_OPENED'
  | 'POSITION_SL_UPDATED'
  | 'POSITION_TRAIL_STARTED'
  | 'POSITION_CLOSED'
  | 'EOD_SQUAREOFF_START'
  | 'EOD_SQUAREOFF_DONE'
  | 'RISK_BLOCKED'
  | 'SYSTEM_ERROR';

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

export const initTradeEventLogModel = (sequelize: Sequelize): void => {
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
      sequelize,
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
