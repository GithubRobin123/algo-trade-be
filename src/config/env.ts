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
  // Fallbacks are local-dev only — in production these MUST be set via Render env vars
  frontendUrl: getString('FRONTEND_URL', 'http://localhost:5173'),
  databaseUrl: getString('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/upstox_trading'),
  dbLogging: getBoolean('DB_LOGGING', false),
  // Secondary DB for auto-failover. Leave blank to disable failover entirely.
  localDatabaseUrl: getString('LOCAL_DATABASE_URL', ''),
  dbHealthCheckIntervalMs: getNumber('DB_HEALTH_CHECK_INTERVAL_MS', 15000),
  // Consecutive failed health checks on the active DB before failing over
  dbFailoverThreshold: getNumber('DB_FAILOVER_THRESHOLD', 2),
  // Consecutive successful health checks on the primary before failing back
  dbRecoveryThreshold: getNumber('DB_RECOVERY_THRESHOLD', 4),

  upstoxApiBaseUrl: getString('UPSTOX_API_BASE_URL', 'https://api.upstox.com'),
  upstoxClientId: getString('UPSTOX_CLIENT_ID', ''),
  upstoxClientSecret: getString('UPSTOX_CLIENT_SECRET', ''),
  upstoxRedirectUri: getString('UPSTOX_REDIRECT_URI', ''),
  upstoxAccessToken: getString('UPSTOX_ACCESS_TOKEN', ''),
  upstoxAccessTokenExpiresAt: getString('UPSTOX_ACCESS_TOKEN_EXPIRES_AT', ''),
  // ── Daily token renewal (Upstox "Access Token Request" — approve in app/WhatsApp, no OTP) ──
  // Requires the Notifier Webhook URL in the Upstox app to point at POST /api/auth/upstox/callback
  upstoxAutoTokenRequest: getBoolean('UPSTOX_AUTO_TOKEN_REQUEST', true),
  upstoxTokenRequestTimeIst: getString('UPSTOX_TOKEN_REQUEST_TIME_IST', '08:30'),
  upstoxTokenRequestRetryMinutes: getNumber('UPSTOX_TOKEN_REQUEST_RETRY_MINUTES', 20),
  upstoxTokenRequestMaxAttempts: getNumber('UPSTOX_TOKEN_REQUEST_MAX_ATTEMPTS', 3),
  // Optional: your Upstox UCC. When set, webhook tokens for any other account are rejected.
  upstoxUserId: getString('UPSTOX_USER_ID', ''),

  // false = API only: no market polling, strategy loop, execution monitor or token requests.
  // Use for a second (e.g. local) instance that points at a production database.
  backgroundJobsEnabled: getBoolean('BACKGROUND_JOBS_ENABLED', true),

  niftyInstrumentKey: getString('NIFTY_INSTRUMENT_KEY', 'NSE_INDEX|Nifty 50'),
  optionChainInstrumentKey: getString('OPTION_CHAIN_INSTRUMENT_KEY', 'NSE_INDEX|Nifty 50'),
  optionChainExpiryDate: getString('OPTION_CHAIN_EXPIRY_DATE', ''),
  // How often the option chain is re-fetched from Upstox (DB snapshots are still rate-limited separately).
  optionChainRefreshMs: getNumber('OPTION_CHAIN_REFRESH_MS', 30000),
  // Option chain history: one DB row per this many minutes. The newest row keeps the full chain (the
  // dashboard reads it); a finished row is cut down to ATM ± OPTION_CHAIN_HISTORY_STRIKES strikes.
  optionChainSnapshotMinutes: getNumber('OPTION_CHAIN_SNAPSHOT_MINUTES', 1),
  optionChainHistoryStrikes: getNumber('OPTION_CHAIN_HISTORY_STRIKES', 10),
  // Raw index ticks older than this are deleted daily (strategy and candles only read today's ticks;
  // ticks were ~70% of the database). 0 = keep forever.
  marketTickRetentionDays: getNumber('MARKET_TICK_RETENTION_DAYS', 3),
  marketPollIntervalMs: getNumber('MARKET_POLL_INTERVAL_MS', 5000),
  // Real-time ticks over the Upstox WebSocket (Upstox allows 2 connections per user; each backend uses 1).
  // false = REST polling only (e.g. on an extra instance, to keep a connection free).
  upstoxStreamEnabled: getBoolean('UPSTOX_STREAM_ENABLED', true),
  marketHistoryLimit: getNumber('MARKET_HISTORY_LIMIT', 500),

  strategyEnabled: getBoolean('STRATEGY_ENABLED', true),
  strategyScanIntervalMs: getNumber('STRATEGY_SCAN_INTERVAL_MS', 20000),
  // No new entry before this IST time (HH:MM). Signals before it are still evaluated and logged as
  // "not traded". v2.3: entries before 10:30 lost in the 208-day backtest (both halves) and live.
  strategyEntryStartIst: getString('STRATEGY_ENTRY_START_IST', '10:30'),
  // Routine "no trade" decision rows (no signal, market hours, position open, …) are written when the
  // reason changes and then at most once per this many minutes (0 = every scan, as before v2.3).
  strategyRoutineLogMinutes: getNumber('STRATEGY_ROUTINE_LOG_MINUTES', 5),
  strategyMaxAutoTradesPerDay: getNumber('STRATEGY_MAX_AUTO_TRADES_PER_DAY', 2),
  strategyDailyMaxLossPct: getNumber('STRATEGY_DAILY_MAX_LOSS_PCT', 5),
  // true = the daily loss limit also counts the next trade's planned stop-loss loss, so a new
  // trade can never take the day past the limit (false = only realized + open P&L, as before v2.2)
  strategyDailyLossIncludesNextRisk: getBoolean('STRATEGY_DAILY_LOSS_INCLUDES_NEXT_RISK', true),
  // No new entry after this many losing trades in a day (0 = off)
  strategyMaxLossesPerDay: getNumber('STRATEGY_MAX_LOSSES_PER_DAY', 3),
  strategyCapital: getNumber('STRATEGY_CAPITAL', 100000),
  strategyProfitTargetPct: getNumber('STRATEGY_PROFIT_TARGET_PCT', 50),
  strategyEntryStopLossPct: getNumber('STRATEGY_ENTRY_STOP_LOSS_PCT', 20),
  strategyTrailActivationPct: getNumber('STRATEGY_TRAIL_ACTIVATION_PCT', 8),
  strategyTrailOffsetPct: getNumber('STRATEGY_TRAIL_OFFSET_PCT', 5),
  strategyConfidenceThreshold: getNumber('STRATEGY_CONFIDENCE_THRESHOLD', 0.7),
  // Rule-based scorer blocks SKIP / opposite-direction signals whenever no AI call will run
  strategyRulesGateEnabled: getBoolean('STRATEGY_RULES_GATE_ENABLED', true),
  // Let PCR (put/call OI near ATM) add ±8 to the rules gate. Off by default: the backtest has no
  // option-chain history (PCR is neutral there), so with PCR on, live ran an untested gate.
  strategyGatePcrEnabled: getBoolean('STRATEGY_GATE_PCR_ENABLED', false),
  // ATR stop loss on option premium: clamp(multiplier × ATM-delta × indexATR ÷ premium, min%, max%)
  strategySlAtrMultiplier: getNumber('STRATEGY_SL_ATR_MULTIPLIER', 2.5),
  strategySlMinPct: getNumber('STRATEGY_SL_MIN_PCT', 8),
  strategySlMaxPct: getNumber('STRATEGY_SL_MAX_PCT', 30),
  // Trailing stop distance = max(TRAIL_OFFSET_PCT of best premium, multiplier × ATM-delta × entry index ATR)
  strategyTrailAtrMultiplier: getNumber('STRATEGY_TRAIL_ATR_MULTIPLIER', 1.5),
  // Before the trail activates, move the stop to entry + 1% once the premium is up this much (0 = off)
  strategyBreakevenTriggerPct: getNumber('STRATEGY_BREAKEVEN_TRIGGER_PCT', 10),
  // No new entry for this many minutes after a losing exit (0 = off)
  strategyLossCooldownMinutes: getNumber('STRATEGY_LOSS_COOLDOWN_MINUTES', 15),
  // Previous full sessions of 5-min candles loaded as indicator warm-up (75 candles per session)
  strategyWarmupSessions: getNumber('STRATEGY_WARMUP_SESSIONS', 2),
  // Stamped on every decision, intent and position so results can be compared per version.
  // Bump it in code whenever entry/exit logic changes (env parameters are stamped separately).
  strategyVersion: 'v2.3',
  // How long a strategy intent waits for manual approval before it expires
  intentExpiryMinutes: getNumber('INTENT_EXPIRY_MINUTES', 2),

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

  // Estimated charges per option trade (shown as Charges / Net P&L; paper P&L itself is gross).
  // Brokerage ₹ per executed order and STT % of the sell-side premium; exchange, SEBI, GST and
  // stamp duty use the fixed NSE rates in utils/charges.ts.
  chargesBrokeragePerOrder: getNumber('CHARGES_BROKERAGE_PER_ORDER', 20),
  chargesSttSellPct: getNumber('CHARGES_STT_SELL_PCT', 0.15),
} as const;

export const isProduction = env.nodeEnv === 'production';
