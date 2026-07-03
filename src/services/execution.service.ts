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
import { TradeOrder } from '../models/trade-order.model';
import { tokenService } from './token.service';
import { tradeEventService } from './trade-event.service';
import { tradeIntentService } from './trade-intent.service';
import { upstoxService } from './upstox.service';
import { marketDataService } from './market-data.service';
import { websocketService } from './websocket.service';
import { atr, ema, rsi, macd, supertrend } from './strategy-registry.service';

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

// Skip an instrument in the monitor after this many consecutive failures
const MONITOR_FAILURE_LIMIT = 5;

class ExecutionService {
  private monitorTimer: NodeJS.Timeout | null = null;
  // Tracks the IST date (YYYY-MM-DD) when EOD square-off last ran.
  // Using a date string instead of a boolean means the flag auto-resets every new trading day
  // without requiring a server restart — fixes the bug where positions stayed OPEN overnight.
  private eodSquareOffDate: string | null = null;
  // Tracks consecutive monitor failures per instrumentKey to prevent Upstox rate limiting
  private monitorFailures = new Map<string, number>();

  private getIstDateString(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  }

  private hasEodRunToday(): boolean {
    return this.eodSquareOffDate === this.getIstDateString();
  }

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
    this.eodSquareOffDate = null;
  }

  /**
   * EMERGENCY EXIT — closes EVERY open position immediately.
   * Bypasses ALL strategy logic, gates, and cooldowns.
   * Also cancels any open/pending orders at broker level.
   *
   * Use cases:
   *   - User-triggered panic button from UI
   *   - System detects unrecoverable error
   *   - API disconnect detected and reconnect failed
   *
   * Returns: count of positions closed and any errors.
   */
  async emergencyExitAll(triggeredBy: string): Promise<{
    closedCount: number;
    failedCount: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    let closedCount = 0;
    let failedCount = 0;

    process.stderr.write(`[EMERGENCY_EXIT] Triggered by: ${triggeredBy}\n`);

    // 1. Pause strategy engine immediately so no new trades open
    // (caller should also call strategyService.setEnabled(false) at API layer)

    // 2. Cancel all pending/open broker orders first
    try {
      const accessToken = await tokenService.getValidAccessToken().catch(() => null);
      if (accessToken) {
        await upstoxService.cancelAllOrders(accessToken);
        process.stderr.write('[EMERGENCY_EXIT] Broker orders cancelled.\n');
      }
    } catch (err) {
      errors.push('Cancel broker orders failed: ' + String(err));
    }

    // 3. Reject all pending-approval intents so they can't be approved later
    try {
      const pending = await TradeIntent.findAll({ where: { status: 'PENDING_APPROVAL' } });
      for (const intent of pending) {
        intent.status = 'REJECTED';
        await intent.save();
      }
    } catch (err) {
      errors.push('Rejecting pending intents failed: ' + String(err));
    }

    // 4. Force-close every open strategy position
    const openPositions = await StrategyPosition.findAll({ where: { status: 'OPEN' } });

    await tradeEventService.emit({
      type: 'EOD_SQUAREOFF_START',
      underlying: 'ALL',
      reason: `EMERGENCY EXIT by ${triggeredBy} — closing ${openPositions.length} positions`,
      metadata: { triggeredBy, count: openPositions.length, isEmergency: true },
    });

    for (const pos of openPositions) {
      const underlying = pos.symbol.split('-')[0] ?? pos.symbol;
      try {
        await this.closePositionWithEvent(Number(pos.id), `EMERGENCY_EXIT:${triggeredBy}`, underlying);
        closedCount++;
      } catch (err) {
        failedCount++;
        const msg = `Failed to close position ${pos.id} (${pos.symbol}): ${String(err)}`;
        errors.push(msg);
        process.stderr.write('[EMERGENCY_EXIT] ' + msg + '\n');

        // Even if close fails: mark the DB record as CLOSED to prevent further monitoring
        try {
          pos.status = 'CLOSED';
          pos.exitReason = `EMERGENCY_EXIT_FORCED:${triggeredBy}`;
          await pos.save();
        } catch { /* DB also failed — nothing we can do */ }
      }
    }

    await tradeEventService.emit({
      type: 'EOD_SQUAREOFF_DONE',
      underlying: 'ALL',
      reason: `EMERGENCY EXIT complete — ${closedCount} closed, ${failedCount} failed`,
      metadata: { triggeredBy, closedCount, failedCount, errors, isEmergency: true },
    });

    process.stderr.write(`[EMERGENCY_EXIT] Done. Closed: ${closedCount}, Failed: ${failedCount}\n`);

    return { closedCount, failedCount, errors };
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
      if (isEodSquareOffTime() && !this.hasEodRunToday()) {
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
    // Record the IST date so this only runs once per trading day even across midnight
    this.eodSquareOffDate = this.getIstDateString();

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

        // If the broker/order call failed, force-close the DB record anyway so the position
        // doesn't stay stuck as OPEN overnight (same pattern as emergency exit).
        try {
          const lastPrice = pos.currentPrice !== null ? Number(pos.currentPrice) : Number(pos.entryPrice);
          const realizedPnl = pos.side === 'BUY'
            ? (lastPrice - Number(pos.entryPrice)) * pos.quantity
            : (Number(pos.entryPrice) - lastPrice) * pos.quantity;
          pos.status = 'CLOSED';
          pos.exitReason = 'EOD_SQUAREOFF_FORCED';
          pos.realizedPnl = realizedPnl;
          pos.unrealizedPnl = 0;
          await pos.save();
          websocketService.broadcast('position_update', {
            id: Number(pos.id),
            symbol: pos.symbol,
            instrumentKey: pos.instrumentKey,
            side: pos.side,
            quantity: pos.quantity,
            entryPrice: Number(pos.entryPrice),
            currentPrice: lastPrice,
            unrealizedPnl: 0,
            unrealizedPnlPct: 0,
            stopLossPrice: Number(pos.stopLossPrice),
            targetPrice: Number(pos.targetPrice),
            trailActive: pos.trailActive,
            bestPrice: Number(pos.bestPrice),
            status: 'CLOSED',
          });
          closedCount++;
        } catch { /* DB also failed — nothing we can do */ }
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

    // Batch-fetch LTPs for all active positions in one API call (N→1 per cycle).
    // Falls back gracefully: if batch fails, each position falls back to getNiftyLtp().
    const activeKeys = openPositions
      .filter((p) => (this.monitorFailures.get(p.instrumentKey) ?? 0) < MONITOR_FAILURE_LIMIT)
      .map((p) => p.instrumentKey);

    let batchQuotes: Record<string, { ltp: number | null; close: number | null; raw: Record<string, unknown> }> = {};
    if (activeKeys.length) {
      try {
        batchQuotes = await upstoxService.getFullMarketQuote(accessToken, activeKeys);
      } catch {
        // Batch failed — each position falls back to individual getNiftyLtp()
      }
    }

    for (const position of openPositions) {
      const failures = this.monitorFailures.get(position.instrumentKey) ?? 0;
      if (failures >= MONITOR_FAILURE_LIMIT) {
        // Already failing repeatedly — skip to avoid Upstox rate limiting.
        // Will auto-resume if position is closed or manually reset.
        continue;
      }

      try {
        const prefetchedLtp = batchQuotes[position.instrumentKey]?.ltp ?? undefined;
        await this.monitorSinglePosition(position, accessToken, prefetchedLtp);
        // Clear failure count on success
        this.monitorFailures.delete(position.instrumentKey);
      } catch (err) {
        const newCount = failures + 1;
        this.monitorFailures.set(position.instrumentKey, newCount);
        process.stderr.write(
          '[Monitor] ' + position.instrumentKey + ': ' + String(err) +
          (newCount >= MONITOR_FAILURE_LIMIT
            ? ' — skipping this instrument (too many failures)\n'
            : ' (failure ' + newCount + '/' + MONITOR_FAILURE_LIMIT + ')\n'),
        );
      }
    }
  }

  private async monitorSinglePosition(
    position: StrategyPosition,
    accessToken: string,
    prefetchedLtp?: number | null,
  ): Promise<void> {
    const ltp = prefetchedLtp != null
      ? prefetchedLtp
      : (await upstoxService.getNiftyLtp(accessToken, position.instrumentKey)).ltp;
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

    // Push live P&L to frontend via WebSocket immediately (no polling needed)
    websocketService.broadcast('position_update', {
      id: Number(position.id),
      symbol: position.symbol,
      instrumentKey: position.instrumentKey,
      side: position.side,
      quantity: position.quantity,
      entryPrice: Number(position.entryPrice),
      currentPrice: ltp,
      unrealizedPnl,
      unrealizedPnlPct: pnlPct,
      stopLossPrice: Number(position.stopLossPrice),
      targetPrice: Number(position.targetPrice),
      trailActive: position.trailActive,
      bestPrice: newBestPrice,
      status: position.status,
    });

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
      return;
    }

    // Technical reversal check — exit early if trend has reversed against us
    // Only fires when pnlPct > 5% to avoid noise exits on small moves
    try {
      const reversal = await this.checkTechnicalReversal(position, ltp, pnlPct);
      if (reversal.shouldExit) {
        await this.closePositionWithEvent(Number(position.id), reversal.reason, underlying);
      }
    } catch {
      // Non-critical — skip if reversal check fails
    }
  }

  // ── Technical reversal detector ───────────────────────────────────────
  /**
   * Checks whether the underlying's trend has reversed against the open position.
   * Only runs once the trailing stop has activated (pnlPct >= STRATEGY_TRAIL_ACTIVATION_PCT,
   * same gate as position.trailActive). Previously this fired from pnlPct > 5%, which meant
   * it competed with — and almost always pre-empted — the trailing stop and profit target:
   * historically 57% of trades exited here at an average of just ~17% of the way to target,
   * and zero trades ever reached TARGET_HIT. Gating on trailActive lets winners run to at
   * least the trail-activation threshold before any early-exit logic can cut them short.
   * The stop-loss path (monitorSinglePosition's stopHit check) is untouched, so max loss
   * per trade is unaffected by this change — only how early winners can be harvested.
   *
   * Exit signals checked:
   *   1. Supertrend flipped against position direction
   *   2. EMA death cross (9 < 21) while LONG; golden cross while SHORT
   *   3. RSI extreme exhaustion (> 87 while long, < 13 while short)
   *   4. MACD histogram reversal (histogram turned against position, pnl > 18%)
   */
  private async checkTechnicalReversal(
    position: StrategyPosition,
    ltp: number,
    pnlPct: number,
  ): Promise<{ shouldExit: boolean; reason: string }> {
    // Only intervene once trailing stop is active — let winners breathe past the first 5-11%
    if (!position.trailActive) return { shouldExit: false, reason: '' };

    const underlying = position.symbol.split('-')[0] ?? position.symbol;
    let prices: number[];

    try {
      // Get underlying index price history (not option prices)
      const underlyingKey = position.metadata
        ? (position.metadata as Record<string, unknown>).underlyingInstrumentKey as string | undefined
        : undefined;
      const history = await marketDataService.getTickHistory(50, underlyingKey);
      if (history.length < 25) return { shouldExit: false, reason: '' };
      prices = history.map((t) => t.ltp);
    } catch {
      return { shouldExit: false, reason: '' };
    }

    const isLong = position.side === 'BUY'; // BUY = long option (call or put)
    const isBullishPosition = position.symbol.endsWith('-CE'); // CE = expecting up move

    // 1. Supertrend reversal
    const stDir = supertrend(prices, 10, 3.0);
    if (stDir) {
      const stBullish = stDir === 'BULLISH';
      if (isBullishPosition && !stBullish) {
        return { shouldExit: true, reason: `TECH_REVERSAL: Supertrend flipped BEARISH while long CE (pnl=${pnlPct.toFixed(1)}%)` };
      }
      if (!isBullishPosition && stBullish) {
        return { shouldExit: true, reason: `TECH_REVERSAL: Supertrend flipped BULLISH while long PE (pnl=${pnlPct.toFixed(1)}%)` };
      }
    }

    // 2. EMA cross reversal — only trigger on confirmed cross
    const ema9Now = ema(prices, 9);
    const ema21Now = ema(prices, 21);
    const ema9Prev = ema(prices.slice(0, -2), 9);
    const ema21Prev = ema(prices.slice(0, -2), 21);
    const deathCross = ema9Prev > ema21Prev && ema9Now < ema21Now;
    const goldenCross = ema9Prev < ema21Prev && ema9Now > ema21Now;
    if (isBullishPosition && deathCross) {
      return { shouldExit: true, reason: `TECH_REVERSAL: EMA death cross while long CE (pnl=${pnlPct.toFixed(1)}%)` };
    }
    if (!isBullishPosition && goldenCross) {
      return { shouldExit: true, reason: `TECH_REVERSAL: EMA golden cross while long PE (pnl=${pnlPct.toFixed(1)}%)` };
    }

    // 3. RSI exhaustion — only exit at extreme levels
    const rsi14 = rsi(prices, 14);
    if (isBullishPosition && rsi14 > 87) {
      return { shouldExit: true, reason: `TECH_REVERSAL: RSI exhaustion ${rsi14.toFixed(0)} while long CE (pnl=${pnlPct.toFixed(1)}%)` };
    }
    if (!isBullishPosition && rsi14 < 13) {
      return { shouldExit: true, reason: `TECH_REVERSAL: RSI exhaustion ${rsi14.toFixed(0)} while long PE (pnl=${pnlPct.toFixed(1)}%)` };
    }

    // 4. MACD histogram reversal (consecutive ticks against position)
    const { histogram: histNow } = macd(prices);
    const { histogram: histPrev } = macd(prices.slice(0, -2));
    const macdTurningAgainstLong = isBullishPosition && histNow < 0 && histPrev > 0;
    const macdTurningAgainstShort = !isBullishPosition && histNow > 0 && histPrev < 0;
    if (macdTurningAgainstLong && pnlPct > 18) {
      return { shouldExit: true, reason: `TECH_REVERSAL: MACD histogram crossed below zero while long CE (pnl=${pnlPct.toFixed(1)}%)` };
    }
    if (macdTurningAgainstShort && pnlPct > 18) {
      return { shouldExit: true, reason: `TECH_REVERSAL: MACD histogram crossed above zero while long PE (pnl=${pnlPct.toFixed(1)}%)` };
    }

    return { shouldExit: false, reason: '' };
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

      // Notify frontend immediately so P&L panel disappears without polling
      websocketService.broadcast('position_update', {
        id: Number(position.id),
        symbol: position.symbol,
        instrumentKey: position.instrumentKey,
        side: position.side,
        quantity: position.quantity,
        entryPrice: Number(position.entryPrice),
        currentPrice: lastPrice,
        unrealizedPnl: 0,
        unrealizedPnlPct: 0,
        stopLossPrice: Number(position.stopLossPrice),
        targetPrice: Number(position.targetPrice),
        trailActive: position.trailActive,
        bestPrice: Number(position.bestPrice),
        status: 'CLOSED',
      });

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
      where: { status: 'APPROVED', requiresApproval: true },
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
