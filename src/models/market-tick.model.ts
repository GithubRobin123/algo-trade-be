import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Sequelize,
} from 'sequelize';

export class MarketTick extends Model<
  InferAttributes<MarketTick, { omit: 'createdAt' | 'updatedAt' }>,
  InferCreationAttributes<MarketTick, { omit: 'createdAt' | 'updatedAt' }>
> {
  declare id: CreationOptional<number>;
  declare symbol: string;
  declare instrumentKey: string;
  declare ltp: number;
  declare sourceTimestamp: Date;
  declare rawPayload: Record<string, unknown> | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export const initMarketTickModel = (sequelize: Sequelize): void => {
  MarketTick.init(
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
      ltp: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: false,
      },
      sourceTimestamp: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'source_timestamp',
      },
      rawPayload: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'raw_payload',
      },
    },
    {
      sequelize,
      tableName: 'market_ticks',
      modelName: 'MarketTick',
      underscored: true,
      indexes: [
        {
          fields: ['symbol', 'source_timestamp'],
        },
      ],
    },
  );
};
