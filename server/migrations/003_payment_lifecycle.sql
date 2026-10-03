ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS refunded_cents INTEGER NOT NULL DEFAULT 0;

UPDATE orders
SET payment_status = 'approved'
WHERE payment_id IS NOT NULL
  AND status IN ('paid', 'paid_after_expiry')
  AND payment_status = 'pending';

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_payment_status_check,
  ADD CONSTRAINT orders_payment_status_check CHECK (payment_status IN (
    'pending', 'approved', 'authorized', 'in_process', 'in_mediation',
    'rejected', 'cancelled', 'refunded', 'partially_refunded',
    'charged_back', 'unknown'
  )),
  DROP CONSTRAINT IF EXISTS orders_refunded_cents_check,
  ADD CONSTRAINT orders_refunded_cents_check CHECK (refunded_cents BETWEEN 0 AND total_cents);
