import { Router } from 'express';
import {
  getDashboardSnapshot,
  getDecisionLogs,
  getDailyPnlBreakdown,
  getPositionPnlChart,
} from '../controllers/dashboard.controller';

const router = Router();

// GET /api/dashboard/snapshot  — full dashboard data in one call
router.get('/snapshot', getDashboardSnapshot);

// GET /api/dashboard/decisions?limit=100&decision=REJECTED&underlying=NIFTY&daysBack=7
router.get('/decisions', getDecisionLogs);

// GET /api/dashboard/positions/:positionId/pnl-chart?limit=300
router.get('/positions/:positionId/pnl-chart', getPositionPnlChart);

// GET /api/dashboard/daily-pnl?daysBack=30
router.get('/daily-pnl', getDailyPnlBreakdown);

export default router;
