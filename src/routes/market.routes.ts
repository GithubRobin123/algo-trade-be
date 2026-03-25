import { Router } from 'express';
import {
  getNiftyHistory,
  getNiftyLivePrice,
  getOptionChain,
} from '../controllers/market.controller';

const router = Router();

router.get('/nifty/live', getNiftyLivePrice);
router.get('/nifty/history', getNiftyHistory);
router.get('/nifty/option-chain', getOptionChain);

export default router;
