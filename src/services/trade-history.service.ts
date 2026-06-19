import { Op, col, where as sqlWhere } from 'sequelize';
import { StrategyDecisionLog } from '../models/strategy-decision-log.model';
import { StrategyPosition } from '../models/strategy-position.model';
import { TradeIntent } from '../models/trade-intent.model';

export interface TradeHistoryEntry {
  id: number;
  openedAt: string;
  closedAt: string | null;
  strategy: string | null;
  optionType: string | null;
  strikePrice: number | null;
  symbol: string;
  instrumentKey: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  exitPrice: number | null;
  stopLossPrice: number;
  targetPrice: number;
  exitReason: string | null;
  realizedPnl: number | null;
  pnlPct: number | null;
  confidence: number | null;
  rationale: string | null;
  status: 'OPEN' | 'CLOSED';
  trailActive: boolean;
  bestPrice: number;
  indexPriceAtEntry: number | null;
  ruleSignals: string[] | null;
  decisionLogId: number | null;
}

export interface DecisionLogEntry {
  id: number;
  timestamp: string;
  underlying: string;
  indexPrice: number | null;
  decision: 'ACCEPTED' | 'REJECTED' | 'FAILED';
  rejectionCategory: string | null;
  rejectionReason: string | null;
  strategy: string | null;
  optionType: string | null;
  strikePrice: number | null;
  entryPremium: number | null;
  stopLossPrice: number | null;
  targetPrice: number | null;
  confidence: number | null;
  rationale: string | null;
  latencyMs: number | null;
  tradeOfDay: number | null;
}

export interface TradeSummaryStats {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalRealizedPnl: number;
  avgWin: number;
  avgLoss: number;
  strategyBreakdown: Record<string, { trades: number; pnl: number; wins: number }>;
  exitReasonBreakdown: Record<string, number>;
  decisionBreakdown: Record<string, number>;
}

class TradeHistoryService {
  async getTradeHistory(days = 30, status?: 'OPEN' | 'CLOSED' | 'ALL'): Promise<TradeHistoryEntry[]> {
    const start = new Date(Date.now() - Math.min(days, 365) * 24 * 60 * 60 * 1000);

    const positionWhere: Record<string, unknown> = {
      [Op.or]: [
        { [Op.and]: [sqlWhere(col('created_at'), Op.gte, start)] },
        { [Op.and]: [sqlWhere(col('updated_at'), Op.gte, start)] },
      ],
    };
    if (status && status !== 'ALL') positionWhere['status'] = status;

    const positions = await StrategyPosition.findAll({
      where: positionWhere as never,
      order: [['createdAt', 'DESC']],
      limit: 500,
    });

    if (!positions.length) return [];

    // ACCEPTED decision logs in the same date range for strategy/rationale details
    const decisionLogs = await StrategyDecisionLog.findAll({
      where: {
        decision: 'ACCEPTED',
        [Op.and]: [sqlWhere(col('created_at'), Op.gte, start)],
      } as never,
    });

    // Build lookup: intentId → decisionLog
    const intentIds = decisionLogs
      .map((d) => d.intentId)
      .filter((id): id is number => id !== null);

    // Fetch intents to get executedOrderId → link to position.openedOrderId
    const intents = intentIds.length
      ? await TradeIntent.findAll({ where: { id: { [Op.in]: intentIds } } })
      : [];

    const orderIdToIntentId = new Map<number, number>();
    for (const intent of intents) {
      if (intent.executedOrderId !== null) {
        orderIdToIntentId.set(Number(intent.executedOrderId), Number(intent.id));
      }
    }

    const intentIdToLog = new Map<number, StrategyDecisionLog>();
    for (const log of decisionLogs) {
      if (log.intentId !== null) intentIdToLog.set(Number(log.intentId), log);
    }

    return positions.map((pos) => {
      const openedOrderId = pos.openedOrderId ? Number(pos.openedOrderId) : null;
      const intentId = openedOrderId ? (orderIdToIntentId.get(openedOrderId) ?? null) : null;
      const decisionLog = intentId ? (intentIdToLog.get(intentId) ?? null) : null;

      const posMeta = pos.metadata as Record<string, unknown>;
      const signalMeta = decisionLog?.signalMetadata as Record<string, unknown> | null;

      const strategy =
        (posMeta?.strategyName as string | null) ??
        (signalMeta?.strategyName as string | null) ??
        decisionLog?.signalSource ??
        null;

      const ruleSignals = (signalMeta?.ruleSignals as string[] | null) ?? null;
      const entryPrice = Number(pos.entryPrice);

      let pnlPct: number | null = null;
      if (pos.realizedPnl !== null && entryPrice > 0 && pos.quantity > 0) {
        pnlPct = (Number(pos.realizedPnl) / (entryPrice * pos.quantity)) * 100;
      }

      const optionType =
        decisionLog?.optionType ??
        (pos.symbol.endsWith('-CE') ? 'CALL' : pos.symbol.endsWith('-PE') ? 'PUT' : null);

      return {
        id: Number(pos.id),
        openedAt: pos.createdAt.toISOString(),
        closedAt: pos.status === 'CLOSED' ? pos.updatedAt.toISOString() : null,
        strategy,
        optionType,
        strikePrice:
          decisionLog?.strikePrice != null
            ? Number(decisionLog.strikePrice)
            : (posMeta?.strike as number | null) ?? null,
        symbol: pos.symbol,
        instrumentKey: pos.instrumentKey,
        side: pos.side,
        quantity: pos.quantity,
        entryPrice,
        exitPrice:
          pos.status === 'CLOSED' && pos.currentPrice !== null
            ? Number(pos.currentPrice)
            : null,
        stopLossPrice: Number(pos.stopLossPrice),
        targetPrice: Number(pos.targetPrice),
        exitReason: pos.exitReason,
        realizedPnl: pos.realizedPnl !== null ? Number(pos.realizedPnl) : null,
        pnlPct,
        confidence:
          decisionLog?.confidence != null ? Number(decisionLog.confidence) : null,
        rationale:
          decisionLog?.rationale ?? (posMeta?.rationale as string | null) ?? null,
        status: pos.status,
        trailActive: pos.trailActive,
        bestPrice: Number(pos.bestPrice),
        indexPriceAtEntry:
          decisionLog?.indexPrice != null ? Number(decisionLog.indexPrice) : null,
        ruleSignals,
        decisionLogId: decisionLog ? Number(decisionLog.id) : null,
      };
    });
  }

