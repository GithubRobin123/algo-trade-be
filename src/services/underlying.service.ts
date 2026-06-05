import { env } from '../config/env';
import { ApiError } from '../middleware/error.middleware';
import { UnderlyingInstrument } from '../types/trading.types';

// NSE/BSE F&O lot sizes — updated April 2024
const defaultUnderlyings: UnderlyingInstrument[] = [
  {
    symbol: 'NIFTY',
    displayName: 'NIFTY 50',
    instrumentKey: 'NSE_INDEX|Nifty 50',
    optionChainInstrumentKey: 'NSE_INDEX|Nifty 50',
    defaultLotSize: 25,   // 1 lot = 25 units (revised Apr 2024)
    assetClass: 'INDEX',
    supportsOptions: true,
    intradayAllowed: true,
  },
  {
    symbol: 'BANKNIFTY',
    displayName: 'NIFTY BANK',
    instrumentKey: 'NSE_INDEX|Nifty Bank',
    optionChainInstrumentKey: 'NSE_INDEX|Nifty Bank',
    defaultLotSize: 15,   // 1 lot = 15 units
    assetClass: 'INDEX',
    supportsOptions: true,
    intradayAllowed: true,
  },
  {
    symbol: 'SENSEX',
    displayName: 'BSE SENSEX',
    instrumentKey: 'BSE_INDEX|SENSEX',
    optionChainInstrumentKey: 'BSE_INDEX|SENSEX',
    defaultLotSize: 10,   // 1 lot = 10 units
    assetClass: 'INDEX',
    supportsOptions: true,
    intradayAllowed: true,
  },
  {
    symbol: 'FINNIFTY',
    displayName: 'FIN NIFTY',
    instrumentKey: 'NSE_INDEX|Nifty Fin Service',
    optionChainInstrumentKey: 'NSE_INDEX|Nifty Fin Service',
    defaultLotSize: 25,   // 1 lot = 25 units (revised 2024)
    assetClass: 'INDEX',
    supportsOptions: true,
    intradayAllowed: true,
  },
  {
    symbol: 'MIDCPNIFTY',
    displayName: 'MIDCAP NIFTY',
    instrumentKey: 'NSE_INDEX|NIFTY MID SELECT',
    optionChainInstrumentKey: 'NSE_INDEX|NIFTY MID SELECT',
    defaultLotSize: 50,   // 1 lot = 50 units
    assetClass: 'INDEX',
    supportsOptions: true,
    intradayAllowed: true,
  },
  {
    symbol: 'NIFTYNXT50',
    displayName: 'NIFTY NEXT 50',
    instrumentKey: 'NSE_INDEX|Nifty Next 50',
    optionChainInstrumentKey: 'NSE_INDEX|Nifty Next 50',
    defaultLotSize: 25,
    assetClass: 'INDEX',
    supportsOptions: false,   // limited options liquidity
    intradayAllowed: true,
  },
  {
    symbol: 'NIFTYIT',
    displayName: 'NIFTY IT',
    instrumentKey: 'NSE_INDEX|Nifty IT',
    optionChainInstrumentKey: 'NSE_INDEX|Nifty IT',
    defaultLotSize: 25,
    assetClass: 'INDEX',
    supportsOptions: false,
    intradayAllowed: true,
  },
  {
    symbol: 'BANKEX',
    displayName: 'BSE BANKEX',
    instrumentKey: 'BSE_INDEX|BANKEX',
    optionChainInstrumentKey: 'BSE_INDEX|BANKEX',
    defaultLotSize: 15,
    assetClass: 'INDEX',
    supportsOptions: true,
    intradayAllowed: true,
  },
  {
    symbol: 'CRUDEOIL',
    displayName: 'CRUDE OIL',
    instrumentKey: 'MCX_FO|CRUDEOIL',
    optionChainInstrumentKey: 'MCX_FO|CRUDEOIL',
    defaultLotSize: 100,
    assetClass: 'COMMODITY',
    supportsOptions: true,
    intradayAllowed: true,
  },
  {
    symbol: 'RELIANCE',
    displayName: 'RELIANCE',
    instrumentKey: 'NSE_EQ|INE002A01018',
    optionChainInstrumentKey: 'NSE_EQ|INE002A01018',
    defaultLotSize: 250,  // 1 lot = 250 shares (revised 2024)
    assetClass: 'STOCK',
    supportsOptions: true,
    intradayAllowed: true,
  },
];

const normalize = (instrument: UnderlyingInstrument): UnderlyingInstrument => ({
  ...instrument,
  symbol: instrument.symbol.toUpperCase().trim(),
  displayName: instrument.displayName.trim(),
  instrumentKey: instrument.instrumentKey.trim(),
  optionChainInstrumentKey: instrument.optionChainInstrumentKey.trim(),
});

class UnderlyingService {
  private readonly underlyings: UnderlyingInstrument[];
  private activeSymbol: string;

  constructor() {
    this.underlyings = this.loadUnderlyings();

    const requestedDefault = env.defaultUnderlyingSymbol.toUpperCase();
    this.activeSymbol = this.underlyings.some((item) => item.symbol === requestedDefault)
      ? requestedDefault
      : this.underlyings[0].symbol;
  }

  list(): UnderlyingInstrument[] {
    return [...this.underlyings];
  }

  getActive(): UnderlyingInstrument {
    const active = this.underlyings.find((item) => item.symbol === this.activeSymbol);

    if (!active) {
      throw new ApiError(500, 'No active underlying configured.');
    }

    return active;
  }

  setActive(symbol: string): UnderlyingInstrument {
    const normalized = symbol.toUpperCase().trim();
    const found = this.underlyings.find((item) => item.symbol === normalized);

    if (!found) {
      throw new ApiError(404, `Unsupported underlying symbol: ${symbol}`);
    }

    this.activeSymbol = found.symbol;
    return found;
  }

  resolve(symbolOrKey?: string): UnderlyingInstrument {
    if (!symbolOrKey) {
      return this.getActive();
    }

    const normalized = symbolOrKey.trim();
    const upper = normalized.toUpperCase();

    const found = this.underlyings.find(
      (item) =>
        item.symbol === upper ||
        item.instrumentKey === normalized ||
        item.optionChainInstrumentKey === normalized,
    );

    if (!found) {
      throw new ApiError(404, `Underlying not found for: ${symbolOrKey}`);
    }

    return found;
  }

  private loadUnderlyings(): UnderlyingInstrument[] {
    if (!env.supportedUnderlyingsJson) {
      return defaultUnderlyings.map(normalize);
    }

    try {
      const parsed = JSON.parse(env.supportedUnderlyingsJson) as UnderlyingInstrument[];

      if (!Array.isArray(parsed) || parsed.length === 0) {
        return defaultUnderlyings.map(normalize);
      }

      return parsed.map(normalize);
    } catch {
      process.stderr.write('[Underlying] Invalid SUPPORTED_UNDERLYINGS_JSON. Falling back to defaults.\n');
      return defaultUnderlyings.map(normalize);
    }
  }
}

export const underlyingService = new UnderlyingService();
