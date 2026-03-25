import { Router } from 'express';
import {
  closeStrategyPosition,
  evaluateStrategyNow,
  getDecisionSummaryToday,
  getPositionEvents,
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

// Positions
router.get('/positions', listStrategyPositions);
router.post('/positions/:id/close', closeStrategyPosition);

// Intents
router.get('/intents', listStrategyIntents);

// Strategy registry (enable/disable individual strategies)
router.get('/registry', getStrategyRegistry);
router.post('/registry/toggle', setStrategyInRegistry);

// Trade event feed (full audit trail)
router.get('/events', getTradeEvents);
router.get('/positions/:positionId/events', getPositionEvents);

// Decision log summary
router.get('/decisions/today', getDecisionSummaryToday);

export default router;
