-- ============================================================
-- Migration 002: Add trade_event_logs table
-- Run AFTER migration 001 (strategy_decision_logs + position_pnl_ticks)
-- ============================================================

CREATE TABLE IF NOT EXISTS trade_event_logs (
  id              BIGSERIAL     PRIMARY KEY,

  -- Event classification
  event_type      VARCHAR(50)   NOT NULL,   -- SIGNAL_GENERATED | POSITION_OPENED | etc.
  underlying      VARCHAR(20)   NOT NULL,   -- 'NIFTY' | 'SENSEX' | 'ALL'

  -- Links to related records (soft foreign keys)
  position_id     BIGINT,
  intent_id       BIGINT,
  order_id        BIGINT,

  -- Trade details at event time
  symbol          VARCHAR(50),
  side            VARCHAR(10),
  price           NUMERIC(14, 4),
  quantity        INTEGER,
  pnl             NUMERIC(14, 4),
  pnl_pct         NUMERIC(8, 4),
  stop_loss_price NUMERIC(14, 4),

  -- Human-readable reason
  reason          TEXT,

  -- Which strategy generated this (SMA_PCR | VWAP_BOUNCE | EMA_CROSS)
  strategy        VARCHAR(50),

  -- Full context snapshot
  payload         JSONB         NOT NULL DEFAULT '{}',

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  -- No updated_at — immutable event log
);

CREATE INDEX IF NOT EXISTS idx_tel_event_type   ON trade_event_logs (event_type);
CREATE INDEX IF NOT EXISTS idx_tel_underlying_ts ON trade_event_logs (underlying, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tel_position_id   ON trade_event_logs (position_id) WHERE position_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tel_created_at    ON trade_event_logs (created_at DESC);

-- ── Useful views ──────────────────────────────────────────────────────────

-- Live activity feed: last 50 events across all underlyings
CREATE OR REPLACE VIEW v_live_event_feed AS
SELECT
  id,
  event_type,
  underlying,
  symbol,
  side,
  ROUND(price::NUMERIC, 2)     AS price,
  quantity,
  ROUND(pnl::NUMERIC, 2)       AS pnl,
  ROUND(pnl_pct::NUMERIC, 2)   AS pnl_pct,
  reason,
  strategy,
  created_at
FROM trade_event_logs
ORDER BY created_at DESC
LIMIT 50;

-- Position lifecycle: all events for each position grouped
CREATE OR REPLACE VIEW v_position_lifecycle AS
SELECT
  position_id,
  array_agg(event_type ORDER BY created_at) AS event_sequence,
  MIN(created_at)                             AS opened_at,
  MAX(created_at)                             AS last_event_at,
  COUNT(*)                                    AS event_count,
  MAX(CASE WHEN event_type = 'POSITION_CLOSED' THEN pnl END) AS final_pnl
FROM trade_event_logs
WHERE position_id IS NOT NULL
GROUP BY position_id
ORDER BY MAX(created_at) DESC;

-- Verify
SELECT table_name, pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) AS size
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'trade_event_logs';