  async getDecisionLog(days = 7, decision?: string): Promise<DecisionLogEntry[]> {
    const start = new Date(Date.now() - Math.min(days, 90) * 24 * 60 * 60 * 1000);
    const where: Record<string, unknown> = {
      [Op.and]: [sqlWhere(col('created_at'), Op.gte, start)],
    };
    if (decision && decision !== 'ALL') where['decision'] = decision;

    const logs = await StrategyDecisionLog.findAll({
      where: where as never,
      order: [['createdAt', 'DESC']],
      limit: 1000,
    });

    return logs.map((log) => {
      const signalMeta = log.signalMetadata as Record<string, unknown> | null;
      return {
        id: Number(log.id),
        timestamp: log.createdAt.toISOString(),
        underlying: log.underlying,
        indexPrice: log.indexPrice != null ? Number(log.indexPrice) : null,
        decision: log.decision,
        rejectionCategory: log.rejectionCategory,
        rejectionReason: log.rejectionReason,
        strategy: (signalMeta?.strategyName as string | null) ?? log.signalSource,
        optionType: log.optionType,
        strikePrice: log.strikePrice != null ? Number(log.strikePrice) : null,
        entryPremium: log.entryPremium != null ? Number(log.entryPremium) : null,
        stopLossPrice: log.stopLossPrice != null ? Number(log.stopLossPrice) : null,
        targetPrice: log.targetPrice != null ? Number(log.targetPrice) : null,
        confidence: log.confidence != null ? Number(log.confidence) : null,
        rationale: log.rationale,
        latencyMs: log.latencyMs,
        tradeOfDay: log.tradeOfDay,
      };
    });
  }

  async getTradeSummary(days = 30): Promise<TradeSummaryStats> {
    const start = new Date(Date.now() - Math.min(days, 365) * 24 * 60 * 60 * 1000);

    const [positions, decisionLogs] = await Promise.all([
      StrategyPosition.findAll({
        where: {
          [Op.or]: [
            { [Op.and]: [sqlWhere(col('created_at'), Op.gte, start)] },
            { [Op.and]: [sqlWhere(col('updated_at'), Op.gte, start)] },
          ],
        } as never,
      }),
      StrategyDecisionLog.findAll({
        where: { [Op.and]: [sqlWhere(col('created_at'), Op.gte, start)] } as never,
      }),
    ]);

    const closed = positions.filter((p) => p.status === 'CLOSED');
    const open = positions.filter((p) => p.status === 'OPEN');
    const wins = closed.filter((p) => p.realizedPnl !== null && Number(p.realizedPnl) > 0);
    const losses = closed.filter((p) => p.realizedPnl !== null && Number(p.realizedPnl) <= 0);

    const totalRealizedPnl = closed.reduce(
      (s, p) => s + (p.realizedPnl !== null ? Number(p.realizedPnl) : 0),
      0,
    );
    const avgWin = wins.length
      ? wins.reduce((s, p) => s + Number(p.realizedPnl!), 0) / wins.length
      : 0;
    const avgLoss = losses.length
      ? losses.reduce((s, p) => s + Number(p.realizedPnl!), 0) / losses.length
      : 0;

    const strategyBreakdown: Record<string, { trades: number; pnl: number; wins: number }> = {};
    for (const pos of closed) {
      const meta = pos.metadata as Record<string, unknown>;
      const name = (meta?.strategyName as string | null) ?? 'UNKNOWN';
      if (!strategyBreakdown[name]) strategyBreakdown[name] = { trades: 0, pnl: 0, wins: 0 };
      strategyBreakdown[name].trades++;
      strategyBreakdown[name].pnl += pos.realizedPnl !== null ? Number(pos.realizedPnl) : 0;
      if (pos.realizedPnl !== null && Number(pos.realizedPnl) > 0) strategyBreakdown[name].wins++;
    }

    const exitReasonBreakdown: Record<string, number> = {};
    for (const pos of closed) {
      const reason = pos.exitReason ?? 'UNKNOWN';
      exitReasonBreakdown[reason] = (exitReasonBreakdown[reason] ?? 0) + 1;
    }

    const decisionBreakdown: Record<string, number> = {};
    for (const log of decisionLogs) {
      const key =
        log.decision === 'REJECTED'
          ? `REJECTED_${log.rejectionCategory ?? 'OTHER'}`
          : log.decision;
      decisionBreakdown[key] = (decisionBreakdown[key] ?? 0) + 1;
    }

    return {
      totalTrades: positions.length,
      openTrades: open.length,
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct: closed.length ? (wins.length / closed.length) * 100 : 0,
      totalRealizedPnl,
      avgWin,
      avgLoss,
      strategyBreakdown,
      exitReasonBreakdown,
      decisionBreakdown,
    };
  }
}

export const tradeHistoryService = new TradeHistoryService();
