import { Router } from 'express';
import {
  getInstrumentLtp,
  getMarketOverview,
  getNiftyHistory,
  getNiftyLivePrice,
  getOptionChain,
  getStreamStatus,
} from '../controllers/market.controller';

const router = Router();

router.get('/overview', getMarketOverview);
router.get('/nifty/live', getNiftyLivePrice);
router.get('/nifty/history', getNiftyHistory);
router.get('/nifty/option-chain', getOptionChain);
router.get('/instrument/ltp', getInstrumentLtp);
router.get('/stream', getStreamStatus);

export default router;
