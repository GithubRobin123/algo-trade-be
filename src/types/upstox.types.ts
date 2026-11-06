export interface UpstoxOAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export interface UpstoxLtpResult {
  instrumentKey: string;
  symbol: string;
  ltp: number;
  timestamp: string;
  raw: Record<string, unknown>;
}

export interface NormalizedOptionChainRow {
  strikePrice: number;
  callLtp: number | null;
  callOi: number | null;
  putLtp: number | null;
  putOi: number | null;
  iv: number | null;
  callInstrumentKey: string | null;
  putInstrumentKey: string | null;
  // Stored from v2.3 (Nov 2026) for spread, order-book imbalance and change-in-OI research; absent in
  // older snapshots. Upstox /v2/option/chain market_data: bid_price, bid_qty, ask_price, ask_qty,
  // volume, prev_oi; option_greeks: delta.
  callBid?: number | null;
  callBidQty?: number | null;
  callAsk?: number | null;
  callAskQty?: number | null;
  callVolume?: number | null;
  callPrevOi?: number | null;
  callDelta?: number | null;
  putBid?: number | null;
  putBidQty?: number | null;
  putAsk?: number | null;
  putAskQty?: number | null;
  putVolume?: number | null;
  putPrevOi?: number | null;
  putDelta?: number | null;
}

export interface NormalizedOptionChain {
  symbol: string;
  instrumentKey: string;
  underlyingPrice: number | null;
  expiryDate: string | null;
  snapshotTime: string;
  rows: NormalizedOptionChainRow[];
}

export interface PlaceOrderPayload {
  quantity: number;
  product: string;
  validity: string;
  price?: number;
  tag?: string;
  instrument_token: string;
  order_type: string;
  transaction_type: 'BUY' | 'SELL';
  trigger_price?: number;
  disclosed_quantity?: number;
}

export interface UpstoxFundsSummary {
  availableMargin: number | null;
  usedMargin: number | null;
  payin: number | null;
  span: number | null;
  exposure: number | null;
  adhoc: number | null;
  notionalCash: number | null;
}

export interface UpstoxAccountProfile {
  userId: string | null;
  email: string | null;
  userName: string | null;
  broker: string | null;
}

export interface UpstoxHoldingRecord {
  instrumentKey: string;
  tradingSymbol: string;
  exchange: string | null;
  quantity: number;
  averagePrice: number | null;
  lastPrice: number | null;
  pnl: number | null;
  product: string | null;
}

export interface UpstoxPositionRecord {
  instrumentKey: string;
  tradingSymbol: string;
  exchange: string | null;
  quantity: number;
  averagePrice: number | null;
  lastPrice: number | null;
  pnl: number | null;
  product: string | null;
}
