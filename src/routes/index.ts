import { Router } from 'express';
import accountRoutes from './account.routes';
import authRoutes from './auth.routes';
import dashboardRoutes from './dashboard.routes';
import healthRoutes from './health.routes';
import intentRoutes from './intent.routes';
import instrumentRoutes from './instrument.routes';
import marketRoutes from './market.routes';
import orderRoutes from './order.routes';
import reportRoutes from './report.routes';
import stockRoutes from './stock.routes';
import strategyRoutes from './strategy.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/market', marketRoutes);
router.use('/orders', orderRoutes);
router.use('/intents', intentRoutes);
router.use('/instruments', instrumentRoutes);
router.use('/strategy', strategyRoutes);
router.use('/account', accountRoutes);
router.use('/stocks', stockRoutes);
router.use('/reports', reportRoutes);
router.use('/dashboard', dashboardRoutes);

export default router;
