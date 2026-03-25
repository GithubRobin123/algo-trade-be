import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { env, envMeta } from '../config/env';
import { ApiError } from '../middleware/error.middleware';
import { tokenService } from '../services/token.service';
import { upstoxService } from '../services/upstox.service';

const buildFrontendRedirect = (status: 'success' | 'failed', message?: string): string => {
  const redirectUrl = new URL(env.frontendUrl);
  redirectUrl.searchParams.set('oauth', status);

  if (message) {
    redirectUrl.searchParams.set('message', message);
  }

  return redirectUrl.toString();
};

export const redirectToUpstoxLogin = (req: Request, res: Response): void => {
  const state = randomUUID();
  const loginUrl = upstoxService.getLoginUrl(state);

  if (req.query.redirect === 'false') {
    res.json({
      success: true,
      data: {
        loginUrl,
      },
    });
    return;
  }

  res.redirect(loginUrl);
};

export const handleUpstoxCallback = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const code = req.query.code;
    const upstoxError = req.query.error;

    console.info('[Upstox OAuth] GET callback received', {
      hasCode: typeof code === 'string' && code.length > 0,
      error: upstoxError,
      redirectUri: env.upstoxRedirectUri,
    });

    if (typeof upstoxError === 'string') {
      throw new ApiError(400, `Upstox OAuth error: ${upstoxError}`);
    }

    if (typeof code !== 'string' || !code) {
      throw new ApiError(
        400,
        'Missing authorization code in callback request. Verify redirect URI path and query forwarding in your tunnel.',
      );
    }

    await tokenService.exchangeAuthCode(code);
    const authStatus = await tokenService.getConnectionStatus();

    console.info('[Upstox OAuth] token saved', {
      connected: authStatus.connected,
      expiresAt: authStatus.expiresAt,
    });

    res.redirect(buildFrontendRedirect('success'));
  } catch (error) {
    if (error instanceof ApiError) {
      console.error('[Upstox OAuth] callback failed:', error.message);
      res.redirect(buildFrontendRedirect('failed', error.message));
      return;
    }

    next(error);
  }
};

export const exchangeUpstoxCode = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code =
      (body.code as string | undefined) ||
      (req.query.code as string | undefined);

    if (!code) {
      throw new ApiError(400, 'Missing authorization code.');
    }

    await tokenService.exchangeAuthCode(code);
    const status = await tokenService.getConnectionStatus();

    res.json({
      success: true,
      data: status,
      message: 'Upstox authorization code exchanged successfully.',
    });
  } catch (error) {
    next(error);
  }
};

export const handleUpstoxNotifierCallback = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const accessToken =
      (body.access_token as string | undefined) || (body.accessToken as string | undefined);

    if (!accessToken) {
      console.warn('[Upstox Notifier] callback received without access_token', {
        keys: Object.keys(body),
      });

      res.status(202).json({
        success: true,
        message: 'Notifier callback received but no access token found in payload.',
      });
      return;
    }

    await tokenService.saveNotifierToken({
      accessToken,
      tokenType:
        (body.token_type as string | undefined) || (body.tokenType as string | undefined) || 'Bearer',
      scope: (body.scope as string | undefined) || null,
      expiresAt:
        (body.expires_at as string | number | undefined) ||
        (body.expiresAt as string | number | undefined),
    });

    const savedStatus = await tokenService.getConnectionStatus();

    console.info('[Upstox Notifier] token saved via webhook', {
      connected: savedStatus.connected,
      expiresAt: savedStatus.expiresAt,
      tokenSuffix: accessToken.slice(-6),
    });

    res.json({
      success: true,
      message: 'Access token stored from notifier callback.',
    });
  } catch (error) {
    next(error);
  }
};

export const getAuthStatus = async (_req: Request, res: Response): Promise<void> => {
  const status = await tokenService.getConnectionStatus();

  res.json({
    success: true,
    data: status,
  });
};

export const getAuthDebug = async (_req: Request, res: Response): Promise<void> => {
  const status = await tokenService.getConnectionStatus();
  const callbackUrl = env.upstoxRedirectUri;
  let callbackPathValid = false;
  let callbackMode: 'backend_callback' | 'frontend_root' | 'custom' = 'custom';

  try {
    const pathname = new URL(callbackUrl).pathname;
    callbackPathValid = pathname === '/api/auth/upstox/callback' || pathname === '/';

    if (pathname === '/api/auth/upstox/callback') {
      callbackMode = 'backend_callback';
    } else if (pathname === '/') {
      callbackMode = 'frontend_root';
    }
  } catch {
    callbackPathValid = false;
  }

  res.json({
    success: true,
    data: {
      status,
      oauth: {
        callbackUrl,
        callbackPath: '/api/auth/upstox/callback',
        callbackPathValid,
        callbackMode,
        frontendRedirect: env.frontendUrl,
        hasClientId: Boolean(env.upstoxClientId),
        hasClientSecret: Boolean(env.upstoxClientSecret),
      },
      runtime: envMeta,
      timestamp: new Date().toISOString(),
    },
  });
};

export const disconnectUpstox = async (_req: Request, res: Response): Promise<void> => {
  await tokenService.disconnect();

  res.json({
    success: true,
    message: 'Upstox account disconnected',
  });
};
