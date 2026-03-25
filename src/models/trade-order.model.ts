import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Sequelize,
} from 'sequelize';

export type TradeSide = 'BUY' | 'SELL';

export class TradeOrder extends Model<
  InferAttributes<TradeOrder, { omit: 'createdAt' | 'updatedAt' }>,
  InferCreationAttributes<TradeOrder, { omit: 'createdAt' | 'updatedAt' }>
> {
  declare id: CreationOptional<number>;
  declare provider: string;
  declare providerOrderId: string | null;
  declare side: TradeSide;
  declare symbol: string;
  declare instrumentKey: string;
  declare quantity: number;
  declare product: string;
  declare orderType: string;
  declare validity: string;
  declare price: number | null;
  declare triggerPrice: number | null;
  declare status: string;
  declare isPaper: boolean;
  declare requestPayload: unknown;
  declare responsePayload: unknown | null;
  declare errorMessage: string | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export const initTradeOrderModel = (sequelize: Sequelize): void => {
  TradeOrder.init(
    {
      id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },
      provider: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'upstox',
      },
      providerOrderId: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'provider_order_id',
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
      product: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      orderType: {
        type: DataTypes.STRING,
        allowNull: false,
        field: 'order_type',
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
      status: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'PENDING',
      },
      isPaper: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        field: 'is_paper',
      },
      requestPayload: {
        type: DataTypes.JSONB,
        allowNull: false,
        field: 'request_payload',
      },
      responsePayload: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'response_payload',
      },
      errorMessage: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'error_message',
      },
    },
    {
      sequelize,
      tableName: 'trade_orders',
      modelName: 'TradeOrder',
      underscored: true,
      indexes: [
        {
          fields: ['created_at'],
        },
      ],
    },
  );
};
