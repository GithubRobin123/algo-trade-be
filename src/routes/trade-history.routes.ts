import { Router } from 'express';
import { getDecisionLog, getTradeHistory, getTradeSummary } from '../controllers/trade-history.controller';

const router = Router();

router.get('/history', getTradeHistory);
router.get('/decisions', getDecisionLog);
router.get('/summary', getTradeSummary);

export default router;
