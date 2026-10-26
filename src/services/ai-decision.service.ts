/**
 * ai-decision.service.ts
 *
 * Provider-agnostic AI trade decision engine.
 * Works with Claude, OpenAI GPT-4, Gemini, or 'none' (rule-based only).
 * Set AI_PROVIDER + AI_API_KEY in .env to switch providers.
 *
 * On any AI failure → cleanly returns { success: false } so the caller
 * can fall back to the rule-based scorer without crashing.
 */

import { env } from '../config/env';
import { StrategySignal } from '../types/trading.types';
import {
  StrategyContext,
  adx,
  atr,
  atrStopLossPct,
  bollingerBands,
  ema,
  macd,
  rsi,
  sessionVwap,
  stochastic,
  supertrend,
} from './strategy-registry.service';

// ── Types ─────────────────────────────────────────────────────────────────

export interface AiDecisionParams {
  // Index info
  index: string;           // 'NIFTY' | 'SENSEX'
  currentPrice: number;    // index LTP
  atmStrike: number;
  optionType: 'CALL' | 'PUT';
  optionPremium: number;

  // Technical indicators (5-min)
  rsi14: number;
  ema9: number;
  ema21: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  vwap: number;
  volumeRatio: number;

  // New: trend-strength and momentum indicators
  atr14?: number;                            // ATR(14) of underlying
  adx14?: number;                            // ADX(14) — trend strength 0-100
  supertrendDirection?: 'BULLISH' | 'BEARISH' | null;  // Supertrend signal
  bbPercentB?: number;                       // Bollinger %B: 0=at lower, 1=at upper
  bbBandwidth?: number;                      // BB bandwidth % (squeeze if < 0.8)
  stochK?: number;                           // Stochastic %K
  stochD?: number;                           // Stochastic %D

  // Market structure
  dayHigh: number;
  dayLow: number;
  prevDayClose: number;

  // Option chain
  atmCallOI: number;
  atmPutOI: number;
  pcrRatio: number;
  ivPercentile: number;
  indiaVix: number;

  // Time context
  timeIST: string;         // "10:35"
  minutesToClose: number;
}

export interface AiDecisionResult {
  success: true;
  callProbability: number;
  putProbability: number;
  skipProbability: number;
  recommendedAction: 'BUY_CALL' | 'BUY_PUT' | 'SKIP';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  primaryReason: string;
  keyRisk: string;
  entryQuality: 'STRONG' | 'MODERATE' | 'WEAK';
  latencyMs: number;
  provider: string;
}

export interface AiDecisionFailure {
  success: false;
  error: string;
  latencyMs: number;
  provider: string;
}

export type AiDecision = AiDecisionResult | AiDecisionFailure;

// ── System prompt (same for all providers) ───────────────────────────────

const SYSTEM_PROMPT = `You are a quantitative options analyst specialising in Indian index options (Nifty 50, Sensex).
You analyse intraday 5-minute setups and return a probability score for a directional trade.

The trader ONLY buys options (CALL or PUT) — never selling/writing.
Holding period: intraday only (minutes to a few hours).
Square-off before 3:15 PM IST.

INDIAN MARKET CONTEXT:
- Nifty options: 50-point strike intervals
- Sensex options: 100-point strike intervals
- VWAP is the most critical intraday level — price above VWAP = bullish bias
- Theta decay accelerates after 2 PM IST — penalise late entries strongly
- Weekly expiry: NEVER buy on expiry day (extreme theta)
- VIX > 22 = elevated volatility — lower probability, wider uncertainty
- PCR > 1.2 = market net-hedged, potential bullish squeeze
- PCR < 0.8 = under-hedged, vulnerable to sell-off

INDICATOR INTERPRETATION:
- ADX > 25 = strong trend, signals are more reliable; ADX < 20 = choppy, avoid trend strategies
- Supertrend BULLISH + price above VWAP = high-conviction long setup
- Supertrend BEARISH + price below VWAP = high-conviction short setup
- BB %B > 0.95 = overbought (consider PUT); BB %B < 0.05 = oversold (consider CALL)
- BB bandwidth < 0.8% = squeeze (imminent breakout); > 2% = already expanded
- Stochastic < 20 with %K crossing above %D = oversold reversal (bullish)
- Stochastic > 80 with %K crossing below %D = overbought reversal (bearish)
- ATR helps size stop loss — high ATR means more room needed, reduce position confidence

MULTI-FACTOR SCORING:
Reward setups where 4+ indicators agree. Penalise conflicting setups heavily.
A STRONG entry needs: trend alignment (EMA/Supertrend) + momentum (MACD/Stoch) + confirmation (VWAP/PCR).

RESPONSE FORMAT — return ONLY valid JSON with no preamble, no markdown fences:
{
  "callProbability": <integer 0-100>,
  "putProbability": <integer 0-100>,
  "skipProbability": <integer 0-100>,
  "recommendedAction": "BUY_CALL" | "BUY_PUT" | "SKIP",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "primaryReason": "<one sentence>",
  "keyRisk": "<one sentence>",
  "entryQuality": "STRONG" | "MODERATE" | "WEAK"
}`;

