import axios from 'axios';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import { Op, WhereOptions } from 'sequelize';
import { ApiError } from '../middleware/error.middleware';
import { StockInstrument } from '../models/stock-instrument.model';
import { tokenService } from './token.service';
import { upstoxService } from './upstox.service';

const gunzipAsync = promisify(gunzip);

const DEFAULT_BOD_URL =
  'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

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

interface CatalogRow {
  instrumentKey: string;
  symbol: string;
  tradingSymbol: string;
  displayName: string;
  exchange: string | null;
  segment: string | null;
  assetClass: string | null;
  instrumentType: string | null;
  expiryDate: string | null;
  strikePrice: number | null;
  optionType: string | null;
  lotSize: number | null;
  tickSize: number | null;
  isTradable: boolean;
  rawPayload: Record<string, unknown>;
}

const defaultCatalog: CatalogRow[] = [
  {
    instrumentKey: 'NSE_INDEX|Nifty 50',
    symbol: 'NIFTY',
    tradingSymbol: 'NIFTY 50',
    displayName: 'NIFTY 50',
    exchange: 'NSE',
    segment: 'INDEX',
    assetClass: 'INDEX',
    instrumentType: 'INDEX',
    expiryDate: null,
    strikePrice: null,
    optionType: null,
    lotSize: 50,
    tickSize: null,
    isTradable: true,
    rawPayload: {},
  },
  {
    instrumentKey: 'NSE_INDEX|Nifty Bank',
    symbol: 'BANKNIFTY',
    tradingSymbol: 'NIFTY BANK',
    displayName: 'NIFTY BANK',
    exchange: 'NSE',
    segment: 'INDEX',
    assetClass: 'INDEX',
    instrumentType: 'INDEX',
    expiryDate: null,
    strikePrice: null,
    optionType: null,
    lotSize: 15,
    tickSize: null,
    isTradable: true,
    rawPayload: {},
  },
  {
    instrumentKey: 'BSE_INDEX|SENSEX',
    symbol: 'SENSEX',
    tradingSymbol: 'SENSEX',
    displayName: 'SENSEX',
    exchange: 'BSE',
    segment: 'INDEX',
    assetClass: 'INDEX',
    instrumentType: 'INDEX',
    expiryDate: null,
    strikePrice: null,
    optionType: null,
    lotSize: 10,
    tickSize: null,
    isTradable: true,
    rawPayload: {},
  },
  {
    instrumentKey: 'NSE_EQ|INE002A01018',
    symbol: 'RELIANCE',
    tradingSymbol: 'RELIANCE',
    displayName: 'Reliance Industries Ltd',
    exchange: 'NSE',
    segment: 'EQ',
    assetClass: 'STOCK',
    instrumentType: 'EQ',
    expiryDate: null,
    strikePrice: null,
    optionType: null,
    lotSize: 1,
    tickSize: 0.05,
    isTradable: true,
    rawPayload: {},
  },
  {
    instrumentKey: 'NSE_EQ|INE009A01021',
    symbol: 'INFY',
    tradingSymbol: 'INFY',
    displayName: 'Infosys Ltd',
    exchange: 'NSE',
    segment: 'EQ',
    assetClass: 'STOCK',
    instrumentType: 'EQ',
    expiryDate: null,
    strikePrice: null,
    optionType: null,
    lotSize: 1,
    tickSize: 0.05,
    isTradable: true,
    rawPayload: {},
  },
  {
    instrumentKey: 'NSE_EQ|INE467B01029',
    symbol: 'TCS',
    tradingSymbol: 'TCS',
    displayName: 'Tata Consultancy Services Ltd',
    exchange: 'NSE',
    segment: 'EQ',
    assetClass: 'STOCK',
    instrumentType: 'EQ',
    expiryDate: null,
    strikePrice: null,
    optionType: null,
    lotSize: 1,
    tickSize: 0.05,
    isTradable: true,
    rawPayload: {},
  },
  {
    instrumentKey: 'NSE_EQ|INE040A01034',
    symbol: 'HDFCBANK',
    tradingSymbol: 'HDFCBANK',
    displayName: 'HDFC Bank Ltd',
    exchange: 'NSE',
    segment: 'EQ',
    assetClass: 'STOCK',
    instrumentType: 'EQ',
    expiryDate: null,
    strikePrice: null,
    optionType: null,
    lotSize: 1,
    tickSize: 0.05,
    isTradable: true,
    rawPayload: {},
  },
  {
    instrumentKey: 'NSE_EQ|INE090A01021',
    symbol: 'ICICIBANK',
    tradingSymbol: 'ICICIBANK',
    displayName: 'ICICI Bank Ltd',
    exchange: 'NSE',
    segment: 'EQ',
    assetClass: 'STOCK',
    instrumentType: 'EQ',
    expiryDate: null,
    strikePrice: null,
    optionType: null,
    lotSize: 1,
    tickSize: 0.05,
    isTradable: true,
    rawPayload: {},
  },
  {
    instrumentKey: 'NSE_EQ|INE062A01020',
    symbol: 'SBIN',
    tradingSymbol: 'SBIN',
    displayName: 'State Bank of India',
    exchange: 'NSE',
    segment: 'EQ',
    assetClass: 'STOCK',
    instrumentType: 'EQ',
    expiryDate: null,
    strikePrice: null,
    optionType: null,
    lotSize: 1,
    tickSize: 0.05,
    isTradable: true,
    rawPayload: {},
  },
  {
    instrumentKey: 'MCX_FO|CRUDEOIL',
    symbol: 'CRUDEOIL',
    tradingSymbol: 'CRUDEOIL',
    displayName: 'Crude Oil',
    exchange: 'MCX',
    segment: 'FO',
    assetClass: 'COMMODITY',
    instrumentType: 'FUTCOM',
    expiryDate: null,
    strikePrice: null,
    optionType: null,
    lotSize: 100,
    tickSize: 1,
    isTradable: true,
    rawPayload: {},
  },
];

