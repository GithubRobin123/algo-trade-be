import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Sequelize,
} from 'sequelize';

/**
 * Candle — 5-minute OHLCV bar aggregated from raw market_ticks.
 *
 * candleStart = floor of tick timestamps to nearest 5-min boundary in IST.
 * e.g., ticks at 09:18:05, 09:19:30 → candleStart = 09:15:00 IST.
 *
 * dayHigh / dayLow / prevClose come from Upstox full-quote OHLC (stored in
 * raw_payload once the polling was switched to the full-quote endpoint).
 * They are null for ticks recorded before that switch.
 *
 * vix = India VIX fetched alongside the Nifty quote (when available).
 */
export class Candle extends Model<
  InferAttributes<Candle, { omit: 'createdAt' }>,
  InferCreationAttributes<Candle, { omit: 'createdAt' }>
> {
  declare id: CreationOptional<number>;
  declare symbol: string;
  declare instrumentKey: string;
  declare candleStart: Date;       // 5-min boundary in UTC (corresponds to IST window)
  declare open: number;
  declare high: number;
  declare low: number;
  declare close: number;
  declare volume: number | null;   // null when upstream LTP API lacks volume
  declare tickCount: number;
  declare dayHigh: number | null;  // session high from Upstox OHLC
  declare dayLow: number | null;   // session low from Upstox OHLC
  declare prevClose: number | null; // previous trading day's close
  declare vix: number | null;      // India VIX at this candle
  declare readonly createdAt: Date;
}

export const initCandleModel = (sequelize: Sequelize): void => {
  Candle.init(
    {
      id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },
      symbol: {
        type: DataTypes.STRING(30),
        allowNull: false,
      },
      instrumentKey: {
        type: DataTypes.STRING,
        allowNull: false,
        field: 'instrument_key',
      },
      candleStart: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'candle_start',
      },
      open: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: false,
      },
      high: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: false,
      },
      low: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: false,
      },
      close: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: false,
      },
      volume: {
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      tickCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'tick_count',
      },
      dayHigh: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: true,
        field: 'day_high',
      },
      dayLow: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: true,
        field: 'day_low',
      },
      prevClose: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: true,
        field: 'prev_close',
      },
      vix: {
        type: DataTypes.DECIMAL(8, 4),
        allowNull: true,
      },
    },
    {
      sequelize,
      tableName: 'candles',
      modelName: 'Candle',
      underscored: true,
      updatedAt: false,
      indexes: [
        {
          unique: true,
          fields: ['instrument_key', 'candle_start'],
          name: 'candles_instrument_key_candle_start_unique',
        },
        {
          fields: ['symbol', 'candle_start'],
        },
      ],
    },
  );
};