function buildUserPrompt(p: AiDecisionParams): string {
  const dayChangePct = (((p.currentPrice - p.prevDayClose) / p.prevDayClose) * 100).toFixed(2);
  const priceVsVwap = p.currentPrice > p.vwap
    ? `ABOVE VWAP by ${(p.currentPrice - p.vwap).toFixed(0)} pts — bullish intraday bias`
    : `BELOW VWAP by ${(p.vwap - p.currentPrice).toFixed(0)} pts — bearish intraday bias`;
  const emaStructure = p.ema9 > p.ema21
    ? `9 EMA (${p.ema9.toFixed(0)}) ABOVE 21 EMA (${p.ema21.toFixed(0)}) — uptrend`
    : `9 EMA (${p.ema9.toFixed(0)}) BELOW 21 EMA (${p.ema21.toFixed(0)}) — downtrend`;
  const pcrNote = p.pcrRatio > 1.2 ? 'HIGH PCR — market net-hedged, potential bullish squeeze'
    : p.pcrRatio < 0.8 ? 'LOW PCR — market under-hedged, watch for sell-off'
    : 'Neutral PCR';
  const rsiNote = p.rsi14 < 35 ? ' ← OVERSOLD' : p.rsi14 > 65 ? ' ← OVERBOUGHT' : '';
  const volNote = p.volumeRatio > 1.5 ? ` ← HIGH VOLUME SPIKE (${p.volumeRatio.toFixed(1)}x)` : '';
  const vixNote = p.indiaVix > 22 ? ` ← ELEVATED VIX (${p.indiaVix})` : '';
  const dayPctRange = p.dayHigh > p.dayLow
    ? (((p.currentPrice - p.dayLow) / (p.dayHigh - p.dayLow)) * 100).toFixed(0)
    : '50';

  // New indicators section
  const adxNote = p.adx14 != null
    ? `ADX(14)   : ${p.adx14.toFixed(0)}${p.adx14 > 25 ? ' ← TRENDING (signals reliable)' : p.adx14 < 20 ? ' ← RANGING/CHOPPY' : ''}`
    : '';
  const stNote = p.supertrendDirection != null
    ? `Supertrend: ${p.supertrendDirection}${p.supertrendDirection === 'BULLISH' ? ' ← UPTREND confirmed' : ' ← DOWNTREND confirmed'}`
    : '';
  const bbNote = p.bbPercentB != null
    ? `BB %B      : ${(p.bbPercentB * 100).toFixed(0)}%${p.bbPercentB < 0.05 ? ' ← AT LOWER BAND (oversold)' : p.bbPercentB > 0.95 ? ' ← AT UPPER BAND (overbought)' : ''}${p.bbBandwidth != null && p.bbBandwidth < 0.8 ? '  BB SQUEEZE active' : ''}`
    : '';
  const stochNote = (p.stochK != null && p.stochD != null)
    ? `Stoch %K/%D: ${p.stochK.toFixed(0)}/${p.stochD.toFixed(0)}${p.stochK < 20 ? ' ← OVERSOLD' : p.stochK > 80 ? ' ← OVERBOUGHT' : ''}`
    : '';
  const atrNote = p.atr14 != null
    ? `ATR(14)   : ${p.atr14.toFixed(1)} pts (${((p.atr14 / p.currentPrice) * 100).toFixed(2)}% of index)`
    : '';

  const newIndicators = [adxNote, stNote, bbNote, stochNote, atrNote]
    .filter(Boolean).map(l => `  ${l}`).join('\n');

  const slPct = atrStopLossPct(p.optionPremium, p.atr14 ?? 0) * 100;
  const slLevel = (p.optionPremium * (1 - slPct / 100)).toFixed(1);

  return `TRADE SETUP ANALYSIS — ${p.index}

PROPOSED TRADE:
  Action    : BUY ${p.optionType} option
  ATM Strike: ${p.atmStrike}
  Premium   : ₹${p.optionPremium}
  ATR-based SL: ₹${slLevel} (~${slPct.toFixed(0)}% stop on premium)
  Time      : ${p.timeIST} IST (${p.minutesToClose} min to 3:15 close)
  India VIX : ${p.indiaVix}${vixNote}

PRICE ACTION:
  ${p.index} LTP  : ${p.currentPrice}  (Day change: ${dayChangePct}%)
  Day Range : ${p.dayLow} – ${p.dayHigh}  (current at ${dayPctRange}% of range)
  ${priceVsVwap}

TECHNICAL INDICATORS (5-min chart):
  RSI(14)   : ${p.rsi14.toFixed(1)}${rsiNote}
  MACD      : ${p.macd.toFixed(2)}, Signal: ${p.macdSignal.toFixed(2)}, Hist: ${p.macdHistogram.toFixed(2)}
  ${emaStructure}
  Volume    : ${p.volumeRatio.toFixed(1)}x average${volNote}
${newIndicators ? '\nADVANCED INDICATORS:\n' + newIndicators : ''}

OPTION CHAIN:
  ATM Call OI : ${(p.atmCallOI / 100000).toFixed(1)} lakh contracts
  ATM Put OI  : ${(p.atmPutOI / 100000).toFixed(1)} lakh contracts
  PCR (near ATM): ${p.pcrRatio.toFixed(2)} — ${pcrNote}
  IV Percentile : ${p.ivPercentile}%${p.ivPercentile > 80 ? ' ← EXPENSIVE premium' : p.ivPercentile < 20 ? ' ← CHEAP premium' : ''}

Given all the above (especially ADX trend strength, Supertrend, VWAP bias, and RSI), what is the probability this BUY ${p.optionType} entry will be profitable intraday?`;
}

