import { Model, ModelStatic, QueryTypes, Sequelize } from 'sequelize';
import { env, isProduction } from './env';
import { initModels } from '../models';
import { Candle } from '../models/candle.model';
import { MarketTick } from '../models/market-tick.model';
import { OAuthToken } from '../models/oauth-token.model';
import { OptionChainSnapshot } from '../models/option-chain-snapshot.model';
import { PositionPnlTick } from '../models/position-pnl-tick.model';
import { StrategyDecisionLog } from '../models/strategy-decision-log.model';
import { StrategyPosition } from '../models/strategy-position.model';
import { TradeEventLog } from '../models/trade-event-log.model';
import { StockInstrument } from '../models/stock-instrument.model';
import { TradeIntent } from '../models/trade-intent.model';
import { TradeOrder } from '../models/trade-order.model';
import { WatchlistItem } from '../models/watchlist-item.model';

// ============================================================================
// Dual-database manager: primary (e.g. Supabase) + optional secondary/local
// (e.g. Postgres running on the same EC2 box).
//
// - App always queries exactly ONE active connection at a time (no split-brain
//   double-round-trip reads/writes) — models are rebound to whichever is active.
// - Every successful write on the active connection is best-effort, fire-and-
//   forget mirrored to the standby connection, so the standby stays warm and
//   can take over with near-current data.
// - A background health monitor pings both connections. If the active one
//   fails DB_FAILOVER_THRESHOLD consecutive checks, the app fails over to the
//   standby automatically. If the primary later recovers for
//   DB_RECOVERY_THRESHOLD consecutive checks, the app fails back to it.
//
// If LOCAL_DATABASE_URL is not set, this degrades to a single-connection setup
// with no mirroring/failover — same behavior as before this feature existed.
// ============================================================================

const buildConnection = (url: string): Sequelize =>
  new Sequelize(url, {
    dialect: 'postgres',
    logging: env.dbLogging ? console.log : false,
    dialectOptions: isProduction && !url.includes('localhost') && !url.includes('127.0.0.1')
      ? { ssl: { require: true, rejectUnauthorized: false } }
      : undefined,
    pool: { max: 5, min: 0, idle: 10000, acquire: 20000 },
  });

const MIRRORED_MODELS: ModelStatic<Model>[] = [
  OAuthToken as ModelStatic<Model>,
  MarketTick as ModelStatic<Model>,
  Candle as ModelStatic<Model>,
  OptionChainSnapshot as ModelStatic<Model>,
  TradeOrder as ModelStatic<Model>,
  TradeIntent as ModelStatic<Model>,
  StrategyPosition as ModelStatic<Model>,
  StockInstrument as ModelStatic<Model>,
  WatchlistItem as ModelStatic<Model>,
  StrategyDecisionLog as ModelStatic<Model>,
  PositionPnlTick as ModelStatic<Model>,
  TradeEventLog as ModelStatic<Model>,
];

type DbLabel = 'primary' | 'secondary';

class DbManager {
  private primary: Sequelize;
  private secondary: Sequelize | null;
  private active: Sequelize;
  private activeLabel: DbLabel = 'primary';
  private hooksAttached = false;
  private healthTimer: NodeJS.Timeout | null = null;
  private consecutiveActiveFailures = 0;
  private consecutivePrimaryRecoveries = 0;

  constructor() {
    this.primary = buildConnection(env.databaseUrl);
    this.secondary = env.localDatabaseUrl ? buildConnection(env.localDatabaseUrl) : null;
    this.active = this.primary;
  }

  get failoverEnabled(): boolean {
    return this.secondary !== null;
  }

  getActive(): Sequelize {
    return this.active;
  }

  getActiveLabel(): DbLabel {
    return this.activeLabel;
  }

  private getStandby(): Sequelize | null {
    if (!this.secondary) return null;
    return this.activeLabel === 'primary' ? this.secondary : this.primary;
  }

