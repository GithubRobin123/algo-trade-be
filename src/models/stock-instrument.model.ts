import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Sequelize,
} from 'sequelize';

export class StockInstrument extends Model<
  InferAttributes<StockInstrument, { omit: 'createdAt' | 'updatedAt' }>,
  InferCreationAttributes<StockInstrument, { omit: 'createdAt' | 'updatedAt' }>
> {
  declare id: CreationOptional<number>;
  declare instrumentKey: string;
  declare symbol: string;
  declare tradingSymbol: string;
  declare displayName: string;
  declare exchange: string | null;
  declare segment: string | null;
  declare assetClass: string | null;
  declare instrumentType: string | null;
  declare expiryDate: string | null;
  declare strikePrice: number | null;
  declare optionType: string | null;
  declare lotSize: number | null;
  declare tickSize: number | null;
  declare isTradable: boolean;
  declare rawPayload: Record<string, unknown> | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export const initStockInstrumentModel = (sequelize: Sequelize): void => {
  StockInstrument.init(
    {
      id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },
      instrumentKey: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        field: 'instrument_key',
      },
      symbol: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      tradingSymbol: {
        type: DataTypes.STRING,
        allowNull: false,
        field: 'trading_symbol',
      },
      displayName: {
        type: DataTypes.STRING,
        allowNull: false,
        field: 'display_name',
      },
      exchange: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      segment: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      assetClass: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'asset_class',
      },
      instrumentType: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'instrument_type',
      },
      expiryDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'expiry_date',
      },
      strikePrice: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: true,
        field: 'strike_price',
      },
      optionType: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'option_type',
      },
      lotSize: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'lot_size',
      },
      tickSize: {
        type: DataTypes.DECIMAL(14, 6),
        allowNull: true,
        field: 'tick_size',
      },
      isTradable: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        field: 'is_tradable',
      },
      rawPayload: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'raw_payload',
      },
    },
    {
      sequelize,
      tableName: 'stock_instruments',
      modelName: 'StockInstrument',
      underscored: true,
      indexes: [
        { fields: ['instrument_key'], unique: true },
        { fields: ['symbol'] },
        { fields: ['exchange', 'segment'] },
      ],
    },
  );
};
