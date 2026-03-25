import { Router } from 'express';
import { checkOrderFeasibility, getAccountSummary } from '../controllers/account.controller';

const router = Router();

router.get('/summary', getAccountSummary);
router.post('/check-order', checkOrderFeasibility);

export default router;
