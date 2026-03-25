import { env } from '../config/env';
import { ApiError } from '../middleware/error.middleware';
import { UnderlyingInstrument } from '../types/trading.types';

const defaultUnderlyings: UnderlyingInstrument[] = [
  {
    symbol: 'NIFTY',
    displayName: 'NIFTY 50',
    instrumentKey: 'NSE_INDEX|Nifty 50',
    optionChainInstrumentKey: 'NSE_INDEX|Nifty 50',
    defaultLotSize: 50,
    assetClass: 'INDEX',
    supportsOptions: true,
    intradayAllowed: true,
  },
  {
    symbol: 'BANKNIFTY',
    displayName: 'NIFTY BANK',
    instrumentKey: 'NSE_INDEX|Nifty Bank',
    optionChainInstrumentKey: 'NSE_INDEX|Nifty Bank',
    defaultLotSize: 15,
    assetClass: 'INDEX',
    supportsOptions: true,
    intradayAllowed: true,
  },
  {
    symbol: 'SENSEX',
    displayName: 'SENSEX',
    instrumentKey: 'BSE_INDEX|SENSEX',
    optionChainInstrumentKey: 'BSE_INDEX|SENSEX',
    defaultLotSize: 10,
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
    defaultLotSize: 1,
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
