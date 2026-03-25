/**
 * strategy.service.ts
 *
 * Orchestrates the signal generation pipeline.
 * Execution (order placement, position monitoring) is handled by execution.service.ts
 *
 * Flow per cycle:
 *   1. Risk gate
 *   2. Pending-intent guard
 *   3. Time / expiry filters
 *   4. Fetch market data + option chain
 *   5. Run all strategies via registry (SMA_PCR, VWAP_BOUNCE, EMA_CROSS)
 *   6. Rule-based probability pre-check
 *   7. AI confidence check (optional)
 *   8. Create TradeIntent → hand off to execution.service
 *   9. Log every outcome to strategy_decision_logs
 */

import { Op, col, where as sqlWhere } from 'sequelize';
import { env } from '../config/env';
import { ApiError } from '../middleware/error.middleware';
import { StrategyDecisionLog, RejectionCategory } from '../models/strategy-decision-log.model';
import { StrategyPosition } from '../models/strategy-position.model';
import { TradeIntent } from '../models/trade-intent.model';
import { StrategyRiskSnapshot, StrategySignal } from '../types/trading.types';
import {
  AiDecisionParams,
  AiDecisionResult,
  computeRuleBasedDecision,
  getAiTradeDecision,
} from './ai-decision.service';
import { executionService } from './execution.service';
import { marketDataService } from './market-data.service';
import { StrategyContext, strategyRegistry } from './strategy-registry.service';
import { tokenService } from './token.service';
import { tradeEventService } from './trade-event.service';
import { tradeIntentService } from './trade-intent.service';
import { underlyingService } from './underlying.service';

// ── Helpers ────────────────────────────────────────────────────────────────

const startOfDay = (): Date => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
};
const sameDayIso = (): string => new Date().toISOString().slice(0, 10);

const getIstTime = (): { timeIST: string; minutesToClose: number; minutesSinceOpen: number } => {
  const now = new Date();
  const ist = now.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const [h, m] = ist.split(':').map(Number);
  const minutesToClose = Math.max(0, (15 * 60 + 15) - (h * 60 + m));
  const minutesSinceOpen = (h - 9) * 60 + (m - 15);
  return { timeIST: ist, minutesToClose, minutesSinceOpen };
};

// ── DB decision logger ────────────────────────────────────────────────────

interface DecisionLogInput {
  underlying: string;
  indexPrice?: number | null;
  decision: 'ACCEPTED' | 'REJECTED' | 'FAILED';
  rejectionCategory?: RejectionCategory;
  rejectionReason?: string;
  errorMessage?: string;
  intentId?: number;
  optionType?: string | null;
  strikePrice?: number | null;
  entryPremium?: number;
  stopLossPrice?: number;
  targetPrice?: number;
  confidence?: number;
  signalSource?: string;
  rationale?: string;
  signalMetadata?: Record<string, unknown>;
  latencyMs?: number;
  aiProvider?: string | null;
  aiLatencyMs?: number | null;
  tradeOfDay?: number;
}

async function logDecision(input: DecisionLogInput): Promise<void> {
  try {
    await StrategyDecisionLog.create({
      underlying: input.underlying,
      indexPrice: input.indexPrice ?? null,
      decision: input.decision,
      rejectionCategory: input.rejectionCategory ?? null,
      rejectionReason: input.rejectionReason ?? null,
      errorMessage: input.errorMessage ?? null,
      intentId: input.intentId ?? null,
      optionType: input.optionType ?? null,
      strikePrice: input.strikePrice ?? null,
      entryPremium: input.entryPremium ?? null,
      stopLossPrice: input.stopLossPrice ?? null,
      targetPrice: input.targetPrice ?? null,
      confidence: input.confidence ?? null,
      signalSource: input.signalSource ?? null,
      rationale: input.rationale ?? null,
      signalMetadata: input.signalMetadata ?? {},
      latencyMs: input.latencyMs ?? null,
      aiProvider: input.aiProvider ?? null,
      aiLatencyMs: input.aiLatencyMs ?? null,
      tradeOfDay: input.tradeOfDay ?? null,
    });
  } catch (err) {
    process.stderr.write('[DecisionLog] DB write failed: ' + String(err) + '\n');
  }
}

