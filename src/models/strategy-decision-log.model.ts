import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Sequelize,
} from 'sequelize';

/**
 * StrategyDecisionLog — persists every single evaluation cycle outcome.
 *
 * ACCEPTED intents    → decision = 'ACCEPTED', intentId set
 * REJECTED / skipped  → decision = 'REJECTED', rejectionCategory + rejectionReason
 * FAILED evaluations  → decision = 'FAILED',   errorMessage set
 *
 * latencyMs captures how long the full signal-build + AI call took, so
 * the UI can warn the user when AI latency is degrading execution quality.
 */

export type DecisionOutcome = 'ACCEPTED' | 'REJECTED' | 'FAILED';
export type RejectionCategory =
  | 'RISK_BLOCKED'        // daily-loss / trade-count limit hit
  | 'NO_SIGNAL'           // technical indicators neutral / insufficient history
  | 'LOW_CONFIDENCE'      // confidence below threshold
  | 'EXPIRY_DAY'          // option expiry today – skip
  | 'MARKET_HOURS'        // outside allowed window
  | 'PENDING_INTENT'      // already a pending intent waiting approval
  | 'NO_LIQUID_OPTION'    // ATM option spread too wide / low OI
  | 'AI_SKIP'             // AI returned SKIP recommendation
  | 'MANUAL_REJECT'       // user manually rejected from UI
  | 'OTHER';

export class StrategyDecisionLog extends Model<
  InferAttributes<StrategyDecisionLog, { omit: 'createdAt' | 'updatedAt' }>,
  InferCreationAttributes<StrategyDecisionLog, { omit: 'createdAt' | 'updatedAt' }>
> {
  declare id: CreationOptional<number>;

  // Which index/underlying was evaluated
  declare underlying: string;           // e.g. "NIFTY", "SENSEX"
  declare indexPrice: number | null;    // LTP of the index at evaluation time

  // Outcome
  declare decision: DecisionOutcome;
  declare rejectionCategory: RejectionCategory | null;
  declare rejectionReason: string | null;   // human-readable one-liner
  declare errorMessage: string | null;

  // If accepted
  declare intentId: number | null;
  declare optionType: string | null;        // 'CALL' | 'PUT'
  declare strikePrice: number | null;
  declare entryPremium: number | null;
  declare stopLossPrice: number | null;
  declare targetPrice: number | null;
  declare confidence: number | null;        // 0-1

  // Signal details stored for analysis / backtesting
  declare signalSource: string | null;      // e.g. "SMA_PCR"
  declare rationale: string | null;         // full rationale string
  declare signalMetadata: Record<string, unknown>;  // all indicators snapshot

  // Performance
  declare latencyMs: number | null;         // total evaluation time in ms
  declare aiProvider: string | null;        // 'claude' | 'openai' | 'gemini' | null
  declare aiLatencyMs: number | null;       // just the AI call portion

  // Trade-of-day counter (1st, 2nd, 3rd trade of the day)
  declare tradeOfDay: number | null;

  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export const initStrategyDecisionLogModel = (sequelize: Sequelize): void => {
  StrategyDecisionLog.init(
    {
      id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },
      underlying: {
        type: DataTypes.STRING(20),
        allowNull: false,
      },
      indexPrice: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
        field: 'index_price',
      },
      decision: {
        type: DataTypes.ENUM('ACCEPTED', 'REJECTED', 'FAILED'),
        allowNull: false,
      },
      rejectionCategory: {
        type: DataTypes.ENUM(
          'RISK_BLOCKED',
          'NO_SIGNAL',
          'LOW_CONFIDENCE',
          'EXPIRY_DAY',
          'MARKET_HOURS',
          'PENDING_INTENT',
          'NO_LIQUID_OPTION',
          'AI_SKIP',
          'MANUAL_REJECT',
          'OTHER',
        ),
        allowNull: true,
        field: 'rejection_category',
      },
      rejectionReason: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'rejection_reason',
      },
      errorMessage: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'error_message',
      },
      intentId: {
        type: DataTypes.BIGINT,
        allowNull: true,
        field: 'intent_id',
      },
      optionType: {
        type: DataTypes.STRING(10),
        allowNull: true,
        field: 'option_type',
      },
      strikePrice: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
        field: 'strike_price',
      },
      entryPremium: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: true,
        field: 'entry_premium',
      },
      stopLossPrice: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: true,
        field: 'stop_loss_price',
      },
      targetPrice: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: true,
        field: 'target_price',
      },
      confidence: {
        type: DataTypes.DECIMAL(6, 4),
        allowNull: true,
      },
      signalSource: {
        type: DataTypes.STRING(50),
        allowNull: true,
        field: 'signal_source',
      },
      rationale: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      signalMetadata: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
        field: 'signal_metadata',
      },
      latencyMs: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'latency_ms',
      },
      aiProvider: {
        type: DataTypes.STRING(30),
        allowNull: true,
        field: 'ai_provider',
      },
      aiLatencyMs: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'ai_latency_ms',
      },
      tradeOfDay: {
        type: DataTypes.SMALLINT,
        allowNull: true,
        field: 'trade_of_day',
      },
    },
    {
      sequelize,
      tableName: 'strategy_decision_logs',
      modelName: 'StrategyDecisionLog',
      underscored: true,
      indexes: [
        { fields: ['decision'] },
        { fields: ['underlying', 'created_at'] },
        { fields: ['created_at'] },
        { fields: ['intent_id'] },
      ],
    },
  );
};
