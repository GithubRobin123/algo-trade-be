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
Holding period: intraday only (minutes to a few hours), hard 2% trailing stop loss on option premium.
Square-off before 3:15 PM IST.

INDIAN MARKET CONTEXT:
- Nifty options: 50-point strike intervals, lot size 75
- Sensex options: 100-point strike intervals, lot size 10
- VWAP is the most important intraday level
- Theta decay accelerates after 2 PM IST — penalise late entries
- Weekly expiry: NEVER buy on expiry day (avoid extreme theta)
- VIX > 22 = elevated volatility — widen your uncertainty, lower probability
- PCR > 1.2 = market is net-hedged bearishly, potential for bullish bounce
- PCR < 0.8 = under-hedged, vulnerable to sell-off

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
  const slLevel = (p.optionPremium * 0.98).toFixed(1);
  const rsiNote = p.rsi14 < 35 ? ' ← OVERSOLD' : p.rsi14 > 65 ? ' ← OVERBOUGHT' : '';
  const volNote = p.volumeRatio > 1.5 ? ` ← HIGH VOLUME SPIKE (${p.volumeRatio.toFixed(1)}x)` : '';
  const vixNote = p.indiaVix > 22 ? ` ← ELEVATED VIX (${p.indiaVix})` : '';
  const dayPctRange = p.dayHigh > p.dayLow
    ? (((p.currentPrice - p.dayLow) / (p.dayHigh - p.dayLow)) * 100).toFixed(0)
    : '50';

  return `TRADE SETUP ANALYSIS — ${p.index}

PROPOSED TRADE:
  Action    : BUY ${p.optionType} option
  ATM Strike: ${p.atmStrike}
  Premium   : ₹${p.optionPremium}
  Hard SL   : ₹${slLevel} (2% trailing stop on premium)
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

OPTION CHAIN:
  ATM Call OI : ${(p.atmCallOI / 100000).toFixed(1)} lakh contracts
  ATM Put OI  : ${(p.atmPutOI / 100000).toFixed(1)} lakh contracts
  PCR (near ATM): ${p.pcrRatio.toFixed(2)} — ${pcrNote}
  IV Percentile : ${p.ivPercentile}%${p.ivPercentile > 80 ? ' ← EXPENSIVE premium' : p.ivPercentile < 20 ? ' ← CHEAP premium' : ''}

Given all the above, what is the probability this BUY ${p.optionType} entry will be profitable with a 2% trailing stop loss?`;
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

export function computeRuleBasedDecision(params: AiDecisionParams): RuleBasedResult {
  let bullScore = 0;
  let bearScore = 0;
  const signals: string[] = [];

  // ── RSI ─────────────────────────────────────────────────────────────
  if (params.rsi14 < 35) {
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

  // ── VIX filter — high VIX weakens all signals ───────────────────────
  if (params.indiaVix > 22) {
    bullScore = Math.round(bullScore * 0.75);
    bearScore = Math.round(bearScore * 0.75);
    signals.push(`VIX ${params.indiaVix} — signals discounted`);
  }

  // ── Time filter — late entries have theta risk ──────────────────────
  if (params.minutesToClose < 60) {
    bullScore = Math.round(bullScore * 0.7);
    bearScore = Math.round(bearScore * 0.7);
    signals.push(`< 60 min to close — premium decay risk`);
  }

  // ── Normalise to 0-100 ──────────────────────────────────────────────
  const total = bullScore + bearScore;
  const buyPct = total > 0 ? Math.round((bullScore / (total + 15)) * 100) : 50;
  const bearPct = total > 0 ? Math.round((bearScore / (total + 15)) * 100) : 50;

  const signalCount = signals.length;
  const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
    signalCount >= 4 && Math.max(buyPct, bearPct) >= 75 ? 'HIGH'
    : signalCount >= 2 && Math.max(buyPct, bearPct) >= 60 ? 'MEDIUM'
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
