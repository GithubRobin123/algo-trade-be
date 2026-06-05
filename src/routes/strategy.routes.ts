import { Router } from 'express';
import {
  closeStrategyPosition,
  emergencyExitAll,
  evaluateStrategyNow,
  getDecisionSummaryToday,
  getPositionEvents,
  getPositionPnlTicks,
  getStrategyRegistry,
  getStrategyStatus,
  getTradeEvents,
  listStrategyIntents,
  listStrategyPositions,
  setStrategyEnabled,
  setStrategyInRegistry,
} from '../controllers/strategy.controller';

const router = Router();

// Core strategy control
router.get('/status', getStrategyStatus);
router.post('/enabled', setStrategyEnabled);
router.post('/evaluate', evaluateStrategyNow);

// ── EMERGENCY PANIC BUTTON ─────────────────────────────────────────────────
// POST /api/strategy/emergency-exit
// Closes ALL open positions immediately. No approval. No gates. Stops strategy.
router.post('/emergency-exit', emergencyExitAll);

// Positions
router.get('/positions', listStrategyPositions);
router.post('/positions/:id/close', closeStrategyPosition);
router.get('/positions/:positionId/events', getPositionEvents);
router.get('/positions/:positionId/pnl-ticks', getPositionPnlTicks);

// Intents
router.get('/intents', listStrategyIntents);

// Strategy registry (enable/disable individual strategies)
router.get('/registry', getStrategyRegistry);
router.post('/registry/toggle', setStrategyInRegistry);

// Trade event feed (full audit trail)
router.get('/events', getTradeEvents);

// Decision log summary
router.get('/decisions/today', getDecisionSummaryToday);

export default router;
