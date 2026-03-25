import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Sequelize,
} from 'sequelize';

/**
 * PositionPnlTick — periodic PnL snapshots for open positions.
 * Written every monitor cycle (every ~5-20 sec) so the UI can show
 * a live PnL chart for any open trade without hitting Upstox rate limits.
 */
export class PositionPnlTick extends Model<
  InferAttributes<PositionPnlTick, { omit: 'createdAt' }>,
  InferCreationAttributes<PositionPnlTick, { omit: 'createdAt' }>
> {
  declare id: CreationOptional<number>;
  declare positionId: number;
  declare currentPremium: number;
  declare unrealizedPnl: number;
  declare unrealizedPnlPct: number;
  declare stopLossPrice: number;
  declare highWaterMark: number;
  declare trailActive: boolean;
  declare readonly createdAt: Date;
}

export const initPositionPnlTickModel = (sequelize: Sequelize): void => {
  PositionPnlTick.init(
    {
      id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },
      positionId: {
        type: DataTypes.BIGINT,
        allowNull: false,
        field: 'position_id',
      },
      currentPremium: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: false,
        field: 'current_premium',
      },
      unrealizedPnl: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: false,
        field: 'unrealized_pnl',
      },
      unrealizedPnlPct: {
        type: DataTypes.DECIMAL(8, 4),
        allowNull: false,
        field: 'unrealized_pnl_pct',
      },
      stopLossPrice: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: false,
        field: 'stop_loss_price',
      },
      highWaterMark: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: false,
        field: 'high_water_mark',
      },
      trailActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'trail_active',
      },
    },
    {
      sequelize,
      tableName: 'position_pnl_ticks',
      modelName: 'PositionPnlTick',
      underscored: true,
      updatedAt: false,
      indexes: [
        { fields: ['position_id', 'created_at'] },
      ],
    },
  );
};
