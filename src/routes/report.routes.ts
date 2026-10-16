import { Router } from 'express';
import { getDailyReport, getReportSummary, getStrategyPerformance } from '../controllers/report.controller';

const router = Router();

router.get('/summary', getReportSummary);
router.get('/daily', getDailyReport);
router.get('/strategy-performance', getStrategyPerformance);

export default router;