// ── Provider adapters ─────────────────────────────────────────────────────

interface ProviderConfig {
  url: string | ((key: string) => string);
  buildHeaders: (key: string) => Record<string, string>;
  buildBody: (system: string, user: string) => string;
  parseText: (data: unknown) => string;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    buildHeaders: (key) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    }),
    buildBody: (system, user) => JSON.stringify({
      // Llama 3.3 70B is excellent for trading logic and free on Groq
      model: 'llama-3.3-70b-versatile', 
      max_tokens: 350,
      temperature: 0.1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      // This ensures the model tries to return valid JSON
      response_format: { type: "json_object" } 
    }),
    parseText: (data) => {
      const d = data as { choices: { message: { content: string } }[] };
      return d.choices[0]?.message?.content ?? '';
    },
  },
  claude: {
    url: 'https://api.anthropic.com/v1/messages',
    buildHeaders: (key) => ({
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    }),
    buildBody: (system, user) => JSON.stringify({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: 350,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    parseText: (data) => {
      const d = data as { content: { type: string; text: string }[] };
      return d.content.find((b) => b.type === 'text')?.text ?? '';
    },
  },
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    buildHeaders: (key) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    }),
    buildBody: (system, user) => JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 350,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    parseText: (data) => {
      const d = data as { choices: { message: { content: string } }[] };
      return d.choices[0]?.message?.content ?? '';
    },
  },
  gemini: {
    url: (key) =>
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    buildHeaders: () => ({ 'Content-Type': 'application/json' }),
    buildBody: (system, user) => JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: `STRATEGY_RULES:\n${system}` },
            { text: `MARKET_DATA:\n${user}` }
          ]
        }
      ],
      generationConfig: {
        maxOutputTokens: 350,
        temperature: 0.1
      },
    }),
    parseText: (data) => {
      try {
        const d = data as any;
        return d.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      } catch (e) {
        process.stderr.write("[AI] Gemini parse error: " + String(e) + "\n");
        return '';
      }
    },
  },
};


// ── Main AI decision function ─────────────────────────────────────────────

