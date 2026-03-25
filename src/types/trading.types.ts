export type TradeIntentSource = 'MANUAL' | 'STRATEGY';
export type TradeIntentStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXECUTED'
  | 'FAILED'
  | 'EXPIRED';

export type PositionStatus = 'OPEN' | 'CLOSED';

export type AssetClass = 'INDEX' | 'COMMODITY' | 'STOCK';

export interface UnderlyingInstrument {
  symbol: string;
  displayName: string;
  instrumentKey: string;
  optionChainInstrumentKey: string;
  defaultLotSize: number;
  assetClass: AssetClass;
  supportsOptions: boolean;
  intradayAllowed: boolean;
}

export type StrategySource = 'SMA_PCR' | 'VWAP_BOUNCE' | 'EMA_CROSS';

export interface StrategySignal {
  source: StrategySource;
  side: 'BUY' | 'SELL';
  symbol: string;
  instrumentKey: string;
  quantity: number;
  confidence: number;
  rationale: string;
  entryPrice: number;
  suggestedStopLoss: number;
  suggestedTarget: number;
  metadata: Record<string, unknown>;
}

export interface StrategyRiskSnapshot {
  tradeCountToday: number;
  dailyPnl: number;
  dailyLossLimit: number;
  blocked: boolean;
  blockReason: string | null;
}
