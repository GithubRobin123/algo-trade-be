/**
 * token-renewal.service.ts
 *
 * Keeps the Upstox connection alive without the daily OTP/PIN login.
 *
 * Upstox access tokens always expire at 03:30 IST and Upstox issues no refresh tokens.
 * Instead it offers the "Access Token Request" API:
 *   1. We call POST /v3/login/auth/token/request/{client_id}.
 *   2. Upstox shows an approval prompt in the account holder's Upstox app + WhatsApp.
 *   3. On "Approve", Upstox POSTs the new token to the Notifier Webhook URL configured on the
 *      Upstox app → POST /api/auth/upstox/callback (auth.controller.handleUpstoxNotifierCallback).
 *
 * Schedule (Mon–Fri, IST): from UPSTOX_TOKEN_REQUEST_TIME_IST (default 08:30) until 15:30, if there
 * is no valid token, send a request; repeat every UPSTOX_TOKEN_REQUEST_RETRY_MINUTES while it is
 * still unapproved, at most UPSTOX_TOKEN_REQUEST_MAX_ATTEMPTS times per day. A manual request can
 * be sent from the dashboard at any time (at most one per minute).
 */

import { env } from '../config/env';
import { ApiError } from '../middleware/error.middleware';
import { tokenService } from './token.service';
import { upstoxService } from './upstox.service';
import { websocketService } from './websocket.service';

const CHECK_INTERVAL_MS = 60 * 1000;
const MIN_REQUEST_GAP_MS = 60 * 1000;
const MARKET_CLOSE_MINUTES = 15 * 60 + 30;
const DEFAULT_REQUEST_MINUTES = 8 * 60 + 30;

export type RenewalState = 'IDLE' | 'AWAITING_APPROVAL' | 'FAILED';

function istNow(): { date: string; minutes: number; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    weekday: get('weekday'),
  };
}

function requestStartMinutes(): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(env.upstoxTokenRequestTimeIst.trim());
  if (!match) return DEFAULT_REQUEST_MINUTES;
  return Number(match[1]) * 60 + Number(match[2]);
}

class TokenRenewalService {
  private timer: NodeJS.Timeout | null = null;
  private state: RenewalState = 'IDLE';
  private attemptsDate: string | null = null;
  private attemptsToday = 0;
  private lastRequestAt: Date | null = null;
  private approvalExpiresAt: Date | null = null;
  private lastError: string | null = null;
  private lastTrigger: string | null = null;

  constructor() {
    tokenService.onTokenSaved(() => this.handleTokenSaved());
  }

  start(): void {
    if (this.timer || !env.upstoxAutoTokenRequest) return;
    this.timer = setInterval(() => { void this.tick(); }, CHECK_INTERVAL_MS);
    void this.tick();
    process.stdout.write(`[TokenRenewal] Auto token request enabled (weekdays from ${env.upstoxTokenRequestTimeIst} IST).\n`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  getStatus() {
    return {
      autoRequestEnabled: env.upstoxAutoTokenRequest,
      scheduledTimeIst: env.upstoxTokenRequestTimeIst,
      state: this.state,
      lastRequestAt: this.lastRequestAt?.toISOString() ?? null,
      approvalExpiresAt: this.approvalExpiresAt?.toISOString() ?? null,
      attemptsToday: this.attemptsToday,
      maxAttemptsPerDay: env.upstoxTokenRequestMaxAttempts,
      lastTrigger: this.lastTrigger,
      lastError: this.lastError,
    };
  }

  /** Send an approval request to the account holder now (scheduler or dashboard button). */
  async requestNow(trigger: string): Promise<ReturnType<TokenRenewalService['getStatus']>> {
    // Throttle only while a sent request is waiting for approval — after a failure, retry at once
    if (
      this.state === 'AWAITING_APPROVAL' &&
      this.lastRequestAt &&
      Date.now() - this.lastRequestAt.getTime() < MIN_REQUEST_GAP_MS
    ) {
      throw new ApiError(429, 'A token request was sent less than a minute ago. Check the Upstox app / WhatsApp for the approval prompt.');
    }

    this.rollDay(istNow().date);
    this.lastRequestAt = new Date();
    this.attemptsToday += 1;
    this.lastTrigger = trigger;

    try {
      const result = await upstoxService.requestAccessToken();
      this.state = 'AWAITING_APPROVAL';
      this.approvalExpiresAt = result.authorizationExpiry;
      this.lastError = null;
      process.stdout.write(`[TokenRenewal] Approval request sent (${trigger}). Waiting for approval in the Upstox app / WhatsApp.\n`);
    } catch (error) {
      this.state = 'FAILED';
      this.lastError = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[TokenRenewal] Request failed (${trigger}): ${this.lastError}\n`);
      this.broadcast();
      throw error;
    }

    this.broadcast();
    return this.getStatus();
  }

  private async tick(): Promise<void> {
    try {
      const now = istNow();
      if (now.weekday === 'Sat' || now.weekday === 'Sun') return;
      if (now.minutes < requestStartMinutes() || now.minutes >= MARKET_CLOSE_MINUTES) return;

      this.rollDay(now.date);
      if (this.attemptsToday >= env.upstoxTokenRequestMaxAttempts) return;

      const retryGapMs = Math.max(1, env.upstoxTokenRequestRetryMinutes) * 60 * 1000;
      if (this.lastRequestAt && Date.now() - this.lastRequestAt.getTime() < retryGapMs) return;

      const status = await tokenService.getConnectionStatus();
      if (status.connected) return;

      await this.requestNow('scheduler');
    } catch {
      // requestNow already logged it; DB/status errors are retried on the next tick
    }
  }

  private rollDay(today: string): void {
    if (this.attemptsDate !== today) {
      this.attemptsDate = today;
      this.attemptsToday = 0;
    }
  }

  private handleTokenSaved(): void {
    this.state = 'IDLE';
    this.approvalExpiresAt = null;
    this.lastError = null;
    this.broadcast();
  }

  private broadcast(): void {
    websocketService.broadcast('auth_status', this.getStatus());
  }
}

export const tokenRenewalService = new TokenRenewalService();