export async function getAiTradeDecision(params: AiDecisionParams): Promise<AiDecision> {
  const start = Date.now();
  const providerName = env.aiProvider;

  if (!env.aiEnabled || providerName === 'none' || !providerName) {
    return {
      success: false,
      error: 'AI_DISABLED',
      latencyMs: 0,
      provider: 'none',
    };
  }

  const config = PROVIDERS[providerName];
  if (!config) {
    return {
      success: false,
      error: `Unknown AI provider: ${providerName}. Use claude|openai|gemini|none`,
      latencyMs: Date.now() - start,
      provider: providerName,
    };
  }

  const apiKey = env.aiApiKey;
  if (!apiKey) {
    return {
      success: false,
      error: 'AI_API_KEY is not set in environment',
      latencyMs: Date.now() - start,
      provider: providerName,
    };
  }

  const userPrompt = buildUserPrompt(params);
  const url = typeof config.url === 'function' ? config.url(apiKey) : config.url;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.aiTimeoutMs);

    const response = await fetch(url, {
      method: 'POST',
      headers: config.buildHeaders(apiKey),
      body: config.buildBody(SYSTEM_PROMPT, userPrompt),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        success: false,
        error: `AI API ${response.status}: ${errText.slice(0, 200)}`,
        latencyMs: Date.now() - start,
        provider: providerName,
      };
    }

    const data: unknown = await response.json();
    const rawText = config.parseText(data);
    const clean = rawText.replace(/```json|```/g, '').trim();

    // Parse the JSON response from the AI
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(clean) as Record<string, unknown>;
    } catch {
      return {
        success: false,
        error: `AI returned non-JSON response: ${clean.slice(0, 100)}`,
        latencyMs: Date.now() - start,
        provider: providerName,
      };
    }

    // Validate required numeric fields
    if (typeof parsed.callProbability !== 'number' || typeof parsed.putProbability !== 'number') {
      return {
        success: false,
        error: 'AI response missing callProbability or putProbability fields',
        latencyMs: Date.now() - start,
        provider: providerName,
      };
    }

    return {
      success: true,
      callProbability: Number(parsed.callProbability),
      putProbability: Number(parsed.putProbability),
      skipProbability: Number(parsed.skipProbability ?? 100 - Number(parsed.callProbability) - Number(parsed.putProbability)),
      recommendedAction: (parsed.recommendedAction as AiDecisionResult['recommendedAction']) ?? 'SKIP',
      confidence: (parsed.confidence as AiDecisionResult['confidence']) ?? 'LOW',
      primaryReason: String(parsed.primaryReason ?? ''),
      keyRisk: String(parsed.keyRisk ?? ''),
      entryQuality: (parsed.entryQuality as AiDecisionResult['entryQuality']) ?? 'WEAK',
      latencyMs: Date.now() - start,
      provider: providerName,
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('abort') || msg.includes('timeout');
    return {
      success: false,
      error: isTimeout ? `AI call timed out after ${env.aiTimeoutMs}ms` : msg,
      latencyMs: Date.now() - start,
      provider: providerName,
    };
  }
}

// ── Rule-based probability scorer (fallback / standalone) ─────────────────
// Used when AI is disabled, timed out, or as the first-pass filter to
// avoid spending API calls on clearly weak signals.

export interface RuleBasedResult {
  buyProbability: number;   // probability that this is a good BUY entry
  sellSignal: boolean;      // true = indicators lean bearish (for PUT entry)
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  action: 'BUY_CALL' | 'BUY_PUT' | 'SKIP';
  signals: string[];
  rawBullScore: number;
  rawBearScore: number;
}

/**
 * Rule-scorer inputs for a strategy signal: the plugin's own metadata, with any indicator it did
 * not report computed from the same 5-min candles (a missing ema21 used to default to 0, which
 * always scored "EMA9 > EMA21" as bullish). Shared by the live pipeline and the offline backtest.
 */
