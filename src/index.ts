import http from 'http';
import app from './app';
import { connectDatabase, dbManager } from './config/database';
import { env } from './config/env';
import { marketDataService } from './services/market-data.service';
import { stockCatalogService } from './services/stock-catalog.service';
import { strategyService } from './services/strategy.service';
import { websocketService } from './services/websocket.service';

const bootstrap = async (): Promise<void> => {
  await connectDatabase(); // also initializes models against whichever DB is active
  await dbManager.sync(); // creates new tables (candles); leaves existing tables untouched
  dbManager.startHealthMonitor();
  await stockCatalogService.ensureSeeded();

  const server = http.createServer(app);

  websocketService.init(server);
  marketDataService.startPolling();
  strategyService.start();

  server.listen(env.port, () => {
    const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';
    console.log(`Backend running on http://${host}:${env.port}`);
  });

  const shutdown = async (): Promise<void> => {
    marketDataService.stopPolling();
    strategyService.stop();
    websocketService.close();
    await dbManager.close();
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
