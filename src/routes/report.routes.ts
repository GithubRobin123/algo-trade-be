import { Router } from 'express';
import { getDailyReport, getReportSummary } from '../controllers/report.controller';

const router = Router();

router.get('/summary', getReportSummary);
router.get('/daily', getDailyReport);

export default router;
