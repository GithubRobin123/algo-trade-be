import { Router } from 'express';
import { buildInfo } from '../config/build-info';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
    build: buildInfo,
  });
});

export default router;
