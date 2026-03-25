import axios, { AxiosError, AxiosInstance } from 'axios';
import { env } from '../config/env';
import { ApiError } from '../middleware/error.middleware';
import {
  PlaceOrderPayload,
  UpstoxAccountProfile,
  UpstoxFundsSummary,
  UpstoxHoldingRecord,
  UpstoxLtpResult,
  UpstoxOAuthTokenResponse,
  UpstoxPositionRecord,
} from '../types/upstox.types';

const API_VERSION_V2 = '2.0';
const API_VERSION_V3 = '3.0';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const toText = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || null;
  }

  if (value === null || value === undefined) {
    return null;
  }

  return String(value);
};

export class UpstoxService {
  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: env.upstoxApiBaseUrl,
      timeout: 15000,
      headers: {
        Accept: 'application/json',
      },
    });
  }

  getLoginUrl(state: string): string {
    this.ensureOAuthConfig();

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: env.upstoxClientId,
      redirect_uri: env.upstoxRedirectUri,
      state,
    });

    return `${env.upstoxApiBaseUrl}/v2/login/authorization/dialog?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<UpstoxOAuthTokenResponse> {
    this.ensureOAuthConfig();

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: env.upstoxClientId,
      client_secret: env.upstoxClientSecret,
      redirect_uri: env.upstoxRedirectUri,
    });

    try {
      const { data } = await this.client.post<UpstoxOAuthTokenResponse>(
        '/v2/login/authorization/token',
        body.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
        },
      );

      return data;
    } catch (error) {
      throw this.toApiError(error, 'Failed to exchange Upstox authorization code');
    }
  }

  async refreshToken(refreshToken: string): Promise<UpstoxOAuthTokenResponse> {
    this.ensureOAuthConfig();

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env.upstoxClientId,
      client_secret: env.upstoxClientSecret,
    });

    try {
      const { data } = await this.client.post<UpstoxOAuthTokenResponse>(
        '/v2/login/authorization/token',
        body.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
        },
      );

      return data;
    } catch (error) {
      throw this.toApiError(error, 'Failed to refresh Upstox access token');
    }
  }

  async getNiftyLtp(accessToken: string, instrumentKey: string): Promise<UpstoxLtpResult> {
    try {
      const { data } = await this.client.get<Record<string, unknown>>('/v2/market-quote/ltp', {
        headers: this.authHeaders(accessToken, API_VERSION_V2),
        params: {
          instrument_key: instrumentKey,
        },
      });

      const root = (data?.data as Record<string, unknown>) ?? data;
      const quote =
        (root?.[instrumentKey] as Record<string, unknown> | undefined) ??
        (Object.values(root ?? {}).find((value) => typeof value === 'object') as
          | Record<string, unknown>
          | undefined);

      if (!quote) {
        throw new ApiError(502, 'Unexpected Upstox quote response shape');
      }

      const ltp =
        toNumber(quote.last_price) ??
        toNumber(quote.ltp) ??
        toNumber((quote.ohlc as Record<string, unknown> | undefined)?.close);

      if (ltp === null) {
        throw new ApiError(502, 'Could not parse LTP from Upstox quote response');
      }

      const timestamp =
        (quote.timestamp as string | undefined) ||
        (quote.last_trade_time as string | undefined) ||
        new Date().toISOString();

      const symbol =
        (quote.symbol as string | undefined) ||
        (quote.trading_symbol as string | undefined) ||
        instrumentKey;

      return {
        instrumentKey,
        symbol,
        ltp,
        timestamp,
        raw: quote,
      };
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw this.toApiError(error, 'Failed to fetch live price from Upstox');
    }
  }

  async getFullMarketQuote(
    accessToken: string,
    instrumentKeys: string[],
  ): Promise<Record<string, { ltp: number | null; close: number | null; raw: Record<string, unknown> }>> {
    const keys = instrumentKeys.filter((item) => item.trim() !== '');

    if (!keys.length) {
      return {};
    }

    try {
      const { data } = await this.client.get<Record<string, unknown>>('/v2/market-quote/quotes', {
        headers: this.authHeaders(accessToken, API_VERSION_V2),
        params: {
          instrument_key: keys.join(','),
        },
      });

      const root = asRecord(data.data ?? data);
      const response: Record<string, { ltp: number | null; close: number | null; raw: Record<string, unknown> }> = {};

      for (const [instrumentKey, payload] of Object.entries(root)) {
        const quote = asRecord(payload);
        const ohlc = asRecord(quote.ohlc);

        response[instrumentKey] = {
          ltp: toNumber(quote.last_price) ?? toNumber(quote.ltp),
          close: toNumber(ohlc.close),
          raw: quote,
        };
      }

      return response;
    } catch (error) {
      throw this.toApiError(error, 'Failed to fetch market quote details from Upstox');
    }
  }

  async getOptionChain(
    accessToken: string,
    instrumentKey: string,
    expiryDate?: string,
  ): Promise<Record<string, unknown>> {
    try {
      const { data } = await this.client.get<Record<string, unknown>>('/v2/option/chain', {
        headers: this.authHeaders(accessToken, API_VERSION_V2),
        params: {
          instrument_key: instrumentKey,
          ...(expiryDate ? { expiry_date: expiryDate } : {}),
        },
      });

      return data;
    } catch (error) {
      throw this.toApiError(error, 'Failed to fetch option chain from Upstox');
    }
  }

  async searchInstruments(accessToken: string, query: string): Promise<Record<string, unknown>[]> {
    if (!query.trim()) {
      return [];
    }

    try {
      const { data } = await this.client.get<Record<string, unknown>>('/v2/search/instruments', {
        headers: this.authHeaders(accessToken, API_VERSION_V2),
        params: {
          query,
        },
      });

      const root = asRecord(data.data ?? data);
      const responseData = data.data ?? data;
      const records = Array.isArray(responseData)
        ? responseData
        : Array.isArray(root.results)
          ? (root.results as unknown[])
          : Array.isArray(root.data)
            ? (root.data as unknown[])
            : [];

      if (!Array.isArray(records)) {
        return [];
      }

      return records.map((item) => asRecord(item));
    } catch {
      return [];
    }
  }

  async getFundsAndMargin(accessToken: string, segment: 'SEC' | 'COM' = 'SEC'): Promise<UpstoxFundsSummary> {
    try {
      const { data } = await this.client.get<Record<string, unknown>>('/v2/user/get-funds-and-margin', {
        headers: this.authHeaders(accessToken, API_VERSION_V2),
        params: {
          segment,
        },
      });

      const root = asRecord(data.data ?? data);
      const equity = asRecord(root.equity ?? root);
      const available = asRecord(equity.available_margin ?? equity.availableMargin);
      const utilized = asRecord(equity.utilised_margin ?? equity.utilized_margin ?? equity.used_margin);

      return {
        availableMargin: toNumber(available.cash ?? available.funds ?? available.total ?? equity.available_margin),
        usedMargin: toNumber(utilized.total ?? utilized.span ?? utilized.margin_used ?? equity.used_margin),
        payin: toNumber(equity.payin_amount ?? equity.payin),
        span: toNumber(utilized.span),
        exposure: toNumber(utilized.exposure),
        adhoc: toNumber(available.adhoc_margin),
        notionalCash: toNumber(available.notional_cash),
      };
    } catch (error) {
      throw this.toApiError(error, 'Failed to fetch funds and margin from Upstox');
    }
  }

  async getUserProfile(accessToken: string): Promise<UpstoxAccountProfile> {
    try {
      const { data } = await this.client.get<Record<string, unknown>>('/v2/user/profile', {
        headers: this.authHeaders(accessToken, API_VERSION_V2),
      });

      const root = asRecord(data.data ?? data);

      return {
        userId: toText(root.user_id ?? root.userId),
        email: toText(root.email),
        userName: toText(root.user_name ?? root.userName),
        broker: toText(root.broker),
      };
    } catch (error) {
      throw this.toApiError(error, 'Failed to fetch profile from Upstox');
    }
  }

  async getHoldings(accessToken: string): Promise<UpstoxHoldingRecord[]> {
    try {
      const { data } = await this.client.get<Record<string, unknown>>('/v2/portfolio/long-term-holdings', {
        headers: this.authHeaders(accessToken, API_VERSION_V2),
      });

      const root = asRecord(data.data ?? data);
      const records = Array.isArray(root) ? root : (root.holdings as unknown[]) || (root.data as unknown[]);

      if (!Array.isArray(records)) {
        return [];
      }

      return records
        .map((item) => this.normalizeHolding(item))
        .filter((item): item is UpstoxHoldingRecord => item !== null);
    } catch (error) {
      throw this.toApiError(error, 'Failed to fetch holdings from Upstox');
    }
  }

  async getPositions(accessToken: string): Promise<UpstoxPositionRecord[]> {
    try {
      const { data } = await this.client.get<Record<string, unknown>>('/v2/portfolio/short-term-positions', {
        headers: this.authHeaders(accessToken, API_VERSION_V2),
      });

      const root = asRecord(data.data ?? data);
      const records =
        (root.positions as unknown[]) ||
        (root.data as unknown[]) ||
        (Array.isArray(root) ? (root as unknown[]) : []);

      if (!Array.isArray(records)) {
        return [];
      }

      return records
        .map((item) => this.normalizePosition(item))
        .filter((item): item is UpstoxPositionRecord => item !== null);
    } catch (error) {
      throw this.toApiError(error, 'Failed to fetch positions from Upstox');
    }
  }

  async getMtfPositions(accessToken: string): Promise<UpstoxPositionRecord[]> {
    try {
      const { data } = await this.client.get<Record<string, unknown>>('/v3/portfolio/mtf-positions', {
        headers: this.authHeaders(accessToken, API_VERSION_V3),
      });

      const root = asRecord(data.data ?? data);
      const records =
        (root.positions as unknown[]) ||
        (root.data as unknown[]) ||
        (Array.isArray(root) ? (root as unknown[]) : []);

      if (!Array.isArray(records)) {
        return [];
      }

      return records
        .map((item) => this.normalizePosition(item))
        .filter((item): item is UpstoxPositionRecord => item !== null);
    } catch {
      return [];
    }
  }

  async placeOrder(
    accessToken: string,
    payload: PlaceOrderPayload,
  ): Promise<Record<string, unknown>> {
    try {
      console.log('Placing order with payload:', payload);
      // const { data } = await this.client.post<Record<string, unknown>>('/v2/order/place', payload, {
      //   headers: {
      //     ...this.authHeaders(accessToken, API_VERSION_V2),
      //     'Content-Type': 'application/json',
      //   },
      // });

      // return data;
      return {};

    } catch (error) {
      throw this.toApiError(error, 'Failed to place order on Upstox');
    }
  }

  private normalizeHolding(input: unknown): UpstoxHoldingRecord | null {
    const row = asRecord(input);
    const instrumentKey = toText(row.instrument_token ?? row.instrument_key ?? row.instrumentKey);
    const tradingSymbol = toText(row.trading_symbol ?? row.symbol ?? row.tradingSymbol);

    if (!instrumentKey || !tradingSymbol) {
      return null;
    }

    return {
      instrumentKey,
      tradingSymbol,
      exchange: toText(row.exchange),
      quantity: toNumber(row.quantity) ?? 0,
      averagePrice: toNumber(row.average_price ?? row.avg_price),
      lastPrice: toNumber(row.last_price ?? row.ltp),
      pnl: toNumber(row.pnl),
      product: toText(row.product),
    };
  }

  private normalizePosition(input: unknown): UpstoxPositionRecord | null {
    const row = asRecord(input);
    const instrumentKey = toText(row.instrument_token ?? row.instrument_key ?? row.instrumentKey);
    const tradingSymbol = toText(row.trading_symbol ?? row.symbol ?? row.tradingSymbol);

    if (!instrumentKey || !tradingSymbol) {
      return null;
    }

    return {
      instrumentKey,
      tradingSymbol,
      exchange: toText(row.exchange),
      quantity: toNumber(row.quantity ?? row.net_quantity) ?? 0,
      averagePrice: toNumber(row.average_price ?? row.avg_price),
      lastPrice: toNumber(row.last_price ?? row.ltp),
      pnl: toNumber(row.pnl),
      product: toText(row.product),
    };
  }

  private authHeaders(accessToken: string, apiVersion: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Api-Version': apiVersion,
      Accept: 'application/json',
    };
  }

  private ensureOAuthConfig(): void {
    if (!env.upstoxClientId || !env.upstoxClientSecret || !env.upstoxRedirectUri) {
      throw new ApiError(
        500,
        'Upstox OAuth variables are not configured. Set UPSTOX_CLIENT_ID, UPSTOX_CLIENT_SECRET and UPSTOX_REDIRECT_URI.',
      );
    }

    let parsedRedirectUri: URL;
    try {
      parsedRedirectUri = new URL(env.upstoxRedirectUri);
    } catch {
      throw new ApiError(
        500,
        `UPSTOX_REDIRECT_URI is invalid: ${env.upstoxRedirectUri}. Use a valid absolute URL.`,
      );
    }

    if (!parsedRedirectUri.protocol.startsWith('http')) {
      throw new ApiError(
        500,
        `UPSTOX_REDIRECT_URI must be http/https. Current value: ${env.upstoxRedirectUri}`,
      );
    }
  }

  private toApiError(error: unknown, fallbackMessage: string): ApiError {
    const axiosError = error as AxiosError<{
      message?: string;
      error?: string;
      errors?: { message?: string }[];
    }>;

    const statusCode = axiosError.response?.status ?? 502;
    const rawMessage =
      axiosError.response?.data?.message ||
      axiosError.response?.data?.error ||
      axiosError.response?.data?.errors?.[0]?.message ||
      axiosError.message ||
      fallbackMessage;
    let message = rawMessage;

    if (/no segments for these users are active/i.test(rawMessage)) {
      message =
        'Upstox account segment is inactive (F&O/Equity/Commodity). Activate required segment in Upstox app/web, then retry OAuth.';
    } else if (/invalid auth code/i.test(rawMessage)) {
      message =
        'Invalid or already-used OAuth code. Restart Upstox login and exchange the new code immediately.';
    } else if (/client_id.+redirect_uri.+incorrect/i.test(rawMessage)) {
      message =
        "Upstox rejected client_id/redirect_uri. Ensure both exactly match the app configuration in Upstox Developer Console.";
    }

    return new ApiError(statusCode, message);
  }
}

export const upstoxService = new UpstoxService();