export function buildRuleParams(
  ctx: StrategyContext,
  signal: StrategySignal,
  indexPrice: number | null,
): AiDecisionParams {
  const meta = signal.metadata as Record<string, unknown>;
  const closes = ctx.candles.map((c) => c.close);
  const macdVals = meta.macd === undefined ? macd(closes) : null;
  const bb = bollingerBands(closes, 20, 2);
  const stoch = stochastic(closes, 14, 3);

  return {
    index: ctx.underlying,
    currentPrice: indexPrice ?? 0,
    atmStrike: (meta.strike as number) ?? 0,
    optionType: (meta.bullish as boolean) ? 'CALL' : 'PUT',
    optionPremium: signal.entryPrice,
    rsi14: (meta.rsi14 as number) ?? rsi(closes, 14),
    ema9: (meta.ema9 as number) ?? ema(closes, 9),
    ema21: (meta.ema21 as number) ?? ema(closes, 21),
    macd: (meta.macd as number) ?? macdVals?.macdLine ?? 0,
    macdSignal: (meta.macdSignal as number) ?? macdVals?.signalLine ?? 0,
    macdHistogram: (meta.macdHistogram as number) ?? macdVals?.histogram ?? 0,
    // Falling back to the index price scored every such signal as "below VWAP" (+25 bear)
    vwap: (meta.vwap as number) ?? sessionVwap(ctx),
    volumeRatio: (meta.volumeRatio as number) ?? 1,
    dayHigh: ctx.dayHigh,
    dayLow: ctx.dayLow,
    prevDayClose: ctx.prevDayClose,
    atmCallOI: ctx.atmCallOi,
    atmPutOI: ctx.atmPutOi,
    pcrRatio: ctx.pcr,
    ivPercentile: ctx.atmIv ?? 40,
    indiaVix: ctx.vix,
    timeIST: ctx.timeIST,
    minutesToClose: ctx.minutesToClose,
    atr14: (meta.atr as number) ?? atr(closes, 14),
    adx14: adx(closes, 14).adx,
    supertrendDirection: (meta.supertrendDirection as 'BULLISH' | 'BEARISH' | null | undefined) ?? supertrend(ctx.candles, 10, 3),
    bbPercentB: bb.percentB,
    bbBandwidth: bb.bandwidth,
    stochK: stoch.k,
    stochD: stoch.d,
  };
}

export interface RuleVerdict<T> {
  candidate: T;
  ruleParams: AiDecisionParams;
  ruleResult: RuleBasedResult;
  /** Why the rule scorer blocks this signal (SKIP or opposite direction), or null if it agrees. */
  blockReason: string | null;
}

/**
 * Scores every candidate signal (highest confidence first) and picks the one to act on: when the
 * rule scorer is the gate, the first candidate it agrees with; otherwise the top candidate.
 * Previously only the top candidate was scored, so a counter-trend signal with slightly higher
 * confidence (e.g. a Bollinger upper-band PUT) that the gate rejected hid a valid trend signal.
 */
export function selectByRules<T extends { signal: StrategySignal }>(
  ctx: StrategyContext,
  candidates: T[],
  indexPrice: number | null,
  rulesGateDecides: boolean,
): { chosen: RuleVerdict<T>; verdicts: RuleVerdict<T>[] } {
  const verdicts = candidates.map((candidate) => {
    const ruleParams = buildRuleParams(ctx, candidate.signal, indexPrice);
    const ruleResult = computeRuleBasedDecision(ruleParams);
    const side = ruleParams.optionType === 'CALL' ? 'BUY_CALL' : 'BUY_PUT';
    const blockReason = ruleResult.action === 'SKIP'
      ? 'Rules SKIP'
      : ruleResult.action !== side
        ? `Rules favour ${ruleResult.action} but strategy wants ${side}`
        : null;
    return { candidate, ruleParams, ruleResult, blockReason };
  });
  const chosen = (rulesGateDecides ? verdicts.find((v) => !v.blockReason) : undefined) ?? verdicts[0];
  return { chosen, verdicts };
}

