/**
 * execution.service.ts
 *
 * The trade execution and position lifecycle engine.
 *
 * Responsibilities:
 *   1. Auto-execute approved intents (configurable: auto vs manual approval)
 *   2. Manage open positions: trailing SL, target hit, EOD square-off
 *   3. Emit trade events for every state change (dashboard + audit log)
 *   4. Write PnL ticks for live chart
 *   5. EOD square-off sweep at 3:10 PM IST
 *
 * This is intentionally separate from strategy.service.ts so that:
 *   - Strategy logic (signal building) stays clean and testable
 *   - Execution logic (order placement, position management) stays focused
 *   - Each can be started/stopped independently
 */

import { env } from '../config/env';
import { PositionPnlTick } from '../models/position-pnl-tick.model';
import { StrategyPosition } from '../models/strategy-position.model';
import { TradeIntent } from '../models/trade-intent.model';
import { tokenService } from './token.service';
import { tradeEventService } from './trade-event.service';
import { tradeIntentService } from './trade-intent.service';
import { upstoxService } from './upstox.service';

// ── EOD square-off time: 3:10 PM IST (5 min before market close) ──────────
const EOD_SQUAREOFF_HOUR = 15;
const EOD_SQUAREOFF_MINUTE = 10;

function getIstHourMinute(): { h: number; m: number } {
  const now = new Date();
  const ist = now.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const [h, m] = ist.split(':').map(Number);
  return { h, m };
}

function isEodSquareOffTime(): boolean {
  const { h, m } = getIstHourMinute();
  return h > EOD_SQUAREOFF_HOUR || (h === EOD_SQUAREOFF_HOUR && m >= EOD_SQUAREOFF_MINUTE);
}

// ── Service ────────────────────────────────────────────────────────────────

class ExecutionService {
  private monitorTimer: NodeJS.Timeout | null = null;
  private eodSquaredOff = false;

  /**
   * Start the execution engine.
   * Runs two loops:
   *   - monitorInterval (5s): check open positions for SL/target/EOD
   *   - Auto-execute pending intents on each cycle
   */
  start(): void {
    if (this.monitorTimer) return;

    this.monitorTimer = setInterval(() => {
      void this.runMonitorCycle();
    }, 5000); // Every 5 seconds

    void this.runMonitorCycle();
  }

