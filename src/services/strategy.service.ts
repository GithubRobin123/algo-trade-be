/**
 * strategy.service.ts
 *
 * Orchestrates the signal generation pipeline.
 * Execution (order placement, position monitoring) is handled by execution.service.ts
 *
 * Flow per cycle:
 *   1. Risk gate
 *   2. Pending-intent guard  (also guards against concurrent open positions)
 *   3. Signal cooldown guard (5 min between consecutive signals — prevents burst entries)
 *   4. Time / expiry filters
 *   5. Build market context from candles (primary) or session ticks (fallback)
 *   6. Compute PCR from ±10 ATM strikes (wider, more representative)
 *   7. Wire real ATM call/put OI and IV from chain
 *   8. Use live India VIX (fetched alongside Nifty poll)
 *   9. Run strategy registry
 *  10. Rule-based probability pre-check
 *  11. AI confidence check (optional)
 *  12. Create TradeIntent → hand off to execution.service
 *  13. Log every outcome to strategy_decision_logs
 */

import { Op, col, where as sqlWhere } from 'sequelize';
import { env } from '../config/env';
import { ApiError } from '../middleware/error.middleware';
import { StrategyDecisionLog, RejectionCategory } from '../models/strategy-decision-log.model';
import { StrategyPosition } from '../models/strategy-position.model';
import { PositionPnlTick } from '../models/position-pnl-tick.model';
import { TradeIntent } from '../models/trade-intent.model';
import { StrategyRiskSnapshot, StrategySignal } from '../types/trading.types';
import {
  AiDecisionParams,
  AiDecisionResult,
  computeRuleBasedDecision,
  getAiTradeDecision,
} from './ai-decision.service';
import { executionService } from './execution.service';
import { isMarketOpen, marketDataService, getLatestVix } from './market-data.service';
import { StrategyContext, strategyRegistry, atr, supertrend, adx, bollingerBands, stochastic } from './strategy-registry.service';
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
  const ist = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = ist.split(':').map(Number);
  const minutesToClose = Math.max(0, (15 * 60 + 15) - (h * 60 + m));
  const minutesSinceOpen = (h - 9) * 60 + (m - 15);
  return { timeIST: ist, minutesToClose, minutesSinceOpen };
};

// ── Signal cooldown: prevents burst entries from the same repeated signal ──
// Maps underlying symbol → timestamp of last accepted signal
const lastSignalTime = new Map<string, number>();
const SIGNAL_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between consecutive signals

function isInCooldown(sym: string): boolean {
  const last = lastSignalTime.get(sym);
  if (!last) return false;
  return Date.now() - last < SIGNAL_COOLDOWN_MS;
}

function recordSignal(sym: string): void {
  lastSignalTime.set(sym, Date.now());
}

