import { Op, col, where as sqlWhere } from 'sequelize';
import { StrategyPosition } from '../models/strategy-position.model';
import { TradeOrder } from '../models/trade-order.model';

export interface ReportSummary {
  rangeDays: number;
  generatedAt: string;
  orders: {
    total: number;
    buyCount: number;
    sellCount: number;
    failedCount: number;
    paperCount: number;
    liveCount: number;
    estimatedNotional: number;
  };
  strategy: {
    closedPositions: number;
    openPositions: number;
    realizedPnl: number;
    unrealizedPnl: number;
    winRatePct: number;
  };
}

export interface DailyReportRow {
  day: string;
  orderCount: number;
  failedOrders: number;
  estimatedNotional: number;
  realizedPnl: number;
}

export interface PerformanceStats {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  grossPnl: number;
  estimatedCharges: number;
  netPnl: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null;
  expectancyPerTrade: number;
  exitReasons: Record<string, number>;
}

export interface VersionPerformance extends PerformanceStats {
  version: string;
  firstTradeAt: string | null;
  lastTradeAt: string | null;
  byStrategy: Record<string, PerformanceStats>;
}

// Rough all-in cost of one options round trip (2 × ₹20 brokerage + STT, exchange, GST, stamp)
const EST_CHARGES_PER_ROUND_TRIP = 60;

const formatDay = (date: Date): string => date.toISOString().slice(0, 10);

const round2 = (value: number): number => Math.round(value * 100) / 100;

const computeStats = (positions: StrategyPosition[]): PerformanceStats => {
  const pnls = positions.map((p) => Number(p.realizedPnl ?? 0));
  const winners = pnls.filter((v) => v > 0);
  const losers = pnls.filter((v) => v <= 0);
  const grossWin = winners.reduce((s, v) => s + v, 0);
  const grossLoss = Math.abs(losers.reduce((s, v) => s + v, 0));
  const grossPnl = grossWin - grossLoss;
  const estimatedCharges = positions.length * EST_CHARGES_PER_ROUND_TRIP;

  const exitReasons: Record<string, number> = {};
  for (const p of positions) {
    // "TECH_REVERSAL: RSI exhaustion 97 …" → "TECH_REVERSAL"
    const reason = (p.exitReason ?? 'UNKNOWN').split(':')[0].trim() || 'UNKNOWN';
    exitReasons[reason] = (exitReasons[reason] ?? 0) + 1;
  }

  return {
    trades: positions.length,
    wins: winners.length,
    losses: losers.length,
    winRatePct: positions.length ? round2((winners.length / positions.length) * 100) : 0,
    grossPnl: round2(grossPnl),
    estimatedCharges,
    netPnl: round2(grossPnl - estimatedCharges),
    avgWin: winners.length ? round2(grossWin / winners.length) : 0,
    avgLoss: losers.length ? round2(-grossLoss / losers.length) : 0,
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
    expectancyPerTrade: positions.length ? round2((grossPnl - estimatedCharges) / positions.length) : 0,
    exitReasons,
  };
};

class ReportService {
  async getSummary(days = 30): Promise<ReportSummary> {
    const safeDays = Math.min(Math.max(days, 1), 365);
    const start = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);

    const [orders, positions] = await Promise.all([
      TradeOrder.findAll({
        where: {
          [Op.and]: [sqlWhere(col('created_at'), Op.gte, start)],
        },
      }),
      StrategyPosition.findAll({
        where: {
          [Op.or]: [
            {
              [Op.and]: [sqlWhere(col('updated_at'), Op.gte, start)],
            },
            {
              [Op.and]: [sqlWhere(col('created_at'), Op.gte, start)],
            },
          ],
        },
      }),
    ]);

    let estimatedNotional = 0;
    let buyCount = 0;
    let sellCount = 0;
    let failedCount = 0;
    let paperCount = 0;
    let liveCount = 0;

    for (const order of orders) {
      if (order.side === 'BUY') {
        buyCount += 1;
      } else {
        sellCount += 1;
      }

      if (order.status === 'FAILED') {
        failedCount += 1;
      }

      if (order.isPaper) {
        paperCount += 1;
      } else {
        liveCount += 1;
      }

      const price = order.price !== null ? Number(order.price) : null;
      if (price !== null && price > 0) {
        estimatedNotional += price * order.quantity;
      }
    }

    const openPositions = positions.filter((item) => item.status === 'OPEN');
    const closedPositions = positions.filter((item) => item.status === 'CLOSED');