  /** Connects to primary; falls back to secondary immediately if primary is unreachable at boot. */
  async connect(): Promise<void> {
    try {
      await this.primary.authenticate();
      this.active = this.primary;
      this.activeLabel = 'primary';
      process.stdout.write('[DB] Connected to PRIMARY.\n');
    } catch (primaryErr) {
      if (!this.secondary) {
        throw primaryErr;
      }
      process.stderr.write(`[DB] PRIMARY unreachable at boot (${String(primaryErr)}). Trying SECONDARY...\n`);
      await this.secondary.authenticate();
      this.active = this.secondary;
      this.activeLabel = 'secondary';
      process.stdout.write('[DB] Connected to SECONDARY (primary was down at boot).\n');
    }

    initModels(this.active);
    this.attachMirrorHooks();
  }

  async sync(): Promise<void> {
    await this.active.sync();
    await this.resyncSequences(this.active);
  }

  /**
   * Mirror writes copy rows to the standby with explicit ids, which never advances the standby's
   * id sequences. After a failover/failback the new active DB would hand out ids that already
   * exist (unique-constraint errors on every insert), so move each sequence up to max(id).
   * Never moves a sequence backwards.
   */
  private async resyncSequences(conn: Sequelize): Promise<void> {
    for (const model of MIRRORED_MODELS) {
      const tableName = model.getTableName() as string;
      try {
        await conn.query(
          `SELECT setval(seq::regclass, GREATEST((SELECT MAX(id) FROM "${tableName}"), COALESCE(pg_sequence_last_value(seq::regclass), 0)), true)
           FROM pg_get_serial_sequence('"${tableName}"', 'id') AS seq
           WHERE seq IS NOT NULL AND EXISTS (SELECT 1 FROM "${tableName}")`,
          { type: QueryTypes.SELECT },
        );
      } catch (err) {
        process.stderr.write(`[DB] Sequence resync failed for ${tableName}: ${String(err)}\n`);
      }
    }
  }

  async close(): Promise<void> {
    this.stopHealthMonitor();
    await this.primary.close().catch(() => undefined);
    if (this.secondary) await this.secondary.close().catch(() => undefined);
  }

