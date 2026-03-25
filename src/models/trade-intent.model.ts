import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Sequelize,
} from 'sequelize';
import { TradeIntentSource, TradeIntentStatus } from '../types/trading.types';
import { TradeSide } from './trade-order.model';

export class TradeIntent extends Model<
  InferAttributes<TradeIntent, { omit: 'createdAt' | 'updatedAt' }>,
  InferCreationAttributes<TradeIntent, { omit: 'createdAt' | 'updatedAt' }>
> {
  declare id: CreationOptional<number>;
  declare source: TradeIntentSource;
  declare status: TradeIntentStatus;
  declare side: TradeSide;
  declare symbol: string;
  declare instrumentKey: string;
  declare quantity: number;
  declare orderType: string;
  declare product: string;
  declare validity: string;
  declare price: number | null;
  declare triggerPrice: number | null;
  declare tag: string | null;
  declare confidence: number | null;
  declare rationale: string | null;
  declare requiresApproval: boolean;
  declare approvedBy: string | null;
  declare approvedAt: Date | null;
  declare rejectedReason: string | null;
  declare expiresAt: Date | null;
  declare executedOrderId: number | null;
  declare metadata: Record<string, unknown>;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export const initTradeIntentModel = (sequelize: Sequelize): void => {
  TradeIntent.init(
    {
      id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },
      source: {
        type: DataTypes.ENUM('MANUAL', 'STRATEGY'),
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM(
          'PENDING_APPROVAL',
          'APPROVED',
          'REJECTED',
          'EXECUTED',
          'FAILED',
          'EXPIRED',
        ),
        allowNull: false,
        defaultValue: 'PENDING_APPROVAL',
      },
      side: {
        type: DataTypes.ENUM('BUY', 'SELL'),
        allowNull: false,
      },
      symbol: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      instrumentKey: {
        type: DataTypes.STRING,
        allowNull: false,
        field: 'instrument_key',
      },
      quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      orderType: {
        type: DataTypes.STRING,
        allowNull: false,
        field: 'order_type',
      },
      product: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      validity: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      price: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: true,
      },
      triggerPrice: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: true,
        field: 'trigger_price',
      },
      tag: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      confidence: {
        type: DataTypes.DECIMAL(6, 4),
        allowNull: true,
      },
      rationale: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      requiresApproval: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        field: 'requires_approval',
      },
      approvedBy: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'approved_by',
      },
      approvedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'approved_at',
      },
      rejectedReason: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'rejected_reason',
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'expires_at',
      },
      executedOrderId: {
        type: DataTypes.BIGINT,
        allowNull: true,
        field: 'executed_order_id',
      },
      metadata: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
      },
    },
    {
      sequelize,
      tableName: 'trade_intents',
      modelName: 'TradeIntent',
      underscored: true,
      indexes: [
        { fields: ['status'] },
        { fields: ['source', 'created_at'] },
      ],
    },
  );
};
