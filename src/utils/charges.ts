import { env } from '../config/env';

// NSE option rates (Oct 2024 onwards). Brokerage and STT come from env because they change with
// the broker plan and the budget; these change rarely.
const EXCHANGE_TXN_RATE = 0.0003503; // NSE transaction charge, % of premium turnover (both legs)
const SEBI_FEE_RATE = 0.000001;      // ₹10 per crore of turnover
const GST_RATE = 0.18;               // on brokerage + exchange + SEBI fees
const STAMP_DUTY_BUY_RATE = 0.00003; // 0.003% of the buy-side premium

export interface OptionCharges {
  brokerage: number;
  stt: number;
  exchange: number;
  sebi: number;
  gst: number;
  stampDuty: number;
  total: number;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Estimated charges for one round trip in an option (one buy order + one sell order).
 * Paper P&L is (exit − entry) × qty; real money also pays these, ~₹65–80 per NIFTY lot.
 */
export function estimateOptionCharges(buyPrice: number, sellPrice: number, quantity: number): OptionCharges {
  const buyValue = Math.max(0, buyPrice) * quantity;
  const sellValue = Math.max(0, sellPrice) * quantity;
  const turnover = buyValue + sellValue;
  const brokerage = env.chargesBrokeragePerOrder * 2;
  const stt = (env.chargesSttSellPct / 100) * sellValue;
  const exchange = EXCHANGE_TXN_RATE * turnover;
  const sebi = SEBI_FEE_RATE * turnover;
  const gst = GST_RATE * (brokerage + exchange + sebi);
  const stampDuty = STAMP_DUTY_BUY_RATE * buyValue;
  return {
    brokerage: round2(brokerage),
    stt: round2(stt),
    exchange: round2(exchange),
    sebi: round2(sebi),
    gst: round2(gst),
    stampDuty: round2(stampDuty),
    total: round2(brokerage + stt + exchange + sebi + gst + stampDuty),
  };
}

/** Charges for a closed position given its side, entry and exit price (null when not closed). */
export function positionCharges(side: 'BUY' | 'SELL', entryPrice: number, exitPrice: number | null, quantity: number): number | null {
  if (exitPrice === null || !(quantity > 0)) return null;
  const [buy, sell] = side === 'BUY' ? [entryPrice, exitPrice] : [exitPrice, entryPrice];
  return estimateOptionCharges(buy, sell, quantity).total;
}
