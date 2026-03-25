import { ApiError } from '../middleware/error.middleware';
import { tokenService } from './token.service';
import { upstoxService } from './upstox.service';

interface OrderCheckInput {
  instrumentKey: string;
  quantity: number;
  price?: number;
  orderType?: string;
  product?: string;
}

export interface AccountSummary {
  connected: boolean;
  profile: {
    userId: string | null;
    email: string | null;
    userName: string | null;
    broker: string | null;
  } | null;
  wallet: {
    equity: {
      availableMargin: number | null;
      usedMargin: number | null;
      payin: number | null;
      span: number | null;
      exposure: number | null;
      adhoc: number | null;
      notionalCash: number | null;
    };
    commodity: {
      availableMargin: number | null;
      usedMargin: number | null;
      payin: number | null;
      span: number | null;
      exposure: number | null;
      adhoc: number | null;
      notionalCash: number | null;
    };
  } | null;
  holdings: {
    instrumentKey: string;
    tradingSymbol: string;
    exchange: string | null;
    quantity: number;
    averagePrice: number | null;
    lastPrice: number | null;
    pnl: number | null;
    product: string | null;
  }[];
  positions: {
    instrumentKey: string;
    tradingSymbol: string;
    exchange: string | null;
    quantity: number;
    averagePrice: number | null;
    lastPrice: number | null;
    pnl: number | null;
    product: string | null;
  }[];
  mtfPositions: {
    instrumentKey: string;
    tradingSymbol: string;
    exchange: string | null;
    quantity: number;
    averagePrice: number | null;
    lastPrice: number | null;
    pnl: number | null;
    product: string | null;
  }[];
  refreshedAt: string;
}

export interface OrderCheckResult {
  allowed: boolean;
  side: 'BUY' | 'SELL';
  estimatedPrice: number;
  estimatedOrderValue: number;
  availableToTrade: number | null;
  reason: string | null;
  warnings: string[];
}

class AccountService {
  async getAccountSummary(): Promise<AccountSummary> {
    const status = await tokenService.getConnectionStatus();

    if (!status.connected) {
      throw new ApiError(401, 'Upstox account is not connected. Complete OAuth first.');
    }

    const accessToken = await tokenService.getValidAccessToken();

    const [profile, equityWallet, commodityWallet, holdings, positions, mtfPositions] = await Promise.all([
      upstoxService.getUserProfile(accessToken),
      upstoxService.getFundsAndMargin(accessToken, 'SEC'),
      upstoxService.getFundsAndMargin(accessToken, 'COM').catch(() => ({
        availableMargin: null,
        usedMargin: null,
        payin: null,
        span: null,
        exposure: null,
        adhoc: null,
        notionalCash: null,
      })),
      upstoxService.getHoldings(accessToken),
      upstoxService.getPositions(accessToken),
      upstoxService.getMtfPositions(accessToken),
    ]);

    return {
      connected: true,
      profile,
      wallet: {
        equity: equityWallet,
        commodity: commodityWallet,
      },
      holdings,
      positions,
      mtfPositions,
      refreshedAt: new Date().toISOString(),
    };
  }

  async checkOrder(
    side: 'BUY' | 'SELL',
    input: OrderCheckInput,
  ): Promise<OrderCheckResult> {
    const status = await tokenService.getConnectionStatus();

    if (!status.connected) {
      return {
        allowed: true,
        side,
        estimatedPrice: input.price ?? 0,
        estimatedOrderValue: (input.price ?? 0) * input.quantity,
        availableToTrade: null,
        reason: null,
        warnings: ['Account not connected. Wallet validation skipped.'],
      };
    }

    const accessToken = await tokenService.getValidAccessToken();

    const [equityWallet, holdings, quote] = await Promise.all([
      upstoxService.getFundsAndMargin(accessToken, 'SEC'),
      upstoxService.getHoldings(accessToken),
      input.price === undefined
        ? upstoxService.getNiftyLtp(accessToken, input.instrumentKey)
        : Promise.resolve(null),
    ]);

    const estimatedPrice = input.price ?? quote?.ltp ?? 0;
    const estimatedOrderValue = estimatedPrice * input.quantity;
    const availableToTrade = equityWallet.availableMargin;
    const warnings: string[] = [];

    if (estimatedPrice <= 0) {
      warnings.push('Could not determine order price from quote.');
    }

    if (side === 'BUY') {
      if (availableToTrade !== null && estimatedOrderValue > availableToTrade) {
        return {
          allowed: false,
          side,
          estimatedPrice,
          estimatedOrderValue,
          availableToTrade,
          reason: `Insufficient wallet balance. Required ${estimatedOrderValue.toFixed(2)}, available ${availableToTrade.toFixed(2)}.`,
          warnings,
        };
      }

      return {
        allowed: true,
        side,
        estimatedPrice,
        estimatedOrderValue,
        availableToTrade,
        reason: null,
        warnings,
      };
    }

    if ((input.product ?? 'I').toUpperCase() === 'D') {
      const holding = holdings.find((item) => item.instrumentKey === input.instrumentKey);
      const heldQuantity = holding?.quantity ?? 0;

      if (heldQuantity < input.quantity) {
        return {
          allowed: false,
          side,
          estimatedPrice,
          estimatedOrderValue,
          availableToTrade,
          reason: `Insufficient demat holdings for delivery sell. Required quantity ${input.quantity}, available ${heldQuantity}.`,
          warnings,
        };
      }
    }

    return {
      allowed: true,
      side,
      estimatedPrice,
      estimatedOrderValue,
      availableToTrade,
      reason: null,
      warnings,
    };
  }
}

export const accountService = new AccountService();