  startHealthMonitor(): void {
    if (!this.secondary || this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      void this.healthCheckTick();
    }, env.dbHealthCheckIntervalMs);
    process.stdout.write(`[DB] Health monitor started (every ${env.dbHealthCheckIntervalMs}ms). Failover enabled.\n`);
  }

  stopHealthMonitor(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async ping(conn: Sequelize): Promise<boolean> {
    try {
      await conn.query('SELECT 1', { type: QueryTypes.SELECT });
      return true;
    } catch {
      return false;
    }
  }

  private async healthCheckTick(): Promise<void> {
    if (!this.secondary) return;

    const activeOk = await this.ping(this.active);
    if (!activeOk) {
      this.consecutiveActiveFailures++;
      process.stderr.write(`[DB] Health check FAILED on ${this.activeLabel} (${this.consecutiveActiveFailures}/${env.dbFailoverThreshold}).\n`);
      if (this.consecutiveActiveFailures >= env.dbFailoverThreshold) {
        await this.failover();
      }
    } else {
      this.consecutiveActiveFailures = 0;
    }

    // Only watch for primary recovery while we're running on secondary
    if (this.activeLabel === 'secondary') {
      const primaryOk = await this.ping(this.primary);
      if (primaryOk) {
        this.consecutivePrimaryRecoveries++;
        if (this.consecutivePrimaryRecoveries >= env.dbRecoveryThreshold) {
          await this.failback();
        }
      } else {
        this.consecutivePrimaryRecoveries = 0;
      }
    }
  }

  private async failover(): Promise<void> {
    if (!this.secondary || this.activeLabel === 'secondary') return;
    process.stderr.write('[DB] *** FAILING OVER to SECONDARY (local) — primary unreachable. ***\n');
    this.active = this.secondary;
    this.activeLabel = 'secondary';
    this.consecutiveActiveFailures = 0;
    this.consecutivePrimaryRecoveries = 0;
    initModels(this.active);
    this.attachMirrorHooks();
    await this.resyncSequences(this.active);
  }

  private async failback(): Promise<void> {
    if (this.activeLabel !== 'secondary') return;
    process.stdout.write('[DB] *** FAILING BACK to PRIMARY — confirmed healthy again. ***\n');
    this.active = this.primary;
    this.activeLabel = 'primary';
    this.consecutiveActiveFailures = 0;
    this.consecutivePrimaryRecoveries = 0;
    initModels(this.active);
    this.attachMirrorHooks();
    await this.resyncSequences(this.active);
  }

  /**
   * Best-effort, non-blocking replication of every write to whichever DB is currently standby.
   * Must be re-called after EVERY initModels() (boot, failover, failback) — Model.init()
   * rebuilds the model's internal `options` object, which wipes any hooks added via
   * addHook() before that call. Named hooks make repeat calls idempotent (replace, not stack).
   */
  private attachMirrorHooks(): void {
    if (!this.secondary) return;

    for (const model of MIRRORED_MODELS) {
      model.addHook('afterCreate', 'mirrorAfterCreate', (instance: Model) => {
        void this.mirrorUpsert(model, instance.get({ plain: true }) as Record<string, unknown>);
      });
      model.addHook('afterUpdate', 'mirrorAfterUpdate', (instance: Model) => {
        void this.mirrorUpsert(model, instance.get({ plain: true }) as Record<string, unknown>);
      });
      model.addHook('afterDestroy', 'mirrorAfterDestroy', (instance: Model) => {
        const plain = instance.get({ plain: true }) as Record<string, unknown>;
        void this.mirrorDelete(model, plain.id);
      });
      model.addHook('afterBulkCreate', 'mirrorAfterBulkCreate', (instances: Model[]) => {
        for (const instance of instances) {
          void this.mirrorUpsert(model, instance.get({ plain: true }) as Record<string, unknown>);
        }
      });
    }

    if (!this.hooksAttached) {
      this.hooksAttached = true;
      process.stdout.write(`[DB] Write-mirroring hooks attached for ${MIRRORED_MODELS.length} models.\n`);
    }
  }

  private async mirrorUpsert(model: ModelStatic<Model>, plain: Record<string, unknown>): Promise<void> {
    const standby = this.getStandby();
    if (!standby) return;

    try {
      const tableName = model.getTableName() as string;
      const attrs = model.getAttributes();
      const idField = (attrs.id?.field as string | undefined) ?? 'id';

      const columns: string[] = [];
      const values: unknown[] = [];
      for (const [attrName, attrDef] of Object.entries(attrs)) {
        const column = (attrDef.field as string | undefined) ?? attrName;
        let value = plain[attrName];
        if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
          value = JSON.stringify(value);
        }
        columns.push(column);
        values.push(value);
      }

      const placeholders = columns.map((_, i) => `$${i + 1}`);
      const updateSet = columns
        .filter((c) => c !== idField)
        .map((c) => `"${c}" = EXCLUDED."${c}"`)
        .join(', ');
      const quotedCols = columns.map((c) => `"${c}"`).join(', ');

      const sql = updateSet
        ? `INSERT INTO "${tableName}" (${quotedCols}) VALUES (${placeholders.join(', ')}) ON CONFLICT ("${idField}") DO UPDATE SET ${updateSet}`
        : `INSERT INTO "${tableName}" (${quotedCols}) VALUES (${placeholders.join(', ')}) ON CONFLICT ("${idField}") DO NOTHING`;

      await standby.query(sql, { bind: values, type: QueryTypes.RAW });
    } catch (err) {
      process.stderr.write(`[DB] Mirror write failed for ${model.name}: ${String(err)}\n`);
    }
  }

  private async mirrorDelete(model: ModelStatic<Model>, id: unknown): Promise<void> {
    const standby = this.getStandby();
    if (!standby || id === undefined) return;
    try {
      const tableName = model.getTableName() as string;
      const attrs = model.getAttributes();
      const idField = (attrs.id?.field as string | undefined) ?? 'id';
      await standby.query(`DELETE FROM "${tableName}" WHERE "${idField}" = $1`, { bind: [id], type: QueryTypes.RAW });
    } catch (err) {
      process.stderr.write(`[DB] Mirror delete failed for ${model.name}: ${String(err)}\n`);
    }
  }
}

export const dbManager = new DbManager();

export const connectDatabase = async (): Promise<void> => {
  await dbManager.connect();
};
