import { env } from '../config/env';
import { ApiError } from '../middleware/error.middleware';
import { OAuthToken } from '../models/oauth-token.model';
import { UpstoxOAuthTokenResponse } from '../types/upstox.types';
import { upstoxService } from './upstox.service';

const PROVIDER = 'upstox';
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

type TokenSource = 'database' | 'env' | 'none';
type TokenSavedListener = () => void;

/** Upstox access tokens expire at 03:30 IST the next morning, whatever time they were issued. */
export const nextUpstoxExpiry = (from: Date = new Date()): Date => {
  const ist = new Date(from.getTime() + IST_OFFSET_MS);
  const expiryIst = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 3, 30, 0, 0));
  if (expiryIst.getTime() <= ist.getTime()) {
    expiryIst.setUTCDate(expiryIst.getUTCDate() + 1);
  }
  return new Date(expiryIst.getTime() - IST_OFFSET_MS);
};

class TokenService {
  private readonly savedListeners: TokenSavedListener[] = [];

  /** Called after every successful token save (OAuth login or notifier webhook). */
  onTokenSaved(listener: TokenSavedListener): void {
    this.savedListeners.push(listener);
  }

  async exchangeAuthCode(code: string): Promise<void> {
    const tokenResponse = await upstoxService.exchangeCodeForToken(code);
    if (!tokenResponse.access_token) {
      throw new ApiError(502, 'Upstox token exchange response did not include access_token.');
    }

    await this.saveToken(tokenResponse);
  }

  async saveToken(tokenResponse: UpstoxOAuthTokenResponse): Promise<OAuthToken> {
    const expiresInSeconds = tokenResponse.expires_in ?? 0;

    return this.upsertToken({
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? null,
      tokenType: tokenResponse.token_type ?? 'Bearer',
      scope: tokenResponse.scope ?? null,
      expiresAt: expiresInSeconds
        ? new Date(Date.now() + expiresInSeconds * 1000)
        : nextUpstoxExpiry(),
    });
  }

  async saveNotifierToken(payload: {
    accessToken: string;
    tokenType?: string | null;
    scope?: string | null;
    expiresAt?: string | number | null;
  }): Promise<OAuthToken> {
    let parsedExpiry: Date | null = null;

    if (payload.expiresAt !== undefined && payload.expiresAt !== null && payload.expiresAt !== '') {
      const asNumber = Number(payload.expiresAt);

      if (!Number.isNaN(asNumber)) {
        parsedExpiry = new Date(asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1000);
      } else {
        const asDate = new Date(payload.expiresAt);
        if (!Number.isNaN(asDate.getTime())) {
          parsedExpiry = asDate;
        }
      }
    }

    return this.upsertToken({
      accessToken: payload.accessToken,
      refreshToken: null,
      tokenType: payload.tokenType ?? 'Bearer',
      scope: payload.scope ?? null,
      expiresAt: parsedExpiry ?? nextUpstoxExpiry(),
    });
  }

  async getConnectionStatus(): Promise<{
    connected: boolean;
    expired: boolean;
    expiresAt: string | null;
    tokenType: string | null;
    scope: string | null;
    source: TokenSource;
  }> {
    const token = await this.getToken();

    if (token) {
      const expiresAt = this.effectiveExpiry(token);
      const expired = expiresAt.getTime() <= Date.now() && !token.refreshToken;
      return {
        connected: !expired,
        expired,
        expiresAt: expiresAt.toISOString(),
        tokenType: token.tokenType ?? null,
        scope: token.scope ?? null,
        source: 'database',
      };
    }

    if (env.upstoxAccessToken) {
      const envExpiry = this.resolveEnvTokenExpiry();
      const expired = envExpiry !== null && envExpiry.getTime() <= Date.now();
      return {
        connected: !expired,
        expired,
        expiresAt: envExpiry?.toISOString() ?? null,
        tokenType: 'Bearer',
        scope: null,
        source: 'env',
      };
    }

    return {
      connected: false,
      expired: false,
      expiresAt: null,
      tokenType: null,
      scope: null,
      source: 'none',
    };
  }

  async disconnect(): Promise<void> {
    await OAuthToken.destroy({ where: { provider: PROVIDER } });
  }

  async getValidAccessToken(): Promise<string> {
    const token = await this.getToken();

    if (!token && env.upstoxAccessToken) {
      const envExpiry = this.resolveEnvTokenExpiry();

      if (envExpiry && envExpiry.getTime() < Date.now()) {
        throw new ApiError(
          401,
          'UPSTOX_ACCESS_TOKEN is configured but expired. Update token or OAuth-login again.',
        );
      }

      return env.upstoxAccessToken;
    }

    if (!token) {
      throw new ApiError(
        401,
        'Upstox account is not connected. Complete OAuth login before requesting market data or placing orders.',
      );
    }

    const expiresAtMs = this.effectiveExpiry(token).getTime();
    const shouldRefresh =
      Boolean(token.refreshToken) &&
      expiresAtMs - Date.now() < TOKEN_REFRESH_BUFFER_MS;

    if (!shouldRefresh) {
      if (expiresAtMs <= Date.now()) {
        throw new ApiError(
          401,
          `Upstox access token expired at ${new Date(expiresAtMs).toISOString()}. Approve the token request in the Upstox app / WhatsApp, or log in again.`,
        );
      }
      return token.accessToken;
    }

    const refreshed = await upstoxService.refreshToken(token.refreshToken as string);

    const updatedToken = await this.saveToken({
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? token.refreshToken ?? undefined,
    });

    return updatedToken.accessToken;
  }

  private async upsertToken(input: {
    accessToken: string;
    refreshToken: string | null;
    tokenType: string | null;
    scope: string | null;
    expiresAt: Date | null;
  }): Promise<OAuthToken> {
    const [token] = await OAuthToken.upsert({
      provider: PROVIDER,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      tokenType: input.tokenType,
      scope: input.scope,
      expiresAt: input.expiresAt,
    });

    for (const listener of this.savedListeners) {
      try { listener(); } catch { /* listeners must never break token saving */ }
    }

    return token;
  }

  private async getToken(): Promise<OAuthToken | null> {
    return OAuthToken.findOne({ where: { provider: PROVIDER } });
  }

  /** Stored expiry, or — for older rows saved without one — the 03:30 IST after it was saved. */
  private effectiveExpiry(token: OAuthToken): Date {
    return token.expiresAt ?? nextUpstoxExpiry(token.updatedAt ?? new Date());
  }

  private resolveEnvTokenExpiry(): Date | null {
    const raw = env.upstoxAccessTokenExpiresAt;

    if (!raw) {
      return null;
    }

    const asNumber = Number(raw);
    if (!Number.isNaN(asNumber)) {
      return new Date(asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1000);
    }

    const asDate = new Date(raw);
    if (Number.isNaN(asDate.getTime())) {
      return null;
    }

    return asDate;
  }
}

export const tokenService = new TokenService();