// ── PCR from ±10 strikes around ATM ──────────────────────────────────────
function computePcr(chainRows: { strikePrice: number; callOi: number | null; putOi: number | null }[], atmStrike: number): number {
  const sorted = [...chainRows].sort((a, b) => Math.abs(a.strikePrice - atmStrike) - Math.abs(b.strikePrice - atmStrike));
  const nearAtm = sorted.slice(0, 21); // ±10 strikes
  const totalPutOi = nearAtm.reduce((s, r) => s + (r.putOi ?? 0), 0);
  const totalCallOi = nearAtm.reduce((s, r) => s + (r.callOi ?? 0), 0);
  return totalCallOi > 0 ? totalPutOi / totalCallOi : 1;
}

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
      risk, openPositions, pendingIntents,
    };
  }

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

    // 2. Pending-intent / open-position guard
    const [existingPending, existingOpen] = await Promise.all([
      TradeIntent.count({ where: { source: 'STRATEGY', status: 'PENDING_APPROVAL' } }),
      StrategyPosition.count({ where: { status: 'OPEN' } }),
    ]);
    if (existingPending > 0) {
      await logDecision({ underlying: sym, decision: 'REJECTED', rejectionCategory: 'PENDING_INTENT', rejectionReason: 'Pending approval intent exists', latencyMs: Date.now() - cycleStart });
      return { signal: null, intentId: null, logId: null, decisionSource: 'pending-guard', strategyName: null };
    }
    if (existingOpen > 0) {
      await logDecision({ underlying: sym, decision: 'REJECTED', rejectionCategory: 'PENDING_INTENT', rejectionReason: `${existingOpen} open position(s) already active`, latencyMs: Date.now() - cycleStart });
      return { signal: null, intentId: null, logId: null, decisionSource: 'open-position-guard', strategyName: null };
    }

    // 3. Signal cooldown guard (prevents burst entries every 20s from same setup)
    if (isInCooldown(sym)) {
      await logDecision({ underlying: sym, decision: 'REJECTED', rejectionCategory: 'OTHER', rejectionReason: `Signal cooldown active (${SIGNAL_COOLDOWN_MS / 1000}s between signals)`, latencyMs: Date.now() - cycleStart });
      return { signal: null, intentId: null, logId: null, decisionSource: 'cooldown', strategyName: null };
    }

    // 4. Time filter
    const { timeIST, minutesToClose, minutesSinceOpen } = getIstTime();
    if (minutesSinceOpen < 15) {
      await logDecision({ underlying: sym, decision: 'REJECTED', rejectionCategory: 'MARKET_HOURS', rejectionReason: `Too early (${timeIST} IST)`, latencyMs: Date.now() - cycleStart });
      return { signal: null, intentId: null, logId: null, decisionSource: 'time-filter', strategyName: null };
    }
    if (minutesToClose < 30) {
      await logDecision({ underlying: sym, decision: 'REJECTED', rejectionCategory: 'MARKET_HOURS', rejectionReason: `Too close to close (${minutesToClose} min)`, latencyMs: Date.now() - cycleStart });
      return { signal: null, intentId: null, logId: null, decisionSource: 'time-filter', strategyName: null };
    }

    // 5. Build market context
    let latestIndexPrice: number | null = null;
    let strategyContext: StrategyContext | null = null;

    try {
      const tick = await marketDataService.getLatestTick(underlying.instrumentKey);
      latestIndexPrice = tick?.ltp ?? null;

      if (!latestIndexPrice) {
        const fetched = await marketDataService.fetchAndStoreTick(underlying.instrumentKey, underlying.symbol).catch(() => null);
        latestIndexPrice = fetched?.ltp ?? null;
      }

      // Primary: 5-min candles (session-only)
      const candles = await marketDataService.getCandleHistory(60, underlying.instrumentKey);
      // Fallback: session-only ticks
      const history = await marketDataService.getSessionTickHistory(100, underlying.instrumentKey);

      if (candles.length < 5 && history.length < 20) {
        await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'REJECTED', rejectionCategory: 'NO_SIGNAL', rejectionReason: `Insufficient data: ${candles.length} candles, ${history.length} ticks (need 5 candles or 20 ticks)`, latencyMs: Date.now() - cycleStart });
        return { signal: null, intentId: null, logId: null, decisionSource: 'no-history', strategyName: null };
      }

      const prices = history.map((t) => t.ltp);
      const lastPrice = latestIndexPrice ?? (candles.length > 0 ? Number(candles[candles.length - 1].close) : prices[prices.length - 1]);

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

      // Sort chain rows by distance to ATM
      const sortedByAtm = [...chain.rows].sort((a, b) => Math.abs(a.strikePrice - lastPrice) - Math.abs(b.strikePrice - lastPrice));
      const atmRow = sortedByAtm[0];
      if (!atmRow) {
        await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'REJECTED', rejectionCategory: 'NO_LIQUID_OPTION', rejectionReason: 'No ATM row found', latencyMs: Date.now() - cycleStart });
        return { signal: null, intentId: null, logId: null, decisionSource: 'no-atm', strategyName: null };
      }

      // PCR from ±10 strikes (fixed from ±2 strikes)
      const pcr = computePcr(chain.rows, atmRow.strikePrice);

      // Real ATM OI and IV from chain
      const atmCallOi = atmRow.callOi ?? 0;
      const atmPutOi = atmRow.putOi ?? 0;
      const atmIv = atmRow.iv;

      // dayHigh, dayLow, prevDayClose: from latest candle (filled from Upstox OHLC)
      const latestCandle = candles.length > 0 ? candles[candles.length - 1] : null;
      const dayHigh = latestCandle?.dayHigh !== null && latestCandle?.dayHigh !== undefined
        ? Number(latestCandle.dayHigh)
        : prices.length > 0 ? Math.max(...prices) : lastPrice;
      const dayLow = latestCandle?.dayLow !== null && latestCandle?.dayLow !== undefined
        ? Number(latestCandle.dayLow)
        : prices.length > 0 ? Math.min(...prices) : lastPrice;
      const prevDayClose = latestCandle?.prevClose !== null && latestCandle?.prevClose !== undefined
        ? Number(latestCandle.prevClose)
        : lastPrice; // fallback to current if no candle data yet

      const vix = getLatestVix();

      strategyContext = {
        underlying: sym,
        prices,
        candles,
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
        atmCallOi,
        atmPutOi,
        atmIv: atmIv ?? null,
        dayHigh,
        dayLow,
        prevDayClose,
        vix,
      };

    } catch (buildError) {
      const msg = buildError instanceof Error ? buildError.message : String(buildError);
      await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'FAILED', errorMessage: 'Context build: ' + msg, latencyMs: Date.now() - cycleStart });
      return { signal: null, intentId: null, logId: null, decisionSource: 'build-error', strategyName: null };
    }

    // 6. Run strategy registry
    const registryResult = strategyRegistry.runAll(strategyContext);
    if (!registryResult) {
      await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'REJECTED', rejectionCategory: 'NO_SIGNAL', rejectionReason: 'No strategy produced a signal', latencyMs: Date.now() - cycleStart });
      return { signal: null, intentId: null, logId: null, decisionSource: 'no-signal', strategyName: null };
    }

    const { signal, strategyName } = registryResult;

    // 7. Rule-based probability check
    const meta = signal.metadata as Record<string, unknown>;
    const optionType: 'CALL' | 'PUT' = (meta.bullish as boolean) ? 'CALL' : 'PUT';

    const candlePrices = strategyContext.candles.length >= 5
      ? strategyContext.candles.map((c) => Number(c.close))
      : strategyContext.prices;

    const atr14 = (meta.atr as number) ?? atr(candlePrices, 14);
    const stDir = (meta.supertrendDirection as 'BULLISH' | 'BEARISH' | null | undefined) ?? supertrend(candlePrices, 10, 3, sym);
    const { adx: adx14 } = adx(candlePrices, 14);
    const bb = bollingerBands(candlePrices, 20, 2);
    const stoch = stochastic(candlePrices, 14, 3);

    const ruleParams: AiDecisionParams = {
      index: sym,
      currentPrice: latestIndexPrice ?? 0,
      atmStrike: (meta.strike as number) ?? 0,
      optionType,
      optionPremium: signal.entryPrice,
      rsi14: (meta.rsi14 as number) ?? 50,
      ema9: (meta.ema9 as number) ?? 0,
      ema21: (meta.ema21 as number) ?? 0,
      macd: (meta.macd as number) ?? 0,
      macdSignal: (meta.macdSignal as number) ?? 0,
      macdHistogram: (meta.macdHistogram as number) ?? 0,
      vwap: (meta.vwap as number) ?? (latestIndexPrice ?? 0),
      volumeRatio: (meta.volumeRatio as number) ?? 1,
      dayHigh: strategyContext.dayHigh,
      dayLow: strategyContext.dayLow,
      prevDayClose: strategyContext.prevDayClose,
      // Real OI values from chain
      atmCallOI: strategyContext.atmCallOi,
      atmPutOI: strategyContext.atmPutOi,
      pcrRatio: strategyContext.pcr,
      ivPercentile: strategyContext.atmIv ?? 40,
      indiaVix: strategyContext.vix,
      timeIST,
      minutesToClose,
      atr14,
      adx14,
      supertrendDirection: stDir,
      bbPercentB: bb.percentB,
      bbBandwidth: bb.bandwidth,
      stochK: stoch.k,
      stochD: stoch.d,
    };

    const ruleResult = computeRuleBasedDecision(ruleParams);

    if (ruleResult.action === 'SKIP' && !env.aiEnabled) {
      await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'REJECTED', rejectionCategory: 'LOW_CONFIDENCE', rejectionReason: `Rules SKIP. Bull=${ruleResult.rawBullScore} Bear=${ruleResult.rawBearScore}`, confidence: signal.confidence, signalSource: signal.source, rationale: signal.rationale, signalMetadata: { ...signal.metadata, ruleSignals: ruleResult.signals, strategyName }, latencyMs: Date.now() - cycleStart });
      await tradeEventService.emit({ type: 'SIGNAL_REJECTED', underlying: sym, reason: 'Rule-based skip', strategy: strategyName, metadata: { ruleSignals: ruleResult.signals } });
      return { signal, intentId: null, logId: null, decisionSource: 'rules-skip', strategyName };
    }

    // 8. Confidence gate
    if (signal.confidence < env.strategyConfidenceThreshold) {
      await logDecision({ underlying: sym, indexPrice: latestIndexPrice, decision: 'REJECTED', rejectionCategory: 'LOW_CONFIDENCE', rejectionReason: `Confidence ${(signal.confidence * 100).toFixed(1)}% < ${(env.strategyConfidenceThreshold * 100).toFixed(1)}%`, confidence: signal.confidence, signalSource: signal.source, rationale: signal.rationale, signalMetadata: signal.metadata, latencyMs: Date.now() - cycleStart });
      return { signal, intentId: null, logId: null, decisionSource: 'confidence-gate', strategyName };
    }

    // 9. AI decision
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

    // 10. Create TradeIntent + record cooldown
    const tradeOfDay = risk.tradeCountToday + 1;
    try {
      const intent = await tradeIntentService.createIntent({
        source: 'STRATEGY', side: signal.side, symbol: signal.symbol,
        instrumentKey: signal.instrumentKey, quantity: signal.quantity,
        orderType: 'MARKET', product: 'I', validity: 'DAY',
        tag: 'auto-' + Date.now(), confidence: finalConfidence, rationale: signal.rationale,
        requiresApproval: env.requireTradeApproval, expiresInMinutes: 2,
        metadata: {
          ...signal.metadata, entryPrice: signal.entryPrice,
          stopLossPrice: signal.suggestedStopLoss, targetPrice: signal.suggestedTarget,
          trailActivationPct: env.strategyTrailActivationPct, trailOffsetPct: env.strategyTrailOffsetPct,
          strategyDate: sameDayIso(), decisionSource, strategyName, ruleSignals: ruleResult.signals,
        },
      });

      // Record signal time AFTER successful intent creation
      recordSignal(sym);

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
    return StrategyDecisionLog.findAll({ where: where as never, order: [['createdAt', 'DESC']], limit });
  }

  async getDecisionLogSummaryToday() {
    const logs = await StrategyDecisionLog.findAll({ where: { createdAt: { [Op.gte]: startOfDay() } } as never });
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
    if (!isMarketOpen()) return;
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
    const [tradeCountToday, closedPositions, openPositions] = await Promise.all([
      TradeIntent.count({ where: { source: 'STRATEGY', status: 'EXECUTED', [Op.and]: [sqlWhere(col('created_at'), Op.gte, start)] } }),
      StrategyPosition.findAll({ where: { status: 'CLOSED', [Op.and]: [sqlWhere(col('updated_at'), Op.gte, start)] } }),
      StrategyPosition.findAll({ where: { status: 'OPEN' } }),
    ]);

    // Realized P&L from positions closed today
    const realizedPnl = closedPositions.reduce((sum, pos) => sum + (pos.realizedPnl !== null ? Number(pos.realizedPnl) : 0), 0);

    // Unrealized P&L from currently open positions (include so daily cap catches live losses)
    const unrealizedPnl = openPositions.reduce((sum, pos) => sum + (pos.unrealizedPnl !== null ? Number(pos.unrealizedPnl) : 0), 0);

    const dailyPnl = realizedPnl + unrealizedPnl;
    const dailyLossLimit = -(env.strategyCapital * env.strategyDailyMaxLossPct) / 100;

    if (tradeCountToday >= env.strategyMaxAutoTradesPerDay) return { tradeCountToday, dailyPnl, dailyLossLimit, blocked: true, blockReason: `Max trades reached (${env.strategyMaxAutoTradesPerDay}/day).` };
    if (dailyPnl <= dailyLossLimit) return { tradeCountToday, dailyPnl, dailyLossLimit, blocked: true, blockReason: `Daily loss limit reached (realized + unrealized = ₹${dailyPnl.toFixed(0)}).` };
    return { tradeCountToday, dailyPnl, dailyLossLimit, blocked: false, blockReason: null };
  }
}

export const strategyService = new StrategyService();
