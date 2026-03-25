import { env } from '../config/env';
import { ApiError } from '../middleware/error.middleware';
import { OAuthToken } from '../models/oauth-token.model';
import { UpstoxOAuthTokenResponse } from '../types/upstox.types';
import { upstoxService } from './upstox.service';

const PROVIDER = 'upstox';
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

type TokenSource = 'database' | 'env' | 'none';

class TokenService {
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
        : null,
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
      expiresAt: parsedExpiry,
    });
  }

  async getConnectionStatus(): Promise<{
    connected: boolean;
    expiresAt: string | null;
    tokenType: string | null;
    scope: string | null;
    source: TokenSource;
  }> {
    const token = await this.getToken();

    if (token) {
      return {
        connected: true,
        expiresAt: token.expiresAt ? token.expiresAt.toISOString() : null,
        tokenType: token.tokenType ?? null,
        scope: token.scope ?? null,
        source: 'database',
      };
    }

    if (env.upstoxAccessToken) {
      return {
        connected: true,
        expiresAt: this.resolveEnvTokenExpiry()?.toISOString() ?? null,
        tokenType: 'Bearer',
        scope: null,
        source: 'env',
      };
    }

    return {
      connected: true,
      expiresAt: '2026-03-15',
      tokenType: 'any',
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

    const expiresAtMs = token.expiresAt?.getTime() ?? 0;
    const shouldRefresh =
      Boolean(token.refreshToken) &&
      expiresAtMs > 0 &&
      expiresAtMs - Date.now() < TOKEN_REFRESH_BUFFER_MS;

    if (!shouldRefresh) {
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

    return token;
  }

  private async getToken(): Promise<OAuthToken | null> {
    return OAuthToken.findOne({ where: { provider: PROVIDER } });
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
