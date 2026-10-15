/**
 * market-stream.service.ts
 *
 * Real-time prices from the Upstox Market Data Feed V3 (WebSocket + protobuf).
 *
 * Upstox allows 2 WebSocket connections per user, so each backend opens exactly ONE connection
 * and puts every instrument on it (EC2 + one laptop = 2):
 *   - active index          → mode "full": LTP + day OHLC, stored as ticks (≤ 1/s) for candles/charts
 *   - India VIX             → mode "ltpc"
 *   - each OPEN position's option → mode "ltpc": every tick is pushed to the execution engine,
 *     which checks stop loss / target on the spot (no 5-second wait)
 *
 * Connected on weekdays 09:00–15:35 IST while a valid Upstox token exists. If the socket drops it
 * reconnects with backoff (2s … 60s). Meanwhile the REST poll (market-data.service) and the 5s
 * monitor cycle (execution.service) carry on, so trading never depends on the stream being up.
 */

import { randomUUID } from 'crypto';
import protobuf from 'protobufjs';
import { RawData, WebSocket } from 'ws';
import { env } from '../config/env';
import { StrategyPosition } from '../models/strategy-position.model';
import { FEED_RESPONSE_TYPE, MARKET_FEED_V3_PROTO } from './market-feed.proto';
import { marketDataService, setLiveVix } from './market-data.service';
import { tokenService } from './token.service';
import { underlyingService } from './underlying.service';
import { upstoxService } from './upstox.service';

type FeedMode = 'ltpc' | 'full';
type PriceListener = (instrumentKey: string, ltp: number) => void;
export type StreamState = 'DISABLED' | 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'RECONNECT_WAIT';

const VIX_KEY = 'NSE_INDEX|India VIX';
const SUPERVISOR_INTERVAL_MS = 2_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const STALE_FEED_MS = 30_000;
const PERSIST_INTERVAL_MS = 1_000;
const WINDOW_START_MINUTES = 9 * 60;
const WINDOW_END_MINUTES = 15 * 60 + 35;
const OPEN_SEGMENTS = ['NSE_INDEX', 'NSE_FO', 'BSE_INDEX', 'BSE_FO'];

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const toNum = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function istClock(): { minutes: number; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return { minutes: Number(get('hour')) * 60 + Number(get('minute')), weekday: get('weekday') };
}

class MarketStreamService {
  private readonly feedType = protobuf.parse(MARKET_FEED_V3_PROTO, { keepCase: true }).root.lookupType(FEED_RESPONSE_TYPE);
  private socket: WebSocket | null = null;
  private supervisor: NodeJS.Timeout | null = null;
  private state: StreamState = env.upstoxStreamEnabled ? 'IDLE' : 'DISABLED';
  private connecting = false;
  private reconnectAttempts = 0;
  private nextConnectAt = 0;
  private lastMessageAt = 0;
  private lastError: string | null = null;
  private marketOpen = false;
  private ticksReceived = 0;
  private desired = new Map<string, FeedMode>();
  private subscribed = new Map<string, FeedMode>();
  private latest = new Map<string, { ltp: number; at: number }>();
  private lastPersistAt = new Map<string, number>();
  private readonly listeners: PriceListener[] = [];

  constructor() {
    // A fresh token (daily approval / OTP login) → reconnect right away with it
    tokenService.onTokenSaved(() => this.reconnectNow('new Upstox token'));
  }

  start(): void {
    if (this.supervisor || !env.upstoxStreamEnabled) return;
    this.supervisor = setInterval(() => { void this.supervise(); }, SUPERVISOR_INTERVAL_MS);
    void this.supervise();
    process.stdout.write('[Stream] Upstox WebSocket feed enabled (weekdays 09:00–15:35 IST).\n');
  }

  stop(): void {
    if (this.supervisor) {
      clearInterval(this.supervisor);
      this.supervisor = null;
    }
    this.closeSocket('stopped');
  }

  /** Called for every streamed price (except VIX). Listeners must be fast and never throw. */
  onPrice(listener: PriceListener): void {
    this.listeners.push(listener);
  }

  /** Latest streamed price, or null if none arrived within `maxAgeMs`. */
  getFreshPrice(instrumentKey: string, maxAgeMs: number): number | null {
    const price = this.latest.get(instrumentKey);
    return price && Date.now() - price.at <= maxAgeMs ? price.ltp : null;
  }

  getStatus() {
    return {
      enabled: env.upstoxStreamEnabled,
      state: this.state,
      marketOpen: this.marketOpen,
      subscribed: [...this.subscribed.entries()].map(([instrumentKey, mode]) => ({ instrumentKey, mode })),
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      ticksReceived: this.ticksReceived,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
    };
  }

