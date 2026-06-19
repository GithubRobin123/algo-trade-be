import { sequelize } from '../config/database';
import { initCandleModel } from './candle.model';
import { initMarketTickModel } from './market-tick.model';
import { initOAuthTokenModel } from './oauth-token.model';
import { initOptionChainSnapshotModel } from './option-chain-snapshot.model';
import { initPositionPnlTickModel } from './position-pnl-tick.model';
import { initStrategyDecisionLogModel } from './strategy-decision-log.model';
import { initStrategyPositionModel } from './strategy-position.model';
import { initTradeEventLogModel } from './trade-event-log.model';
import { initStockInstrumentModel } from './stock-instrument.model';
import { initTradeIntentModel } from './trade-intent.model';
import { initTradeOrderModel } from './trade-order.model';
import { initWatchlistItemModel } from './watchlist-item.model';

export const initModels = (): void => {
  initOAuthTokenModel(sequelize);
  initMarketTickModel(sequelize);
  initCandleModel(sequelize);
  initOptionChainSnapshotModel(sequelize);
  initTradeOrderModel(sequelize);
  initTradeIntentModel(sequelize);
  initStrategyPositionModel(sequelize);
  initStockInstrumentModel(sequelize);
  initWatchlistItemModel(sequelize);
  initStrategyDecisionLogModel(sequelize);
  initPositionPnlTickModel(sequelize);
  initTradeEventLogModel(sequelize);
};
