import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Sequelize,
} from 'sequelize';

export class OAuthToken extends Model<
  InferAttributes<OAuthToken, { omit: 'createdAt' | 'updatedAt' }>,
  InferCreationAttributes<OAuthToken, { omit: 'createdAt' | 'updatedAt' }>
> {
  declare id: CreationOptional<number>;
  declare provider: string;
  declare accessToken: string;
  declare refreshToken: string | null;
  declare expiresAt: Date | null;
  declare tokenType: string | null;
  declare scope: string | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export const initOAuthTokenModel = (sequelize: Sequelize): void => {
  OAuthToken.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      provider: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
      },
      accessToken: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'access_token',
      },
      refreshToken: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'refresh_token',
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'expires_at',
      },
      tokenType: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'token_type',
      },
      scope: {
        type: DataTypes.STRING,
        allowNull: true,
      },
    },
    {
      sequelize,
      tableName: 'oauth_tokens',
      modelName: 'OAuthToken',
      underscored: true,
    },
  );
};
