import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Sequelize,
} from 'sequelize';
import { PositionStatus } from '../types/trading.types';
import { TradeSide } from './trade-order.model';

export class StrategyPosition extends Model<
  InferAttributes<StrategyPosition, { omit: 'createdAt' | 'updatedAt' }>,
  InferCreationAttributes<StrategyPosition, { omit: 'createdAt' | 'updatedAt' }>
> {
  declare id: CreationOptional<number>;
  declare symbol: string;
  declare instrumentKey: string;
  declare side: TradeSide;
  declare quantity: number;
  declare entryPrice: number;
  declare currentPrice: number | null;
  declare stopLossPrice: number;
  declare targetPrice: number;
  declare trailActive: boolean;
  declare bestPrice: number;
  declare status: PositionStatus;
  declare openedOrderId: number | null;
  declare closedOrderId: number | null;
  declare exitReason: string | null;
  declare realizedPnl: number | null;
  declare unrealizedPnl: number | null;
  declare metadata: Record<string, unknown>;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export const initStrategyPositionModel = (sequelize: Sequelize): void => {
  StrategyPosition.init(
    {
      id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
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
      side: {
        type: DataTypes.ENUM('BUY', 'SELL'),
        allowNull: false,
      },
      quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      entryPrice: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: false,
        field: 'entry_price',
      },
      currentPrice: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: true,
        field: 'current_price',
      },
      stopLossPrice: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: false,
        field: 'stop_loss_price',
      },
      targetPrice: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: false,
        field: 'target_price',
      },
      trailActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'trail_active',
      },
      bestPrice: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: false,
        field: 'best_price',
      },
      status: {
        type: DataTypes.ENUM('OPEN', 'CLOSED'),
        allowNull: false,
        defaultValue: 'OPEN',
      },
      openedOrderId: {
        type: DataTypes.BIGINT,
        allowNull: true,
        field: 'opened_order_id',
      },
      closedOrderId: {
        type: DataTypes.BIGINT,
        allowNull: true,
        field: 'closed_order_id',
      },
      exitReason: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'exit_reason',
      },
      realizedPnl: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: true,
        field: 'realized_pnl',
      },
      unrealizedPnl: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: true,
        field: 'unrealized_pnl',
      },
      metadata: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
      },
    },
    {
      sequelize,
      tableName: 'strategy_positions',
      modelName: 'StrategyPosition',
      underscored: true,
      indexes: [
        { fields: ['status'] },
        { fields: ['symbol', 'status'] },
      ],
    },
  );
};