  stop(): void {
    if (!this.monitorTimer) return;
    clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  resetEodFlag(): void {
    this.eodSquaredOff = false;
  }

  // ── Auto-execute pending intents ─────────────────────────────────────
  /**
   * Called after a new intent is created. If REQUIRE_TRADE_APPROVAL=false,
   * this auto-approves immediately. Otherwise it just logs.
   *
   * In a real system you would surface the pending intent to the dashboard
   * and let the trader approve/reject within the expiry window.
   */
  async processNewIntent(intentId: number, underlying: string): Promise<void> {
    if (env.requireTradeApproval) {
      // Manual approval mode — notify dashboard via WS, wait for user action
      await tradeEventService.emit({
        type: 'INTENT_CREATED',
        underlying,
        intentId,
        reason: 'Pending manual approval — approve from dashboard within 10 minutes',
      });
      return;
    }

    // Auto-approval mode — execute immediately
    try {
      const { intent, order } = await tradeIntentService.approveIntent(intentId, 'system:auto');

      await tradeEventService.emit({
        type: 'ORDER_PLACED',
        underlying,
        intentId,
        orderId: Number(order.id),
        symbol: intent.symbol,
        side: intent.side,
        price: order.price !== null ? Number(order.price) : intent.price !== null ? Number(intent.price) : undefined,
        quantity: intent.quantity,
        reason: `Auto-executed. Paper=${order.isPaper}`,
        metadata: { providerOrderId: order.providerOrderId, status: order.status },
      });

      await tradeEventService.emit({
        type: 'POSITION_OPENED',
        underlying,
        intentId,
        orderId: Number(order.id),
        symbol: intent.symbol,
        side: intent.side,
        price: order.price !== null ? Number(order.price) : Number(intent.price ?? 0),
        quantity: intent.quantity,
        reason: 'Position opened after auto-execution',
      });

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await tradeEventService.emit({
        type: 'ORDER_FAILED',
        underlying,
        intentId,
        reason: 'Auto-execution failed: ' + msg,
      });
    }
  }

  // ── Main monitor cycle ────────────────────────────────────────────────
  private async runMonitorCycle(): Promise<void> {
    try {
      // 1. EOD square-off check
      if (isEodSquareOffTime() && !this.eodSquaredOff) {
        await this.runEodSquareOff();
        return; // No point checking SL/target after EOD
      }

      // 2. Manage all open positions
      await this.manageOpenPositions();

      // 3. Auto-execute any approved-but-not-executed intents
      await this.executeApprovedIntents();

    } catch (err) {
      process.stderr.write('[ExecutionEngine] Cycle error: ' + String(err) + '\n');
    }
  }

  // ── EOD square-off ────────────────────────────────────────────────────
  private async runEodSquareOff(): Promise<void> {
    this.eodSquaredOff = true;

    const openPositions = await StrategyPosition.findAll({
      where: { status: 'OPEN' },
    });

    if (!openPositions.length) return;

    await tradeEventService.emit({
      type: 'EOD_SQUAREOFF_START',
      underlying: 'ALL',
      reason: `EOD sweep — closing ${openPositions.length} open position(s)`,
      metadata: { count: openPositions.length },
    });

    let closedCount = 0;

    for (const pos of openPositions) {
      try {
        await this.closePositionWithEvent(
          Number(pos.id),
          'EOD_SQUAREOFF',
          pos.symbol.split('-')[0] ?? pos.symbol,
        );
        closedCount++;
      } catch (err) {
        process.stderr.write('[EOD] Failed to close position ' + pos.id + ': ' + String(err) + '\n');
      }
    }

    await tradeEventService.emit({
      type: 'EOD_SQUAREOFF_DONE',
      underlying: 'ALL',
      reason: `EOD complete — closed ${closedCount}/${openPositions.length} positions`,
      metadata: { closedCount, totalCount: openPositions.length },
    });
  }

  // ── Position management with trailing SL ─────────────────────────────
  private async manageOpenPositions(): Promise<void> {
    const openPositions = await StrategyPosition.findAll({
      where: { status: 'OPEN' },
      limit: 50,
      order: [['createdAt', 'ASC']],
    });

    if (!openPositions.length) return;

    let accessToken: string;
    try {
      accessToken = await tokenService.getValidAccessToken();
    } catch {
      return; // No token — skip this cycle
    }

    for (const position of openPositions) {
      try {
        await this.monitorSinglePosition(position, accessToken);
      } catch (err) {
        process.stderr.write(
          '[Monitor] ' + position.instrumentKey + ': ' + String(err) + '\n',
        );
      }
    }
  }

  private async monitorSinglePosition(
    position: StrategyPosition,
    accessToken: string,
  ): Promise<void> {
    const quote = await upstoxService.getNiftyLtp(accessToken, position.instrumentKey);
    const ltp = quote.ltp;
    const entryPrice = Number(position.entryPrice);
    const underlying = position.symbol.split('-')[0] ?? position.symbol;

    // Update current price and unrealized PnL
    const unrealizedPnl = position.side === 'BUY'
      ? (ltp - entryPrice) * position.quantity
      : (entryPrice - ltp) * position.quantity;

    const pnlPct = position.side === 'BUY'
      ? ((ltp - entryPrice) / entryPrice) * 100
      : ((entryPrice - ltp) / entryPrice) * 100;

    // Update high-water mark
    const prevBestPrice = Number(position.bestPrice);
    const newBestPrice = position.side === 'BUY'
      ? Math.max(prevBestPrice, ltp)
      : Math.min(prevBestPrice, ltp);

    position.currentPrice = ltp;
    position.unrealizedPnl = unrealizedPnl;
    position.bestPrice = newBestPrice;

    // Trailing SL logic
    let slUpdated = false;
    if (pnlPct >= env.strategyTrailActivationPct) {
      const wasActive = position.trailActive;
      position.trailActive = true;

      let newSl: number;
      if (position.side === 'BUY') {
        const trailFromBest = newBestPrice * (1 - env.strategyTrailOffsetPct / 100);
        const lockProfit = entryPrice * 1.01;
        newSl = Math.max(Number(position.stopLossPrice), trailFromBest, lockProfit);
      } else {
        const trailFromBest = newBestPrice * (1 + env.strategyTrailOffsetPct / 100);
        const lockProfit = entryPrice * 0.99;
        newSl = Math.min(Number(position.stopLossPrice), trailFromBest, lockProfit);
      }

      if (newSl !== Number(position.stopLossPrice)) {
        slUpdated = true;
        position.stopLossPrice = newSl;
      }

      // Emit trail-started only once
      if (!wasActive && position.trailActive) {
        await tradeEventService.emit({
          type: 'POSITION_TRAIL_STARTED',
          underlying,
          positionId: Number(position.id),
          symbol: position.symbol,
          price: ltp,
          stopLossPrice: newSl,
          pnl: unrealizedPnl,
          pnlPct,
          reason: `Trail activated at +${pnlPct.toFixed(1)}%, SL moved to ${newSl.toFixed(1)}`,
        });
      }
    }

    await position.save();

    // Write PnL tick for live chart
    try {
      await PositionPnlTick.create({
        positionId: Number(position.id),
        currentPremium: ltp,
        unrealizedPnl,
        unrealizedPnlPct: pnlPct,
        stopLossPrice: Number(position.stopLossPrice),
        highWaterMark: newBestPrice,
        trailActive: position.trailActive,
      });
    } catch { /* non-critical */ }

    // Emit SL update if it moved
    if (slUpdated) {
      await tradeEventService.emit({
        type: 'POSITION_SL_UPDATED',
        underlying,
        positionId: Number(position.id),
        symbol: position.symbol,
        price: ltp,
        stopLossPrice: Number(position.stopLossPrice),
        pnl: unrealizedPnl,
        pnlPct,
        reason: `Trailing SL moved to ${Number(position.stopLossPrice).toFixed(1)}`,
      });
    }

    // Exit checks
    const stopHit = position.side === 'BUY'
      ? ltp <= Number(position.stopLossPrice)
      : ltp >= Number(position.stopLossPrice);

    const targetHit = position.side === 'BUY'
      ? ltp >= Number(position.targetPrice)
      : ltp <= Number(position.targetPrice);

    if (stopHit) {
      await this.closePositionWithEvent(Number(position.id), 'STOP_LOSS_HIT', underlying);
      return;
    }

    if (targetHit || pnlPct >= env.strategyProfitTargetPct) {
      await this.closePositionWithEvent(Number(position.id), 'TARGET_HIT', underlying);
    }
  }

  // ── Close position + emit event ───────────────────────────────────────
  async closePositionWithEvent(
    positionId: number,
    reason: string,
    underlying: string,
  ): Promise<void> {
    const position = await StrategyPosition.findByPk(positionId);
    if (!position || position.status !== 'OPEN') return;

    // Place exit order
    try {
      const exitIntent = await tradeIntentService.createIntent({
        source: 'STRATEGY',
        side: position.side === 'BUY' ? 'SELL' : 'BUY',
        symbol: position.symbol,
        instrumentKey: position.instrumentKey,
        quantity: position.quantity,
        orderType: 'MARKET',
        product: 'I',
        validity: 'DAY',
        tag: 'exit-' + String(position.id),
        requiresApproval: false,
        rationale: 'Exit: ' + reason,
        metadata: { isExitIntent: true, positionId: position.id, exitReason: reason },
      });

      const lastPrice = position.currentPrice !== null
        ? Number(position.currentPrice)
        : Number(position.entryPrice);

      const realizedPnl = position.side === 'BUY'
        ? (lastPrice - Number(position.entryPrice)) * position.quantity
        : (Number(position.entryPrice) - lastPrice) * position.quantity;

      const pnlPct = (realizedPnl / (Number(position.entryPrice) * position.quantity)) * 100;

      position.status = 'CLOSED';
      position.exitReason = reason;
      position.closedOrderId = exitIntent.executedOrderId;
      position.realizedPnl = realizedPnl;
      position.unrealizedPnl = 0;
      await position.save();

      await tradeEventService.emit({
        type: 'POSITION_CLOSED',
        underlying,
        positionId: Number(position.id),
        symbol: position.symbol,
        side: position.side,
        price: lastPrice,
        quantity: position.quantity,
        pnl: realizedPnl,
        pnlPct,
        reason,
        metadata: {
          entryPrice: Number(position.entryPrice),
          exitPrice: lastPrice,
          trailWasActive: position.trailActive,
          highWaterMark: Number(position.bestPrice),
        },
      });

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await tradeEventService.emit({
        type: 'SYSTEM_ERROR',
        underlying,
        positionId,
        reason: 'Failed to close position: ' + msg,
      });
    }
  }

  // ── Execute approved-but-pending intents ──────────────────────────────
  private async executeApprovedIntents(): Promise<void> {
    const approved = await TradeIntent.findAll({
      where: { status: 'APPROVED' },
      limit: 10,
      order: [['createdAt', 'ASC']],
    });

    for (const intent of approved) {
      const meta = intent.metadata as Record<string, unknown>;
      if (meta.isExitIntent === true) continue; // Exit intents are handled in closePosition

      try {
        await tradeIntentService.approveIntent(Number(intent.id), 'system:execution-engine', true);
      } catch (err) {
        process.stderr.write('[ExecutionEngine] Failed to execute intent ' + intent.id + ': ' + String(err) + '\n');
      }
    }
  }
}

export const executionService = new ExecutionService();
