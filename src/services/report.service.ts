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

const formatDay = (date: Date): string => date.toISOString().slice(0, 10);

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
}

export const reportService = new ReportService();
