import { dbManager } from '../config/database';
import { env } from '../config/env';
import { istClock } from '../utils/ist-clock';
import { isMarketOpen } from './market-data.service';

const CHECK_EVERY_MS = 15 * 60_000;
const FIRST_CHECK_AFTER_MS = 60_000;
const BATCH_ROWS = 20_000;
const MAX_BATCHES = 200; // 4M rows per run at most
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Daily clean-up of raw index ticks. The WebSocket stores every NIFTY tick (~22,600 rows a day,
 * ~7 MB a day, ~70% of the database by Nov 2026), but only today's ticks are ever read: the 5-min
 * candles are aggregated from them during the session and kept in the candles table. Runs once a
 * day outside market hours, on both databases, in batches so neither holds a long lock.
 */
class DataRetentionService {
  private timer: NodeJS.Timeout | null = null;
  private firstRun: NodeJS.Timeout | null = null;
  private lastRunDay = '';
  private running = false;

  start(): void {
    if (this.timer || env.marketTickRetentionDays <= 0) return;
    this.firstRun = setTimeout(() => { void this.check(); }, FIRST_CHECK_AFTER_MS);
    this.timer = setInterval(() => { void this.check(); }, CHECK_EVERY_MS);
  }

  stop(): void {
    if (this.firstRun) clearTimeout(this.firstRun);
    if (this.timer) clearInterval(this.timer);
    this.firstRun = null;
    this.timer = null;
  }

  private async check(): Promise<void> {
    const { date } = istClock();
    if (this.running || this.lastRunDay === date || isMarketOpen()) return;
    this.running = true;
    try {
      await this.pruneMarketTicks();
      this.lastRunDay = date;
    } catch (err) {
      process.stderr.write(`[Retention] Tick clean-up failed: ${String(err)}\n`);
    } finally {
      this.running = false;
    }
  }

  /** Deletes market_ticks older than MARKET_TICK_RETENTION_DAYS on every database. */
  async pruneMarketTicks(): Promise<Record<string, number>> {
    const cutoff = new Date(Date.now() - env.marketTickRetentionDays * DAY_MS);
    const deleted: Record<string, number> = {};
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const results = await dbManager.queryOnAll<{ n: number }>(
        `WITH gone AS (
           DELETE FROM market_ticks WHERE id IN (
             SELECT id FROM market_ticks WHERE source_timestamp < $1 LIMIT ${BATCH_ROWS})
           RETURNING 1)
         SELECT count(*)::int AS n FROM gone`,
        [cutoff],
      );
      let more = false;
      for (const { label, row, error } of results) {
        if (error) { process.stderr.write(`[Retention] ${label}: ${error}\n`); continue; }
        const n = Number(row?.n ?? 0);
        deleted[label] = (deleted[label] ?? 0) + n;
        if (n >= BATCH_ROWS) more = true;
      }
      if (!more) break;
    }
    process.stdout.write(`[Retention] market_ticks older than ${cutoff.toISOString()} deleted: ${JSON.stringify(deleted)}\n`);
    return deleted;
  }
}

export const dataRetentionService = new DataRetentionService();
