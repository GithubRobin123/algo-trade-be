import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { env, envMeta } from '../config/env';
import { ApiError } from '../middleware/error.middleware';
import { tokenRenewalService } from '../services/token-renewal.service';
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

    // Anyone can POST to this URL, so only store a token that is for this app and actually works.
    const messageType = body.message_type as string | undefined;
    if (messageType && messageType !== 'access_token') {
      res.status(202).json({ success: true, message: `Ignored notifier message_type '${messageType}'.` });
      return;
    }

    const clientId = (body.client_id as string | undefined) ?? (body.clientId as string | undefined);
    if (clientId && clientId !== env.upstoxClientId) {
      console.warn('[Upstox Notifier] rejected token for a different client_id');
      throw new ApiError(403, 'Notifier token is for a different Upstox app.');
    }

    let profileUserId: string | null = null;
    try {
      profileUserId = (await upstoxService.getUserProfile(accessToken)).userId;
    } catch (verifyError) {
      if (verifyError instanceof ApiError && (verifyError.statusCode === 401 || verifyError.statusCode === 403)) {
        console.warn('[Upstox Notifier] rejected token: Upstox did not accept it');
        throw new ApiError(401, 'Notifier token was rejected by Upstox.');
      }
      console.warn('[Upstox Notifier] could not verify token (Upstox unreachable), storing it anyway');
    }

    const tokenUserId = profileUserId ?? (body.user_id as string | undefined) ?? null;
    if (env.upstoxUserId && tokenUserId && tokenUserId !== env.upstoxUserId) {
      console.warn('[Upstox Notifier] rejected token for a different Upstox user');
      throw new ApiError(403, 'Notifier token belongs to a different Upstox user.');
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
    data: { ...status, renewal: tokenRenewalService.getStatus() },
  });
};

/** Send the "approve access token" prompt to the Upstox app / WhatsApp now (no OTP login). */
export const requestUpstoxTokenApproval = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const renewal = await tokenRenewalService.requestNow('dashboard');
    res.json({
      success: true,
      message: 'Approval request sent. Tap Approve in the Upstox app or WhatsApp to connect.',
      data: renewal,
    });
  } catch (error) {
    next(error);
  }
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