  /** Opens the socket on an authorized wss:// URL (public so a local test feed can be used). */
  openSocket(url: string): void {
    const socket = new WebSocket(url, { followRedirects: true });
    this.socket = socket;
    this.connecting = true;
    this.state = 'CONNECTING';

    socket.on('open', () => {
      this.connecting = false;
      this.state = 'CONNECTED';
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      this.lastError = null;
      this.subscribed.clear();
      process.stdout.write('[Stream] Connected to Upstox market feed.\n');
      this.syncSubscriptions();
    });
    socket.on('message', (data: RawData) => this.handleMessage(data));
    socket.on('error', (error: Error) => { this.lastError = error.message; });
    socket.on('close', (code: number, reason: Buffer) => {
      if (this.socket !== socket) return; // closed on purpose / already replaced
      this.socket = null;
      this.connecting = false;
      this.subscribed.clear();
      const why = reason.length ? `: ${reason.toString()}` : '';
      this.scheduleReconnect(`Feed closed (${code}${why})${this.lastError ? ` — ${this.lastError}` : ''}`);
    });
  }

  /** Decode one feed frame, update prices, notify listeners, store index ticks (≤ 1/s). */
  handleMessage(data: RawData): void {
    this.lastMessageAt = Date.now();

    let decoded: Record<string, unknown>;
    try {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      const message = this.feedType.decode(buffer);
      decoded = this.feedType.toObject(message, { longs: Number, enums: String }) as Record<string, unknown>;
    } catch (error) {
      this.lastError = `Could not decode feed message: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }

    if (decoded.type === 'market_info') {
      const segments = asRecord(asRecord(decoded.marketInfo).segmentStatus);
      this.marketOpen = OPEN_SEGMENTS.some((segment) => segments[segment] === 'NORMAL_OPEN');
      const summary = OPEN_SEGMENTS.filter((s) => segments[s]).map((s) => `${s}=${String(segments[s])}`).join(', ');
      process.stdout.write(`[Stream] Market status: ${summary || 'n/a'}\n`);
      return;
    }

    const now = Date.now();
    for (const [instrumentKey, rawFeed] of Object.entries(asRecord(decoded.feeds))) {
      const feed = asRecord(rawFeed);
      const fullFeed = asRecord(feed.fullFeed);
      const body = asRecord(fullFeed.indexFF ?? fullFeed.marketFF ?? feed.firstLevelWithGreeks);
      const ltpc = asRecord(feed.ltpc ?? body.ltpc);
      const ltp = toNum(ltpc.ltp);
      if (ltp === null || ltp <= 0) continue;

      this.ticksReceived += 1;
      this.latest.set(instrumentKey, { ltp, at: now });

      if (instrumentKey === VIX_KEY) {
        setLiveVix(ltp);
        continue;
      }

      for (const listener of this.listeners) {
        try { listener(instrumentKey, ltp); } catch { /* a listener must never break the feed */ }
      }

      if (this.desired.get(instrumentKey) === 'full') {
        this.persistIndexTick(instrumentKey, ltp, ltpc, body, now);
      }
    }
  }

  private persistIndexTick(
    instrumentKey: string,
    ltp: number,
    ltpc: Record<string, unknown>,
    body: Record<string, unknown>,
    now: number,
  ): void {
    if (now - (this.lastPersistAt.get(instrumentKey) ?? 0) < PERSIST_INTERVAL_MS) return;
    this.lastPersistAt.set(instrumentKey, now);

    const ohlcList = Array.isArray(asRecord(body.marketOHLC).ohlc) ? (asRecord(body.marketOHLC).ohlc as unknown[]) : [];
    const day = asRecord(ohlcList.map(asRecord).find((o) => o.interval === '1d'));
    let ltt = toNum(ltpc.ltt) ?? 0;
    if (ltt > 0 && ltt < 1e12) ltt *= 1000; // seconds → ms, just in case
    const symbol = underlyingService.list().find((u) => u.instrumentKey === instrumentKey)?.symbol ?? instrumentKey;

    // Same payload shape as the REST quote, so candles keep day high/low/previous close
    const payload = {
      source: 'upstox-ws',
      ltq: toNum(ltpc.ltq),
      ohlc: { open: toNum(day.open), high: toNum(day.high), low: toNum(day.low), close: toNum(ltpc.cp) },
    };

    marketDataService
      .ingestTick(instrumentKey, ltp, symbol, new Date(ltt > 0 ? ltt : now).toISOString(), payload)
      .catch((error: unknown) => { this.lastError = `Tick store failed: ${String(error)}`; });
  }

  private async supervise(): Promise<void> {
    try {
      const clock = istClock();
      const inWindow = clock.weekday !== 'Sat' && clock.weekday !== 'Sun'
        && clock.minutes >= WINDOW_START_MINUTES && clock.minutes <= WINDOW_END_MINUTES;
      if (!inWindow) {
        if (this.socket) this.closeSocket('outside market window');
        this.state = 'IDLE';
        return;
      }

      await this.refreshDesired();

      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        // Dead-connection check: while the market is open the index ticks every second
        if (this.marketOpen && Date.now() - this.lastMessageAt > STALE_FEED_MS) {
          this.lastError = `No feed data for ${STALE_FEED_MS / 1000}s`;
          this.socket.terminate(); // the close handler schedules the reconnect
          return;
        }
        this.syncSubscriptions();
        return;
      }

      if (this.socket || this.connecting || Date.now() < this.nextConnectAt) return;

      const status = await tokenService.getConnectionStatus();
      if (!status.connected) {
        this.state = 'IDLE';
        return;
      }
      await this.connect();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private async connect(): Promise<void> {
    this.connecting = true;
    this.state = 'CONNECTING';
    try {
      const accessToken = await tokenService.getValidAccessToken();
      const url = await upstoxService.authorizeMarketFeed(accessToken); // one-time URL per connect
      this.openSocket(url);
    } catch (error) {
      this.connecting = false;
      this.scheduleReconnect(`Feed connect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async refreshDesired(): Promise<void> {
    const desired = new Map<string, FeedMode>();
    desired.set(underlyingService.getActive().instrumentKey, 'full');
    if (env.indiaVixOverride === 0) desired.set(VIX_KEY, 'ltpc');

    const open = await StrategyPosition.findAll({ where: { status: 'OPEN' }, attributes: ['instrumentKey'] });
    for (const position of open) {
      if (!desired.has(position.instrumentKey)) desired.set(position.instrumentKey, 'ltpc');
    }
    this.desired = desired;
  }

  private syncSubscriptions(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    const toSubscribe = new Map<FeedMode, string[]>();
    const toChangeMode = new Map<FeedMode, string[]>();
    for (const [key, mode] of this.desired) {
      const current = this.subscribed.get(key);
      if (current === mode) continue;
      const bucket = current ? toChangeMode : toSubscribe;
      bucket.set(mode, [...(bucket.get(mode) ?? []), key]);
    }
    for (const [mode, keys] of toSubscribe) this.send('sub', keys, mode);
    for (const [mode, keys] of toChangeMode) this.send('change_mode', keys, mode);
    for (const [mode, keys] of [...toSubscribe, ...toChangeMode]) keys.forEach((k) => this.subscribed.set(k, mode));

    const removed = [...this.subscribed.keys()].filter((key) => !this.desired.has(key));
    if (removed.length) {
      this.send('unsub', removed);
      removed.forEach((key) => {
        this.subscribed.delete(key);
        this.latest.delete(key);
      });
    }
  }

  private send(method: 'sub' | 'unsub' | 'change_mode', instrumentKeys: string[], mode?: FeedMode): void {
    const message = { guid: randomUUID(), method, data: { ...(mode ? { mode } : {}), instrumentKeys } };
    // Upstox requires subscription requests as binary frames
    this.socket?.send(Buffer.from(JSON.stringify(message)));
  }

  private scheduleReconnect(reason: string): void {
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.nextConnectAt = Date.now() + delay;
    this.state = 'RECONNECT_WAIT';
    this.lastError = reason;
    const hint = /\b(403|429)\b|limit/i.test(reason)
      ? ' (Upstox allows 2 feed connections per user; another app or instance may be using them)'
      : '';
    process.stderr.write(`[Stream] ${reason}${hint}. Retrying in ${Math.round(delay / 1000)}s; REST polling covers the gap.\n`);
  }

  private reconnectNow(reason: string): void {
    this.closeSocket(reason);
    this.reconnectAttempts = 0;
    this.nextConnectAt = 0;
  }

  private closeSocket(reason: string): void {
    const socket = this.socket;
    this.socket = null; // the close handler ignores sockets closed on purpose
    this.connecting = false;
    this.subscribed.clear();
    this.state = env.upstoxStreamEnabled ? 'IDLE' : 'DISABLED';
    if (socket) {
      try { socket.close(1000, reason.slice(0, 100)); } catch { /* already closed */ }
    }
  }
}

export const marketStreamService = new MarketStreamService();
