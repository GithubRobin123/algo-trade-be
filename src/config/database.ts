import { Sequelize } from 'sequelize';
import { env, isProduction } from './env';

export const sequelize = new Sequelize(env.databaseUrl, {
  dialect: 'postgres',
  logging: env.dbLogging ? console.log : false,
  dialectOptions: isProduction
    ? {
        ssl: {
          require: true,
          rejectUnauthorized: false,
        },
      }
    : undefined,
});

export const connectDatabase = async (): Promise<void> => {
  await sequelize.authenticate();
};
