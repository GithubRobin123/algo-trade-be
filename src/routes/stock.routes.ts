import { Router } from 'express';
import {
  addWatchlistItem,
  listWatchlist,
  removeWatchlistItem,
  searchStocks,
  syncStockCatalog,
  updateWatchlistItem,
} from '../controllers/stock.controller';

const router = Router();

router.get('/search', searchStocks);
router.post('/sync', syncStockCatalog);
router.get('/watchlist', listWatchlist);
router.post('/watchlist', addWatchlistItem);
router.patch('/watchlist/:id', updateWatchlistItem);
router.delete('/watchlist/:id', removeWatchlistItem);

export default router;
