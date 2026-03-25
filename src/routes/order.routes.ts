import { Router } from 'express';
import { buyOrder, listOrders, sellOrder } from '../controllers/order.controller';

const router = Router();

router.get('/', listOrders);
router.post('/buy', buyOrder);
router.post('/sell', sellOrder);

export default router;
