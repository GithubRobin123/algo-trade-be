import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Sequelize,
} from 'sequelize';
import { NormalizedOptionChainRow } from '../types/upstox.types';

export class OptionChainSnapshot extends Model<
  InferAttributes<OptionChainSnapshot, { omit: 'createdAt' | 'updatedAt' }>,
  InferCreationAttributes<OptionChainSnapshot, { omit: 'createdAt' | 'updatedAt' }>
> {
  declare id: CreationOptional<number>;
  declare symbol: string;
  declare instrumentKey: string;
  declare expiryDate: string | null;
  declare underlyingPrice: number | null;
  declare snapshotTime: Date;
  declare chainRows: NormalizedOptionChainRow[];
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export const initOptionChainSnapshotModel = (sequelize: Sequelize): void => {
  OptionChainSnapshot.init(
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
      expiryDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'expiry_date',
      },
      underlyingPrice: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: true,
        field: 'underlying_price',
      },
      snapshotTime: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'snapshot_time',
      },
      chainRows: {
        type: DataTypes.JSONB,
        allowNull: false,
        field: 'chain_rows',
        defaultValue: [],
      },
    },
    {
      sequelize,
      tableName: 'option_chain_snapshots',
      modelName: 'OptionChainSnapshot',
      underscored: true,
      indexes: [
        {
          fields: ['symbol', 'snapshot_time'],
        },
      ],
    },
  );
};
