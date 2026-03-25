import { Router } from 'express';
import {
  disconnectUpstox,
  exchangeUpstoxCode,
  getAuthDebug,
  getAuthStatus,
  handleUpstoxCallback,
  handleUpstoxNotifierCallback,
  redirectToUpstoxLogin,
} from '../controllers/auth.controller';

const router = Router();

router.get('/upstox/login', redirectToUpstoxLogin);
router.get('/upstox/callback', handleUpstoxCallback);
router.post('/upstox/callback', handleUpstoxNotifierCallback);
router.post('/upstox/exchange', exchangeUpstoxCode);
router.get('/upstox/status', getAuthStatus);
router.get('/upstox/debug', getAuthDebug);
router.delete('/upstox/disconnect', disconnectUpstox);

export default router;
