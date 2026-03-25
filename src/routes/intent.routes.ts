import { Router } from 'express';
import {
  approveIntent,
  createIntent,
  listIntents,
  rejectIntent,
} from '../controllers/intent.controller';

const router = Router();

router.get('/', listIntents);
router.post('/', createIntent);
router.post('/:id/approve', approveIntent);
router.post('/:id/reject', rejectIntent);

export default router;
