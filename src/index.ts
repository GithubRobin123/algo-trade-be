import http from 'http';
import app from './app';
import { connectDatabase, dbManager } from './config/database';
import { env } from './config/env';
import { marketDataService } from './services/market-data.service';
import { marketStreamService } from './services/market-stream.service';
import { stockCatalogService } from './services/stock-catalog.service';
import { strategyService } from './services/strategy.service';
import { tokenRenewalService } from './services/token-renewal.service';
import { websocketService } from './services/websocket.service';

const bootstrap = async (): Promise<void> => {
  await connectDatabase(); // also initializes models against whichever DB is active
  await dbManager.sync(); // creates new tables (candles); leaves existing tables untouched
  dbManager.startHealthMonitor();
  await stockCatalogService.ensureSeeded();

  const server = http.createServer(app);

  websocketService.init(server);
  if (env.backgroundJobsEnabled) {
    marketDataService.startPolling();
    marketStreamService.start();
    strategyService.start();
    tokenRenewalService.start();
  } else {
    console.warn('[Boot] BACKGROUND_JOBS_ENABLED=false: API only (no market polling, strategy, execution monitor or token requests).');
  }

  server.listen(env.port, () => {
    const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';
    console.log(`Backend running on http://${host}:${env.port}`);
  });

  const shutdown = async (): Promise<void> => {
    marketDataService.stopPolling();
    marketStreamService.stop();
    strategyService.stop();
    tokenRenewalService.stop();
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
