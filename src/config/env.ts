import path from 'path';
import dotenv from 'dotenv';

const envFilePath = path.resolve(__dirname, '../../.env');
const dotenvResult = dotenv.config({
  path: envFilePath,
  override: true,
});

export const envMeta = {
  envFilePath,
  envLoadedFromFile: !dotenvResult.error,
  processCwd: process.cwd(),
  pid: process.pid,
} as const;

const getString = (key: string, fallback?: string): string => {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value.trim();
};

const getNumber = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a number. Received: ${raw}`);
  }

  return parsed;
};

const getBoolean = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  return raw.toLowerCase() === 'true';
};

export const env = {
  nodeEnv: getString('NODE_ENV', 'development'),
  port: getNumber('PORT', 4000),
  frontendUrl: getString('FRONTEND_URL', 'http://localhost:5173'),
  databaseUrl: getString('DATABASE_URL', 'postgres://upstox:upstox@localhost:5432/upstox_trading'),
  dbLogging: getBoolean('DB_LOGGING', false),

  upstoxApiBaseUrl: getString('UPSTOX_API_BASE_URL', 'https://api.upstox.com'),
  upstoxClientId: getString('UPSTOX_CLIENT_ID', ''),
  upstoxClientSecret: getString('UPSTOX_CLIENT_SECRET', ''),
  upstoxRedirectUri: getString('UPSTOX_REDIRECT_URI', ''),
  upstoxAccessToken: getString('UPSTOX_ACCESS_TOKEN', ''),
  upstoxAccessTokenExpiresAt: getString('UPSTOX_ACCESS_TOKEN_EXPIRES_AT', ''),

  niftyInstrumentKey: getString('NIFTY_INSTRUMENT_KEY', 'NSE_INDEX|Nifty 50'),
  optionChainInstrumentKey: getString('OPTION_CHAIN_INSTRUMENT_KEY', 'NSE_INDEX|Nifty 50'),
  optionChainExpiryDate: getString('OPTION_CHAIN_EXPIRY_DATE', ''),
  marketPollIntervalMs: getNumber('MARKET_POLL_INTERVAL_MS', 5000),
  marketHistoryLimit: getNumber('MARKET_HISTORY_LIMIT', 500),

  strategyEnabled: getBoolean('STRATEGY_ENABLED', true),
  strategyScanIntervalMs: getNumber('STRATEGY_SCAN_INTERVAL_MS', 20000),
  strategyMaxAutoTradesPerDay: getNumber('STRATEGY_MAX_AUTO_TRADES_PER_DAY', 2),
  strategyDailyMaxLossPct: getNumber('STRATEGY_DAILY_MAX_LOSS_PCT', 5),
  strategyCapital: getNumber('STRATEGY_CAPITAL', 100000),
  strategyProfitTargetPct: getNumber('STRATEGY_PROFIT_TARGET_PCT', 50),
  strategyEntryStopLossPct: getNumber('STRATEGY_ENTRY_STOP_LOSS_PCT', 20),
  strategyTrailActivationPct: getNumber('STRATEGY_TRAIL_ACTIVATION_PCT', 8),
  strategyTrailOffsetPct: getNumber('STRATEGY_TRAIL_OFFSET_PCT', 3),
  strategyConfidenceThreshold: getNumber('STRATEGY_CONFIDENCE_THRESHOLD', 0.7),

  supportedUnderlyingsJson: getString('SUPPORTED_UNDERLYINGS_JSON', ''),
  defaultUnderlyingSymbol: getString('DEFAULT_UNDERLYING_SYMBOL', 'NIFTY'),
  requireTradeApproval: getBoolean('REQUIRE_TRADE_APPROVAL', true),

  enableLiveOrders: getBoolean('ENABLE_LIVE_ORDERS', false),
  defaultOrderProduct: getString('DEFAULT_ORDER_PRODUCT', 'D'),
  defaultOrderValidity: getString('DEFAULT_ORDER_VALIDITY', 'DAY'),

  // ── AI Decision Engine ─────────────────────────────────────────────────
  // Set AI_PROVIDER to 'claude' | 'openai' | 'gemini' | 'none'
  // 'none' = rule-based only (free, fastest, use for backtesting)
  aiProvider: getString('AI_PROVIDER', 'none'),
  aiApiKey: getString('AI_API_KEY', ''),
  aiTimeoutMs: getNumber('AI_TIMEOUT_MS', 6000),
  aiMinProbabilityPct: getNumber('AI_MIN_PROBABILITY_PCT', 70),
  aiEnabled: getBoolean('AI_ENABLED', true),

  // India VIX — can be overridden manually if live fetch is not set up yet
  indiaVixOverride: getNumber('INDIA_VIX_OVERRIDE', 0),
} as const;

export const isProduction = env.nodeEnv === 'production';
