import http from 'http';
import app from './app';
import { connectDatabase, sequelize } from './config/database';
import { env } from './config/env';
import { initModels } from './models';
import { marketDataService } from './services/market-data.service';
import { stockCatalogService } from './services/stock-catalog.service';
import { strategyService } from './services/strategy.service';
import { websocketService } from './services/websocket.service';

const bootstrap = async (): Promise<void> => {
  initModels();
  await connectDatabase();
  await sequelize.sync();
  await stockCatalogService.ensureSeeded();

  const server = http.createServer(app);

  websocketService.init(server);
  marketDataService.startPolling();
  strategyService.start();

  server.listen(env.port, () => {
    console.log(`Backend running on http://localhost:${env.port}`);
  });

  const shutdown = async (): Promise<void> => {
    marketDataService.stopPolling();
    strategyService.stop();
    websocketService.close();
    await sequelize.close();
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', () => {
    void shutdown();
  });

  process.on('SIGTERM', () => {
    void shutdown();
  });
};

void bootstrap().catch((error) => {
  console.error('Failed to bootstrap backend:', error);
  process.exit(1);
});
