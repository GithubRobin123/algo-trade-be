import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../middleware/error.middleware';
import { strategyRegistry } from '../services/strategy-registry.service';
import { strategyService } from '../services/strategy.service';
import { tradeEventService } from '../services/trade-event.service';
import { tradeIntentService } from '../services/trade-intent.service';
import { serializeIntent, serializePosition } from './serializers';

const parseLimit = (value: unknown, fallback: number): number => {
  if (typeof value !== 'string') return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
};

export const getStrategyStatus = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json({ success: true, data: await strategyService.getStatus() });
  } catch (error) { next(error); }
};

export const setStrategyEnabled = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') throw new ApiError(400, 'enabled must be boolean.');
    strategyService.setEnabled(enabled);
    res.json({ success: true, data: await strategyService.getStatus() });
  } catch (error) { next(error); }
};

export const evaluateStrategyNow = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const createIntent = req.body?.createIntent !== false;
    res.json({ success: true, data: await strategyService.evaluateAndQueueSignal(createIntent) });
  } catch (error) { next(error); }
};

export const listStrategyIntents = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = parseLimit(req.query.limit, 50);
    const intents = await tradeIntentService.listIntents({ limit, source: 'STRATEGY' });
    res.json({ success: true, data: intents.map(serializeIntent) });
  } catch (error) { next(error); }
};

export const listStrategyPositions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = parseLimit(req.query.limit, 100);
    const positions = await strategyService.listPositions(limit);
    res.json({ success: true, data: positions.map(serializePosition) });
  } catch (error) { next(error); }
};

export const closeStrategyPosition = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw new ApiError(400, 'Invalid position id.');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'Manual close from UI';
    const position = await strategyService.closePosition(id, reason);
    res.json({ success: true, data: serializePosition(position) });
  } catch (error) { next(error); }
};

// ── Registry management ────────────────────────────────────────────────────
export const getStrategyRegistry = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json({ success: true, data: { enabledStrategies: strategyRegistry.getEnabled() } });
  } catch (error) { next(error); }
};

export const setStrategyInRegistry = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, enabled } = req.body ?? {};
    if (typeof name !== 'string' || typeof enabled !== 'boolean') throw new ApiError(400, 'name (string) and enabled (boolean) required.');
    const ok = strategyRegistry.setEnabled(name, enabled);
    if (!ok) throw new ApiError(404, `Strategy ${name} not found in registry.`);
    res.json({ success: true, data: { enabledStrategies: strategyRegistry.getEnabled() } });
  } catch (error) { next(error); }
};

// ── Trade event feed ───────────────────────────────────────────────────────
export const getTradeEvents = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const underlying = typeof req.query.underlying === 'string' ? req.query.underlying : undefined;
    const limit = parseLimit(req.query.limit, 100);
    const events = await tradeEventService.getRecentEvents(underlying, limit);
    res.json({ success: true, data: events });
  } catch (error) { next(error); }
};

export const getPositionEvents = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const positionId = Number(req.params.positionId);
    if (Number.isNaN(positionId)) throw new ApiError(400, 'Invalid positionId.');
    const events = await tradeEventService.getPositionEvents(positionId);
    res.json({ success: true, data: events });
  } catch (error) { next(error); }
};

// ── Decision log ───────────────────────────────────────────────────────────
export const getDecisionSummaryToday = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json({ success: true, data: await strategyService.getDecisionLogSummaryToday() });
  } catch (error) { next(error); }
};
