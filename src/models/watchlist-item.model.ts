import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Sequelize,
} from 'sequelize';

export class WatchlistItem extends Model<
  InferAttributes<WatchlistItem, { omit: 'createdAt' | 'updatedAt' }>,
  InferCreationAttributes<WatchlistItem, { omit: 'createdAt' | 'updatedAt' }>
> {
  declare id: CreationOptional<number>;
  declare symbol: string;
  declare instrumentKey: string;
  declare displayName: string;
  declare exchange: string | null;
  declare segment: string | null;
  declare notes: string | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export const initWatchlistItemModel = (sequelize: Sequelize): void => {
  WatchlistItem.init(
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
        unique: true,
        field: 'instrument_key',
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
      notes: {
        type: DataTypes.STRING,
        allowNull: true,
      },
    },
    {
      sequelize,
      tableName: 'watchlist_items',
      modelName: 'WatchlistItem',
      underscored: true,
      indexes: [
        { fields: ['instrument_key'], unique: true },
        { fields: ['created_at'] },
      ],
    },
  );
};
