import { Op } from 'sequelize';
import { PositionPnlTick } from '../models/position-pnl-tick.model';
import { StrategyDecisionLog } from '../models/strategy-decision-log.model';
import { StrategyPosition } from '../models/strategy-position.model';
import { TradeIntent } from '../models/trade-intent.model';
import { TradeOrder } from '../models/trade-order.model';
import { tradeEventService } from './trade-event.service';

const startOfDay = (): Date => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
};

export class DashboardService {

  // ── Full dashboard snapshot for the main dashboard page ───────────────
  async getDashboardSnapshot() {
    const since = startOfDay();

    const [
      todayDecisionSummary,
      openPositions,
      recentDecisions,
      recentOrders,
      pendingIntents,
      recentEvents,
    ] = await Promise.all([
      this.getTodayDecisionSummary(since),
      this.getOpenPositionsWithLivePnl(),
      StrategyDecisionLog.findAll({
        order: [['createdAt', 'DESC']],
        limit: 30,
      }),
      TradeOrder.findAll({
        order: [['createdAt', 'DESC']],
        limit: 20,
      }),
      TradeIntent.findAll({
        where: { status: 'PENDING_APPROVAL' },
        order: [['createdAt', 'DESC']],
        limit: 10,
      }),
      tradeEventService.getRecentEvents(undefined, 50),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      today: todayDecisionSummary,
      openPositions,
      recentDecisions: recentDecisions.map(this.serializeDecisionLog),
      recentOrders: recentOrders.map(this.serializeOrder),
      pendingIntents: pendingIntents.map(this.serializeIntent),
      recentEvents: recentEvents.map((e) => ({
        id: Number(e.id),
        type: e.eventType,
        underlying: e.underlying,
        symbol: e.symbol,
        side: e.side,
        price: e.price !== null ? Number(e.price) : null,
        pnl: e.pnl !== null ? Number(e.pnl) : null,
        pnlPct: e.pnlPct !== null ? Number(e.pnlPct) : null,
        stopLossPrice: e.stopLossPrice !== null ? Number(e.stopLossPrice) : null,
        reason: e.reason,
        strategy: e.strategy,
        positionId: e.positionId,
        ts: e.createdAt.toISOString(),
      })),
    };
  }

  // ── Decision logs with filtering ──────────────────────────────────────
  async getDecisionLogs(params: {
    limit?: number;
    decision?: string;
    underlying?: string;
    daysBack?: number;
  }) {
    const limit = Math.min(params.limit ?? 100, 500);
    const since = params.daysBack
      ? new Date(Date.now() - params.daysBack * 24 * 60 * 60 * 1000)
      : undefined;

    const where: Record<string, unknown> = {};
    if (params.decision) where['decision'] = params.decision;
    if (params.underlying) where['underlying'] = params.underlying;
    if (since) where['createdAt'] = { [Op.gte]: since };

    const logs = await StrategyDecisionLog.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
    });