export function computeRuleBasedDecision(params: AiDecisionParams): RuleBasedResult {
  let bullScore = 0;
  let bearScore = 0;
  const signals: string[] = [];

  // A strong, aligned trend (ADX ≥ 25 with Supertrend, EMA9/21 and VWAP agreeing) runs at high RSI
  // and hugs the outer Bollinger band for long stretches. Scoring that as overbought/oversold made
  // the gate SKIP every trend-continuation entry, so in that regime it counts as momentum instead.
  const strongTrend = (params.adx14 ?? 0) >= 25;
  const strongUptrend = strongTrend && params.supertrendDirection === 'BULLISH'
    && params.ema9 > params.ema21 && params.currentPrice > params.vwap;
  const strongDowntrend = strongTrend && params.supertrendDirection === 'BEARISH'
    && params.ema9 < params.ema21 && params.currentPrice < params.vwap;

  // ── RSI ─────────────────────────────────────────────────────────────
  if (strongUptrend && params.rsi14 > 55) {
    if (params.rsi14 <= 80) {
      bullScore += 10;
      signals.push(`RSI ${params.rsi14.toFixed(0)} — momentum in strong uptrend`);
    } else {
      signals.push(`RSI ${params.rsi14.toFixed(0)} — stretched in uptrend, not scored`);
    }
  } else if (strongDowntrend && params.rsi14 < 45) {
    if (params.rsi14 >= 20) {
      bearScore += 10;
      signals.push(`RSI ${params.rsi14.toFixed(0)} — momentum in strong downtrend`);
    } else {
      signals.push(`RSI ${params.rsi14.toFixed(0)} — stretched in downtrend, not scored`);
    }
  } else if (params.rsi14 < 35) {
    bullScore += 25;
    signals.push(`RSI oversold (${params.rsi14.toFixed(0)})`);
  } else if (params.rsi14 < 45) {
    bullScore += 10;
    signals.push(`RSI approaching oversold (${params.rsi14.toFixed(0)})`);
  } else if (params.rsi14 > 65) {
    bearScore += 25;
    signals.push(`RSI overbought (${params.rsi14.toFixed(0)})`);
  } else if (params.rsi14 > 55) {
    bearScore += 10;
    signals.push(`RSI approaching overbought (${params.rsi14.toFixed(0)})`);
  }

  // ── MACD crossover ──────────────────────────────────────────────────
  const macdCross = params.macd - params.macdSignal;
  if (macdCross > 0 && params.macd < 0) {
    bullScore += 22;
    signals.push('MACD bullish crossover (below zero — strong)');
  } else if (macdCross > 0) {
    bullScore += 12;
    signals.push('MACD above signal line');
  } else if (macdCross < 0 && params.macd > 0) {
    bearScore += 22;
    signals.push('MACD bearish crossover (above zero — strong)');
  } else if (macdCross < 0) {
    bearScore += 12;
    signals.push('MACD below signal line');
  }

  // ── VWAP — most important intraday level ────────────────────────────
  if (params.currentPrice > params.vwap) {
    bullScore += 25;
    signals.push(`Price above VWAP (${params.vwap.toFixed(0)})`);
  } else {
    bearScore += 25;
    signals.push(`Price below VWAP (${params.vwap.toFixed(0)})`);
  }

  // ── EMA structure ───────────────────────────────────────────────────
  if (params.ema9 > params.ema21) {
    bullScore += 15;
    signals.push('9 EMA > 21 EMA (uptrend)');
  } else {
    bearScore += 15;
    signals.push('9 EMA < 21 EMA (downtrend)');
  }

  // ── Volume confirmation ─────────────────────────────────────────────
  if (params.volumeRatio > 1.5) {
    if (bullScore >= bearScore) {
      bullScore += 10;
      signals.push(`Volume spike confirms bullish (${params.volumeRatio.toFixed(1)}x)`);
    } else {
      bearScore += 10;
      signals.push(`Volume spike confirms bearish (${params.volumeRatio.toFixed(1)}x)`);
    }
  }

  // ── PCR ─────────────────────────────────────────────────────────────
  if (params.pcrRatio > 1.2) {
    bullScore += 8;
    signals.push(`High PCR ${params.pcrRatio.toFixed(2)} — bullish squeeze potential`);
  } else if (params.pcrRatio < 0.8) {
    bearScore += 8;
    signals.push(`Low PCR ${params.pcrRatio.toFixed(2)} — bearish risk`);
  }

  // ── Supertrend ——————————————————————————————————————————————————————
  // Highest-weight new indicator: Supertrend aligns with trend AND confirms entry
  if (params.supertrendDirection === 'BULLISH') {
    bullScore += 20;
    signals.push('Supertrend BULLISH — trend confirmed upward');
  } else if (params.supertrendDirection === 'BEARISH') {
    bearScore += 20;
    signals.push('Supertrend BEARISH — trend confirmed downward');
  }

  // ── ADX — trend strength gate ────────────────────────────────────────
  // ADX > 25: multiply directional scores (trending market = more reliable signals)
  // ADX < 20: discount all signals (choppy/ranging = false signals)
  if (params.adx14 != null) {
    if (params.adx14 > 25) {
      // Trending: boost whichever direction is leading
      const boost = Math.min(15, Math.round((params.adx14 - 25) * 0.5));
      if (bullScore > bearScore) {
        bullScore += boost;
        signals.push(`ADX=${params.adx14.toFixed(0)} trending — bull boost +${boost}`);
      } else {
        bearScore += boost;
        signals.push(`ADX=${params.adx14.toFixed(0)} trending — bear boost +${boost}`);
      }
    } else if (params.adx14 < 20) {
      // Choppy: discount both sides
      bullScore = Math.round(bullScore * 0.8);
      bearScore = Math.round(bearScore * 0.8);
      signals.push(`ADX=${params.adx14.toFixed(0)} — choppy market, signals discounted`);
    }
  }

  // ── Bollinger Band position ──────────────────────────────────────────
  if (params.bbPercentB != null) {
    if (params.bbPercentB <= 0.05) {
      if (strongDowntrend) {
        signals.push(`BB %B=${(params.bbPercentB * 100).toFixed(0)}% — riding lower band in downtrend, not scored`);
      } else {
        bullScore += 15;
        signals.push(`BB %B=${(params.bbPercentB * 100).toFixed(0)}% — price at lower band (oversold)`);
      }
    } else if (params.bbPercentB >= 0.95) {
      if (strongUptrend) {
        signals.push(`BB %B=${(params.bbPercentB * 100).toFixed(0)}% — riding upper band in uptrend, not scored`);
      } else {
        bearScore += 15;
        signals.push(`BB %B=${(params.bbPercentB * 100).toFixed(0)}% — price at upper band (overbought)`);
      }
    }
    // BB squeeze: upcoming breakout — don't add directional score but flag it
    if (params.bbBandwidth != null && params.bbBandwidth < 0.8) {
      signals.push(`BB squeeze (bandwidth=${params.bbBandwidth.toFixed(2)}%) — breakout imminent`);
    }
  }

  // ── Stochastic ──────────────────────────────────────────────────────
  if (params.stochK != null && params.stochD != null) {
    if (params.stochK < 20 && params.stochK > params.stochD) {
      bullScore += 12;
      signals.push(`Stoch bullish cross in oversold zone (%K=${params.stochK.toFixed(0)})`);
    } else if (params.stochK > 80 && params.stochK < params.stochD) {
      bearScore += 12;
      signals.push(`Stoch bearish cross in overbought zone (%K=${params.stochK.toFixed(0)})`);
    }
  }

  // ── VIX filter — high VIX weakens all signals ───────────────────────
  if (params.indiaVix > 22) {
    bullScore = Math.round(bullScore * 0.75);
    bearScore = Math.round(bearScore * 0.75);
    signals.push(`VIX ${params.indiaVix} — signals discounted 25%`);
  }

  // ── Time filter — late entries have theta risk ──────────────────────
  if (params.minutesToClose < 60) {
    bullScore = Math.round(bullScore * 0.7);
    bearScore = Math.round(bearScore * 0.7);
    signals.push(`< 60 min to close — theta decay risk, 30% penalty`);
  }

  // ── IV filter — don't buy when premium is very expensive ────────────
  if (params.ivPercentile > 85) {
    bullScore = Math.round(bullScore * 0.85);
    bearScore = Math.round(bearScore * 0.85);
    signals.push(`IV percentile ${params.ivPercentile}% — premium expensive, 15% penalty`);
  }

  // ── Normalise to 0-100 ──────────────────────────────────────────────
  const total = bullScore + bearScore;
  const buyPct = total > 0 ? Math.round((bullScore / (total + 15)) * 100) : 50;
  const bearPct = total > 0 ? Math.round((bearScore / (total + 15)) * 100) : 50;

  const signalCount = signals.length;
  const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
    signalCount >= 5 && Math.max(buyPct, bearPct) >= 75 ? 'HIGH'
    : signalCount >= 3 && Math.max(buyPct, bearPct) >= 60 ? 'MEDIUM'
    : 'LOW';

  const minPct = env.aiMinProbabilityPct;

  let action: RuleBasedResult['action'] = 'SKIP';
  if (buyPct >= minPct) action = 'BUY_CALL';
  else if (bearPct >= minPct) action = 'BUY_PUT';

  return {
    buyProbability: buyPct,
    sellSignal: bearScore > bullScore,
    confidence,
    action,
    signals,
    rawBullScore: bullScore,
    rawBearScore: bearScore,
  };
}