export interface InstrumentSearchInput {
  q?: string;
  exchange?: string;
  segment?: string;
  assetClass?: string;
  limit?: number;
}

class StockCatalogService {
  private seededDefaults = false;

  async ensureSeeded(): Promise<void> {
    if (this.seededDefaults) {
      return;
    }

    const existing = await StockInstrument.count();
    if (existing === 0) {
      await this.upsertMany(defaultCatalog);
    }

    this.seededDefaults = true;
  }

  async search(input: InstrumentSearchInput): Promise<StockInstrument[]> {
    await this.ensureSeeded();

    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const where: WhereOptions = {};

    if (input.exchange) {
      where.exchange = input.exchange.toUpperCase();
    }

    if (input.segment) {
      where.segment = input.segment.toUpperCase();
    }

    if (input.assetClass) {
      where.assetClass = input.assetClass.toUpperCase();
    }

    if (input.q && input.q.trim()) {
      const query = `%${input.q.trim()}%`;
      (where as Record<string, unknown>)[Op.or as unknown as string] = [
        { symbol: { [Op.iLike]: query } },
        { tradingSymbol: { [Op.iLike]: query } },
        { displayName: { [Op.iLike]: query } },
        { instrumentKey: { [Op.iLike]: query } },
      ];
    }

    return StockInstrument.findAll({
      where,
      order: [
        ['symbol', 'ASC'],
        ['tradingSymbol', 'ASC'],
      ],
      limit,
    });
  }

  async syncFromUpstoxSearch(query: string): Promise<number> {
    if (!query.trim()) {
      return 0;
    }

    const status = await tokenService.getConnectionStatus();
    if (!status.connected) {
      return 0;
    }

    let accessToken: string;
    try {
      accessToken = await tokenService.getValidAccessToken();
    } catch {
      return 0;
    }

    const results = await upstoxService.searchInstruments(accessToken, query);

    if (!results.length) {
      return 0;
    }

    const mapped = results
      .map((item) => this.normalizeInstrument(item))
      .filter((item): item is CatalogRow => item !== null);

    if (!mapped.length) {
      return 0;
    }

    await this.upsertMany(mapped);
    return mapped.length;
  }

