ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_attempt_key UUID,
  ADD COLUMN IF NOT EXISTS payment_attempt_method TEXT;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_payment_attempt_method_check,
  ADD CONSTRAINT orders_payment_attempt_method_check
    CHECK (payment_attempt_method IS NULL OR payment_attempt_method IN ('pix', 'card'));