    const realizedPnl = closedPositions.reduce(
      (sum, item) => sum + (item.realizedPnl !== null ? Number(item.realizedPnl) : 0),
      0,
    );

    const unrealizedPnl = openPositions.reduce(
      (sum, item) => sum + (item.unrealizedPnl !== null ? Number(item.unrealizedPnl) : 0),
      0,
    );

    const winningClosed = closedPositions.filter(
      (item) => item.realizedPnl !== null && Number(item.realizedPnl) > 0,
    ).length;

    const winRatePct = closedPositions.length
      ? (winningClosed / closedPositions.length) * 100
      : 0;

    return {
      rangeDays: safeDays,
      generatedAt: new Date().toISOString(),
      orders: {
        total: orders.length,
        buyCount,
        sellCount,
        failedCount,
        paperCount,
        liveCount,
        estimatedNotional,
      },
      strategy: {
        closedPositions: closedPositions.length,
        openPositions: openPositions.length,
        realizedPnl,
        unrealizedPnl,
        winRatePct,
      },
    };
  }

  async getDaily(days = 30): Promise<DailyReportRow[]> {
    const safeDays = Math.min(Math.max(days, 1), 365);
    const start = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);

    const [orders, closedPositions] = await Promise.all([
      TradeOrder.findAll({
        where: {
          [Op.and]: [sqlWhere(col('created_at'), Op.gte, start)],
        },
      }),
      StrategyPosition.findAll({
        where: {
          status: 'CLOSED',
          [Op.and]: [sqlWhere(col('updated_at'), Op.gte, start)],
        },
      }),
    ]);

    const map = new Map<string, DailyReportRow>();

    for (let index = safeDays - 1; index >= 0; index -= 1) {
      const day = formatDay(new Date(Date.now() - index * 24 * 60 * 60 * 1000));
      map.set(day, {
        day,
        orderCount: 0,
        failedOrders: 0,
        estimatedNotional: 0,
        realizedPnl: 0,
      });
    }

    for (const order of orders) {
      const day = formatDay(order.createdAt);
      const row = map.get(day);

      if (!row) {
        continue;
      }

      row.orderCount += 1;

      if (order.status === 'FAILED') {
        row.failedOrders += 1;
      }

      const price = order.price !== null ? Number(order.price) : 0;
      if (price > 0) {
        row.estimatedNotional += price * order.quantity;
      }
    }

    for (const position of closedPositions) {
      const day = formatDay(position.updatedAt);
      const row = map.get(day);

      if (!row) {
        continue;
      }

      row.realizedPnl += position.realizedPnl !== null ? Number(position.realizedPnl) : 0;
    }

    return Array.from(map.values());
  }

  /**
   * Closed strategy trades grouped by strategy version (positions opened before versioning
   * count as "v1"), then by strategy within each version — so a change can be judged on its
   * own trades instead of being mixed into the overall numbers.
   */
  async getStrategyPerformance(days = 90): Promise<VersionPerformance[]> {
    const safeDays = Math.min(Math.max(days, 1), 365);
    const start = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);

    const positions = await StrategyPosition.findAll({
      where: {
        status: 'CLOSED',
        [Op.and]: [sqlWhere(col('created_at'), Op.gte, start)],
      },
      order: [['createdAt', 'ASC']],
    });

    const meta = (p: StrategyPosition): Record<string, unknown> => (p.metadata ?? {}) as Record<string, unknown>;
    const byVersion = new Map<string, StrategyPosition[]>();
    for (const p of positions) {
      const version = typeof meta(p).strategyVersion === 'string' ? String(meta(p).strategyVersion) : 'v1';
      byVersion.set(version, [...(byVersion.get(version) ?? []), p]);
    }

    return [...byVersion.entries()].map(([version, list]) => {
      const byStrategyLists = new Map<string, StrategyPosition[]>();
      for (const p of list) {
        const name = typeof meta(p).strategyName === 'string' ? String(meta(p).strategyName) : 'UNKNOWN';
        byStrategyLists.set(name, [...(byStrategyLists.get(name) ?? []), p]);
      }

      return {
        version,
        firstTradeAt: list[0]?.createdAt.toISOString() ?? null,
        lastTradeAt: list[list.length - 1]?.createdAt.toISOString() ?? null,
        ...computeStats(list),
        byStrategy: Object.fromEntries([...byStrategyLists.entries()].map(([name, items]) => [name, computeStats(items)])),
      };
    });
  }
}

export const reportService = new ReportService();