  async syncFromBod(url?: string, maxRecords = 10000): Promise<{ synced: number; sourceUrl: string }> {
    const sourceUrl = url || DEFAULT_BOD_URL;

    try {
      const response = await axios.get<ArrayBuffer>(sourceUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
      });

      let buffer: Buffer = Buffer.from(response.data as ArrayBuffer);
      const maybeGzip = sourceUrl.endsWith('.gz') || response.headers['content-encoding'] === 'gzip';

      if (maybeGzip) {
        buffer = (await gunzipAsync(buffer)) as Buffer;
      }

      const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
      const rawRecords = this.extractRecords(parsed);

      const limit = Math.min(Math.max(maxRecords, 1), 50000);
      const mapped = rawRecords
        .slice(0, limit)
        .map((item) => this.normalizeInstrument(item))
        .filter((item): item is CatalogRow => item !== null);

      if (!mapped.length) {
        throw new ApiError(502, 'BOD instrument file parsed but no valid instruments were found.');
      }

      await this.upsertMany(mapped);

      return {
        synced: mapped.length,
        sourceUrl,
      };
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      throw new ApiError(502, `Failed to sync instrument catalog from BOD file: ${(error as Error).message}`);
    }
  }

  async upsertMany(rows: CatalogRow[]): Promise<void> {
    if (!rows.length) {
      return;
    }

    await StockInstrument.bulkCreate(rows, {
      updateOnDuplicate: [
        'symbol',
        'tradingSymbol',
        'displayName',
        'exchange',
        'segment',
        'assetClass',
        'instrumentType',
        'expiryDate',
        'strikePrice',
        'optionType',
        'lotSize',
        'tickSize',
        'isTradable',
        'rawPayload',
      ],
    });
  }

  private extractRecords(parsed: unknown): Record<string, unknown>[] {
    if (Array.isArray(parsed)) {
      return parsed.map((item) => asRecord(item));
    }

    const root = asRecord(parsed);

    if (Array.isArray(root.data)) {
      return (root.data as unknown[]).map((item) => asRecord(item));
    }

    if (Array.isArray(root.records)) {
      return (root.records as unknown[]).map((item) => asRecord(item));
    }

    return [];
  }

  private normalizeInstrument(input: unknown): CatalogRow | null {
    const row = asRecord(input);

    const instrumentKey = toText(
      row.instrument_key ?? row.instrumentKey ?? row.instrument_token ?? row.instrumentToken,
    );

    if (!instrumentKey) {
      return null;
    }

    const symbol =
      toText(row.symbol ?? row.name)?.toUpperCase() ??
      toText(row.trading_symbol ?? row.tradingSymbol)?.toUpperCase() ??
      instrumentKey.toUpperCase();

    const tradingSymbol =
      toText(row.trading_symbol ?? row.tradingSymbol ?? row.symbol ?? row.name) ?? symbol;

    const displayName =
      toText(row.display_name ?? row.displayName ?? row.company_name ?? row.name) ??
      tradingSymbol;

    const exchange = toText(row.exchange)?.toUpperCase() ?? null;
    const segment = toText(row.segment)?.toUpperCase() ?? null;

    return {
      instrumentKey,
      symbol,
      tradingSymbol,
      displayName,
      exchange,
      segment,
      assetClass: toText(row.asset_class ?? row.assetClass)?.toUpperCase() ?? null,
      instrumentType: toText(row.instrument_type ?? row.instrumentType) ?? null,
      expiryDate: toText(row.expiry ?? row.expiry_date ?? row.expiryDate),
      strikePrice: toNumber(row.strike_price ?? row.strikePrice),
      optionType: toText(row.option_type ?? row.optionType),
      lotSize: toNumber(row.lot_size ?? row.lotSize),
      tickSize: toNumber(row.tick_size ?? row.tickSize),
      isTradable: (toText(row.is_tradable ?? row.isTradable)?.toLowerCase() ?? 'true') !== 'false',
      rawPayload: row,
    };
  }
}

export const stockCatalogService = new StockCatalogService();
