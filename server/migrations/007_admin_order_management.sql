ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_status_check,
  ADD CONSTRAINT orders_status_check CHECK (status IN (
    'pending_payment', 'paid', 'paid_after_expiry', 'expired', 'checkout_error', 'cancelled'
  ));