// ── Service ────────────────────────────────────────────────────────────────

class StrategyService {
  private timer: NodeJS.Timeout | null = null;
  private enabled = env.strategyEnabled;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runCycle(); }, env.strategyScanIntervalMs);
    executionService.start();
    void this.runCycle();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    executionService.stop();
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled; }
  isEnabled(): boolean { return this.enabled; }

  async getStatus() {
    const risk = await this.getRiskSnapshot();
    const [openPositions, pendingIntents] = await Promise.all([
      StrategyPosition.count({ where: { status: 'OPEN' } }),
      TradeIntent.count({ where: { source: 'STRATEGY', status: 'PENDING_APPROVAL' } }),
    ]);
    return {
      enabled: this.enabled,
      activeUnderlying: underlyingService.getActive().symbol,
      enabledStrategies: strategyRegistry.getEnabled(),
      risk,
      openPositions,
      pendingIntents,
    };
  }

  // ── Core: evaluate + optionally queue an intent ──────────────────────
  async evaluateAndQueueSignal(createIntent = true): Promise<{
    signal: StrategySignal | null;
    intentId: number | null;
    logId: number | null;
    decisionSource: string;
    strategyName: string | null;
  }> {
    const cycleStart = Date.now();
    const underlying = underlyingService.getActive();
    const sym = underlying.symbol;

    // 1. Risk gate
    const risk = await this.getRiskSnapshot();
    if (risk.blocked) {
      await logDecision({ underlying: sym, decision: 'REJECTED', rejectionCategory: 'RISK_BLOCKED', rejectionReason: risk.blockReason ?? 'Risk limit', latencyMs: Date.now() - cycleStart });
      await tradeEventService.emit({ type: 'RISK_BLOCKED', underlying: sym, reason: risk.blockReason ?? 'Risk limit' });
      return { signal: null, intentId: null, logId: null, decisionSource: 'risk-gate', strategyName: null };
    }

    // 2. No pending intents
    const existingPending = await TradeIntent.count({ where: { source: 'STRATEGY', status: 'PENDING_APPROVAL' } });
    if (existingPending > 0) {
      await logDecision({ underlying: sym, decision: 'REJECTED', rejectionCategory: 'PENDING_INTENT', rejectionReason: 'Pending approval intent exists', latencyMs: Date.now() - cycleStart });
      return { signal: null, intentId: null, logId: null, decisionSource: 'pending-guard', strategyName: null };
    }

    // 3. Time filter
    const { timeIST, minutesToClose, minutesSinceOpen } = getIstTime();
    if (minutesSinceOpen < 15) {
      await logDecision({ underlying: sym, decision: 'REJECTED', rejectionCategory: 'MARKET_HOURS', rejectionReason: `Too early (${timeIST} IST)`, latencyMs: Date.now() - cycleStart });
      return { signal: null, intentId: null, logId: null, decisionSource: 'time-filter', strategyName: null };
    }
    if (minutesToClose < 30) {
      await logDecision({ underlying: sym, decision: 'REJECTED', rejectionCategory: 'MARKET_HOURS', rejectionReason: `Too close to close (${minutesToClose} min)`, latencyMs: Date.now() - cycleStart });
      return { signal: null, intentId: null, logId: null, decisionSource: 'time-filter', strategyName: null };
    }

    // 4. Build market context
    let latestIndexPrice: number | null = null;
    let strategyContext: StrategyContext | null = null;

    try {
      const tick = await marketDataService.getLatestTick(underlying.instrumentKey);
      latestIndexPrice = tick?.ltp ?? null;

      if (!latestIndexPrice) {
        // No live tick yet — try fetching
        const fetched = await marketDataService.fetchAndStoreTick(underlying.instrumentKey, underlying.symbol).catch(() => null);
        latestIndexPrice = fetched?.ltp ?? null;
      }

      const history = await marketDataService.getTickHistory(80, underlying.instrumentKey);
      if (history.length < 20) {
        await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'REJECTED', rejectionCategory: 'NO_SIGNAL', rejectionReason: `Insufficient history: ${history.length} ticks (need 20)`, latencyMs: Date.now() - cycleStart });
        return { signal: null, intentId: null, logId: null, decisionSource: 'no-history', strategyName: null };
      }

      const prices = history.map((t) => t.ltp);
      const lastPrice = latestIndexPrice ?? prices[prices.length - 1];

      // Option chain
      const chain = await marketDataService.fetchAndStoreOptionChain(undefined, underlying.symbol).catch(() => null);
      if (!chain?.expiryDate) {
        await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'REJECTED', rejectionCategory: 'NO_SIGNAL', rejectionReason: 'Option chain not available', latencyMs: Date.now() - cycleStart });
        return { signal: null, intentId: null, logId: null, decisionSource: 'no-chain', strategyName: null };
      }

      if (chain.expiryDate === sameDayIso()) {
        await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'REJECTED', rejectionCategory: 'EXPIRY_DAY', rejectionReason: 'Today is expiry day', latencyMs: Date.now() - cycleStart });
        return { signal: null, intentId: null, logId: null, decisionSource: 'expiry-day', strategyName: null };
      }

      const nearAtm = [...chain.rows]
        .sort((a, b) => Math.abs(a.strikePrice - lastPrice) - Math.abs(b.strikePrice - lastPrice))
        .slice(0, 5);

      const atmRow = nearAtm[0];
      if (!atmRow) {
        await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'REJECTED', rejectionCategory: 'NO_LIQUID_OPTION', rejectionReason: 'No ATM row found', latencyMs: Date.now() - cycleStart });
        return { signal: null, intentId: null, logId: null, decisionSource: 'no-atm', strategyName: null };
      }

      const totalPutOi = nearAtm.reduce((s, r) => s + (r.putOi ?? 0), 0);
      const totalCallOi = nearAtm.reduce((s, r) => s + (r.callOi ?? 0), 0);
      const pcr = totalCallOi > 0 ? totalPutOi / totalCallOi : 1;

      strategyContext = {
        underlying: sym,
        prices,
        lastPrice,
        pcr,
        atmStrike: atmRow.strikePrice,
        callLtp: atmRow.callLtp ?? 0,
        putLtp: atmRow.putLtp ?? 0,
        callInstrumentKey: atmRow.callInstrumentKey,
        putInstrumentKey: atmRow.putInstrumentKey,
        expiryDate: chain.expiryDate,
        timeIST,
        minutesToClose,
        lotSize: underlying.defaultLotSize,
      };

    } catch (buildError) {
      const msg = buildError instanceof Error ? buildError.message : String(buildError);
      await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'FAILED', errorMessage: 'Context build: ' + msg, latencyMs: Date.now() - cycleStart });
      return { signal: null, intentId: null, logId: null, decisionSource: 'build-error', strategyName: null };
    }

    // 5. Run strategy registry
    const registryResult = strategyRegistry.runAll(strategyContext);
    if (!registryResult) {
      await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'REJECTED', rejectionCategory: 'NO_SIGNAL', rejectionReason: 'No strategy produced a signal', latencyMs: Date.now() - cycleStart });
      return { signal: null, intentId: null, logId: null, decisionSource: 'no-signal', strategyName: null };
    }

    const { signal, strategyName } = registryResult;

    // 6. Rule-based probability check
    const meta = signal.metadata as Record<string, unknown>;
    const optionType: 'CALL' | 'PUT' = (meta.bullish as boolean) ? 'CALL' : 'PUT';

    const ruleParams: AiDecisionParams = {
      index: sym, currentPrice: latestIndexPrice ?? 0,
      atmStrike: (meta.strike as number) ?? 0, optionType, optionPremium: signal.entryPrice,
      rsi14: (meta.rsi14 as number) ?? 50, ema9: (meta.ema9 as number) ?? 0, ema21: (meta.ema21 as number) ?? 0,
      macd: (meta.macd as number) ?? 0, macdSignal: (meta.macdSignal as number) ?? 0,
      macdHistogram: (meta.macdHistogram as number) ?? 0,
      vwap: (meta.vwap as number) ?? (latestIndexPrice ?? 0), volumeRatio: (meta.volumeRatio as number) ?? 1,
      dayHigh: (meta.dayHigh as number) ?? (latestIndexPrice ?? 0), dayLow: (meta.dayLow as number) ?? (latestIndexPrice ?? 0),
      prevDayClose: (meta.prevDayClose as number) ?? (latestIndexPrice ?? 0),
      atmCallOI: (meta.atmCallOI as number) ?? 0, atmPutOI: (meta.atmPutOI as number) ?? 0,
      pcrRatio: (meta.pcr as number) ?? 1, ivPercentile: (meta.ivPercentile as number) ?? 40,
      indiaVix: env.indiaVixOverride || (meta.indiaVix as number) || 14,
      timeIST, minutesToClose,
    };

    const ruleResult = computeRuleBasedDecision(ruleParams);

    if (ruleResult.action === 'SKIP' && !env.aiEnabled) {
      await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'REJECTED', rejectionCategory: 'LOW_CONFIDENCE', rejectionReason: `Rules SKIP. Bull=${ruleResult.rawBullScore} Bear=${ruleResult.rawBearScore}`, confidence: signal.confidence, signalSource: signal.source, rationale: signal.rationale, signalMetadata: { ...signal.metadata, ruleSignals: ruleResult.signals, strategyName }, latencyMs: Date.now() - cycleStart });
      await tradeEventService.emit({ type: 'SIGNAL_REJECTED', underlying: sym, reason: 'Rule-based skip', strategy: strategyName, metadata: { ruleSignals: ruleResult.signals } });
      return { signal, intentId: null, logId: null, decisionSource: 'rules-skip', strategyName };
    }

    // 7. Confidence gate
    if (signal.confidence < env.strategyConfidenceThreshold) {
      await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'REJECTED', rejectionCategory: 'LOW_CONFIDENCE', rejectionReason: `Confidence ${(signal.confidence * 100).toFixed(1)}% < ${(env.strategyConfidenceThreshold * 100).toFixed(1)}%`, confidence: signal.confidence, signalSource: signal.source, rationale: signal.rationale, signalMetadata: signal.metadata, latencyMs: Date.now() - cycleStart });
      return { signal, intentId: null, logId: null, decisionSource: 'confidence-gate', strategyName };
    }

    // 8. AI decision
    let aiLatencyMs: number | null = null;
    let finalConfidence = signal.confidence;
    let decisionSource = 'rules-only';
    let aiProvider: string | null = null;

    if (env.aiEnabled && env.aiProvider !== 'none') {
      const aiResult = await getAiTradeDecision(ruleParams);
      aiLatencyMs = aiResult.latencyMs;
      aiProvider = aiResult.provider;

      if (aiResult.success) {
        const aiTyped = aiResult as AiDecisionResult;
        const aiProb = optionType === 'CALL' ? aiTyped.callProbability : aiTyped.putProbability;

        if (aiProb < env.aiMinProbabilityPct) {
          await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'REJECTED', rejectionCategory: 'AI_SKIP', rejectionReason: `AI prob ${aiProb}% < ${env.aiMinProbabilityPct}%. ${aiTyped.primaryReason}`, confidence: signal.confidence, signalSource: signal.source, rationale: aiTyped.primaryReason, signalMetadata: { ...signal.metadata, strategyName, aiResult: aiTyped }, latencyMs: Date.now() - cycleStart, aiProvider, aiLatencyMs });
          await tradeEventService.emit({ type: 'SIGNAL_REJECTED', underlying: sym, reason: `AI skip: ${aiTyped.primaryReason}`, strategy: strategyName });
          return { signal, intentId: null, logId: null, decisionSource: 'ai-skip', strategyName };
        }

        if (aiTyped.confidence === 'LOW' || aiTyped.entryQuality === 'WEAK') {
          await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'REJECTED', rejectionCategory: 'AI_SKIP', rejectionReason: `AI LOW confidence / WEAK quality. Risk: ${aiTyped.keyRisk}`, confidence: signal.confidence, signalSource: signal.source, rationale: aiTyped.primaryReason, signalMetadata: { ...signal.metadata, strategyName, aiResult: aiTyped }, latencyMs: Date.now() - cycleStart, aiProvider, aiLatencyMs });
          return { signal, intentId: null, logId: null, decisionSource: 'ai-quality-reject', strategyName };
        }

        finalConfidence = Math.min(0.99, signal.confidence * 0.4 + (aiProb / 100) * 0.6);
        decisionSource = 'hybrid-rules+ai';
      } else {
        decisionSource = 'rules-fallback';
      }
    }

    await tradeEventService.emit({ type: 'SIGNAL_GENERATED', underlying: sym, symbol: signal.symbol, side: signal.side, price: signal.entryPrice, strategy: strategyName, metadata: { confidence: finalConfidence, rationale: signal.rationale, ruleSignals: ruleResult.signals, decisionSource } });

    if (!createIntent) {
      return { signal, intentId: null, logId: null, decisionSource, strategyName };
    }

    // 9. Create TradeIntent
    const tradeOfDay = risk.tradeCountToday + 1;
    try {
      const intent = await tradeIntentService.createIntent({
        source: 'STRATEGY', side: signal.side, symbol: signal.symbol,
        instrumentKey: signal.instrumentKey, quantity: signal.quantity,
        orderType: 'MARKET', product: 'I', validity: 'DAY',
        tag: 'auto-' + Date.now(), confidence: finalConfidence, rationale: signal.rationale,
        requiresApproval: env.requireTradeApproval, expiresInMinutes: 10,
        metadata: {
          ...signal.metadata, entryPrice: signal.entryPrice,
          stopLossPrice: signal.suggestedStopLoss, targetPrice: signal.suggestedTarget,
          trailActivationPct: env.strategyTrailActivationPct, trailOffsetPct: env.strategyTrailOffsetPct,
          strategyDate: sameDayIso(), decisionSource, strategyName, ruleSignals: ruleResult.signals,
        },
      });

      const intentId = Number(intent.id);
      const logEntry = await StrategyDecisionLog.create({
        underlying: sym, indexPrice: latestIndexPrice, decision: 'ACCEPTED',
        rejectionCategory: null, rejectionReason: null, errorMessage: null, intentId,
        optionType, strikePrice: (meta.strike as number) ?? null,
        entryPremium: signal.entryPrice, stopLossPrice: signal.suggestedStopLoss,
        targetPrice: signal.suggestedTarget, confidence: finalConfidence,
        signalSource: signal.source, rationale: signal.rationale,
        signalMetadata: { ...signal.metadata, ruleSignals: ruleResult.signals, decisionSource, strategyName },
        latencyMs: Date.now() - cycleStart, aiProvider, aiLatencyMs, tradeOfDay,
      });

      // Hand off to execution engine
      await executionService.processNewIntent(intentId, sym);

      return { signal, intentId, logId: Number(logEntry.id), decisionSource, strategyName };

    } catch (intentError) {
      const msg = intentError instanceof Error ? intentError.message : String(intentError);
      await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'FAILED', errorMessage: 'Intent creation: ' + msg, confidence: finalConfidence, signalSource: signal.source, rationale: signal.rationale, signalMetadata: signal.metadata, latencyMs: Date.now() - cycleStart, aiProvider, aiLatencyMs, tradeOfDay });
      return { signal: null, intentId: null, logId: null, decisionSource: 'intent-error', strategyName };
    }
  }

  async listPositions(limit = 100): Promise<StrategyPosition[]> {
    return StrategyPosition.findAll({ order: [['createdAt', 'DESC']], limit: Math.min(limit, 500) });
  }

  async closePosition(positionId: number, reason: string): Promise<StrategyPosition> {
    const position = await StrategyPosition.findByPk(positionId);
    if (!position) throw new ApiError(404, `Position ${positionId} not found.`);
    if (position.status !== 'OPEN') return position;
    const underlying = position.symbol.split('-')[0] ?? position.symbol;
    await executionService.closePositionWithEvent(positionId, reason, underlying);
    return (await StrategyPosition.findByPk(positionId)) ?? position;
  }

  async getPositionPnlTicks(positionId: number, limit = 200): Promise<PositionPnlTick[]> {
    return PositionPnlTick.findAll({ where: { positionId }, order: [['createdAt', 'ASC']], limit: Math.min(limit, 1000) });
  }

  async getDecisionLogs(params?: { limit?: number; decision?: string; underlying?: string; since?: Date }): Promise<StrategyDecisionLog[]> {
    const limit = Math.min(params?.limit ?? 100, 500);
    const where: Record<string, unknown> = {};
    if (params?.decision) where['decision'] = params.decision;
    if (params?.underlying) where['underlying'] = params.underlying;
    if (params?.since) where['createdAt'] = { [Op.gte]: params.since };
    return StrategyDecisionLog.findAll({ where, order: [['createdAt', 'DESC']], limit });
  }

  async getDecisionLogSummaryToday() {
    const logs = await StrategyDecisionLog.findAll({ where: { createdAt: { [Op.gte]: startOfDay() } } });
    let accepted = 0, rejected = 0, failed = 0, totalLatency = 0, latencyCount = 0;
    const breakdown: Record<string, number> = {};
    for (const log of logs) {
      if (log.decision === 'ACCEPTED') accepted++;
      else if (log.decision === 'REJECTED') { rejected++; const cat = log.rejectionCategory ?? 'OTHER'; breakdown[cat] = (breakdown[cat] ?? 0) + 1; }
      else failed++;
      if (log.latencyMs !== null) { totalLatency += log.latencyMs; latencyCount++; }
    }
    return { total: logs.length, accepted, rejected, failed, rejectionBreakdown: breakdown, avgLatencyMs: latencyCount > 0 ? Math.round(totalLatency / latencyCount) : null };
  }

  private async runCycle(): Promise<void> {
    await tradeIntentService.expireStaleIntents();
    if (!this.enabled) return;
    try {
      const status = await tokenService.getConnectionStatus();
      if (!status.connected) return;
      await this.evaluateAndQueueSignal(true);
    } catch (error) {
      process.stderr.write('[Strategy] Cycle error: ' + String(error) + '\n');
    }
  }

  private async getRiskSnapshot(): Promise<StrategyRiskSnapshot> {
    const start = startOfDay();
    const [tradeCountToday, closedPositions] = await Promise.all([
      TradeIntent.count({ where: { source: 'STRATEGY', status: 'EXECUTED', [Op.and]: [sqlWhere(col('created_at'), Op.gte, start)] } }),
      StrategyPosition.findAll({ where: { status: 'CLOSED', [Op.and]: [sqlWhere(col('updated_at'), Op.gte, start)] } }),
    ]);
    const dailyPnl = closedPositions.reduce((sum, pos) => sum + (pos.realizedPnl !== null ? Number(pos.realizedPnl) : 0), 0);
    const dailyLossLimit = -(env.strategyCapital * env.strategyDailyMaxLossPct) / 100;
    if (tradeCountToday >= env.strategyMaxAutoTradesPerDay) return { tradeCountToday, dailyPnl, dailyLossLimit, blocked: true, blockReason: `Max trades reached (${env.strategyMaxAutoTradesPerDay}/day).` };
    if (dailyPnl <= dailyLossLimit) return { tradeCountToday, dailyPnl, dailyLossLimit, blocked: true, blockReason: `Daily loss limit reached.` };
    return { tradeCountToday, dailyPnl, dailyLossLimit, blocked: false, blockReason: null };
  }
}

export const strategyService = new StrategyService();
