import { Router } from 'express';
import {
  getActiveUnderlying,
  listUnderlyings,
  setActiveUnderlying,
} from '../controllers/instrument.controller';

const router = Router();

router.get('/', listUnderlyings);
router.get('/active', getActiveUnderlying);
router.post('/active', setActiveUnderlying);

export default router;