    return logs.map(this.serializeDecisionLog);
  }

  // ── PnL ticks for a position (for live chart on UI) ───────────────────
  async getPositionPnlChart(positionId: number, limit = 300) {
    const ticks = await PositionPnlTick.findAll({
      where: { positionId },
      order: [['createdAt', 'ASC']],
      limit: Math.min(limit, 1000),
    });

    return ticks.map((t) => ({
      ts: t.createdAt.toISOString(),
      premium: Number(t.currentPremium),
      pnl: Number(t.unrealizedPnl),
      pnlPct: Number(t.unrealizedPnlPct),
      sl: Number(t.stopLossPrice),
      hwm: Number(t.highWaterMark),
      trail: t.trailActive,
    }));
  }

  // ── Historical daily PnL breakdown ────────────────────────────────────
  async getDailyPnlBreakdown(daysBack = 30) {
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const positions = await StrategyPosition.findAll({
      where: {
        status: 'CLOSED',
        updatedAt: { [Op.gte]: since },
      },
      order: [['updatedAt', 'ASC']],
    });

    const map = new Map<string, { day: string; pnl: number; wins: number; losses: number; trades: number }>();

    for (let i = daysBack - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      map.set(day, { day, pnl: 0, wins: 0, losses: 0, trades: 0 });
    }

    for (const pos of positions) {
      const day = pos.updatedAt.toISOString().slice(0, 10);
      const row = map.get(day);
      if (!row) continue;
      const pnl = pos.realizedPnl !== null ? Number(pos.realizedPnl) : 0;
      row.pnl += pnl;
      row.trades += 1;
      if (pnl > 0) row.wins += 1;
      else row.losses += 1;
    }

    return Array.from(map.values());
  }

  // ── Live open position details (with latest tick) ─────────────────────
  private async getOpenPositionsWithLivePnl() {
    const openPositions = await StrategyPosition.findAll({
      where: { status: 'OPEN' },
      order: [['createdAt', 'ASC']],
    });

    return openPositions.map((pos) => ({
      id: Number(pos.id),
      symbol: pos.symbol,
      instrumentKey: pos.instrumentKey,
      side: pos.side,
      quantity: pos.quantity,
      entryPrice: Number(pos.entryPrice),
      currentPrice: pos.currentPrice !== null ? Number(pos.currentPrice) : null,
      stopLossPrice: Number(pos.stopLossPrice),
      targetPrice: Number(pos.targetPrice),
      highWaterMark: Number(pos.bestPrice),
      trailActive: pos.trailActive,
      unrealizedPnl: pos.unrealizedPnl !== null ? Number(pos.unrealizedPnl) : null,
      status: pos.status,
      openedAt: pos.createdAt.toISOString(),
      // Latency impact note: decision time does NOT affect PnL since we use MARKET orders
      // The only latency risk is slippage between signal detection and order fill
    }));
  }

  private async getTodayDecisionSummary(since: Date) {
    const [decisions, orders, closedPositions, openPositions] = await Promise.all([
      StrategyDecisionLog.findAll({ where: { createdAt: { [Op.gte]: since } } }),
      TradeOrder.findAll({ where: { createdAt: { [Op.gte]: since } } }),
      StrategyPosition.findAll({ where: { status: 'CLOSED', updatedAt: { [Op.gte]: since } } }),
      StrategyPosition.findAll({ where: { status: 'OPEN' } }),
    ]);

    let accepted = 0, rejected = 0, failed = 0;
    let totalLatencyMs = 0, latencyCount = 0;
    const rejectionBreakdown: Record<string, number> = {};

    for (const d of decisions) {
      if (d.decision === 'ACCEPTED') accepted++;
      else if (d.decision === 'REJECTED') {
        rejected++;
        const cat = d.rejectionCategory ?? 'OTHER';
        rejectionBreakdown[cat] = (rejectionBreakdown[cat] ?? 0) + 1;
      } else {
        failed++;
      }
      if (d.latencyMs !== null) { totalLatencyMs += d.latencyMs; latencyCount++; }
    }

    const realizedPnl = closedPositions.reduce((s, p) => s + (p.realizedPnl !== null ? Number(p.realizedPnl) : 0), 0);
    const unrealizedPnl = openPositions.reduce((s, p) => s + (p.unrealizedPnl !== null ? Number(p.unrealizedPnl) : 0), 0);

    const failedOrders = orders.filter((o) => o.status === 'FAILED').length;
    const executedOrders = orders.filter((o) => o.status !== 'FAILED').length;

    const avgDecisionLatencyMs = latencyCount > 0 ? Math.round(totalLatencyMs / latencyCount) : null;

    // Latency impact warning: if avg decision latency > 2s, flag it
    // At MARKET order prices, 2-5s latency = approx 0.1-0.3% slippage on premium
    const latencyRiskLevel = avgDecisionLatencyMs === null ? 'UNKNOWN'
      : avgDecisionLatencyMs < 500 ? 'LOW'
      : avgDecisionLatencyMs < 2000 ? 'MEDIUM'
      : 'HIGH';

    return {
      decisions: { total: decisions.length, accepted, rejected, failed, rejectionBreakdown },
      orders: { total: orders.length, executed: executedOrders, failed: failedOrders },
      pnl: {
        realizedPnl,
        unrealizedPnl,
        totalPnl: realizedPnl + unrealizedPnl,
        closedTrades: closedPositions.length,
        openTrades: openPositions.length,
        winCount: closedPositions.filter((p) => p.realizedPnl !== null && Number(p.realizedPnl) > 0).length,
        lossCount: closedPositions.filter((p) => p.realizedPnl !== null && Number(p.realizedPnl) <= 0).length,
      },
      latency: {
        avgDecisionLatencyMs,
        latencyRiskLevel,
        note: latencyRiskLevel === 'HIGH'
          ? 'High decision latency detected — consider reducing AI timeout or using rule-based fallback'
          : null,
      },
    };
  }

  private serializeDecisionLog(log: StrategyDecisionLog) {
    return {
      id: Number(log.id),
      underlying: log.underlying,
      indexPrice: log.indexPrice !== null ? Number(log.indexPrice) : null,
      decision: log.decision,
      rejectionCategory: log.rejectionCategory,
      rejectionReason: log.rejectionReason,
      errorMessage: log.errorMessage,
      intentId: log.intentId,
      optionType: log.optionType,
      strikePrice: log.strikePrice !== null ? Number(log.strikePrice) : null,
      entryPremium: log.entryPremium !== null ? Number(log.entryPremium) : null,
      stopLossPrice: log.stopLossPrice !== null ? Number(log.stopLossPrice) : null,
      targetPrice: log.targetPrice !== null ? Number(log.targetPrice) : null,
      confidence: log.confidence !== null ? Number(log.confidence) : null,
      signalSource: log.signalSource,
      rationale: log.rationale,
      latencyMs: log.latencyMs,
      aiProvider: log.aiProvider,
      aiLatencyMs: log.aiLatencyMs,
      tradeOfDay: log.tradeOfDay,
      createdAt: log.createdAt.toISOString(),
    };
  }

  private serializeOrder(order: TradeOrder) {
    return {
      id: Number(order.id),
      side: order.side,
      symbol: order.symbol,
      quantity: order.quantity,
      status: order.status,
      isPaper: order.isPaper,
      price: order.price !== null ? Number(order.price) : null,
      errorMessage: order.errorMessage,
      createdAt: order.createdAt.toISOString(),
    };
  }

  private serializeIntent(intent: TradeIntent) {
    return {
      id: Number(intent.id),
      side: intent.side,
      symbol: intent.symbol,
      quantity: intent.quantity,
      status: intent.status,
      confidence: intent.confidence !== null ? Number(intent.confidence) : null,
      rationale: intent.rationale,
      expiresAt: intent.expiresAt?.toISOString() ?? null,
      createdAt: intent.createdAt.toISOString(),
    };
  }
}

export const dashboardService = new DashboardService();
