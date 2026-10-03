ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS fulfillment_status TEXT NOT NULL DEFAULT 'not_paid',
  ADD COLUMN IF NOT EXISTS tracking_code TEXT;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_fulfillment_status_check,
  ADD CONSTRAINT orders_fulfillment_status_check CHECK (fulfillment_status IN (
    'not_paid', 'processing', 'shipped', 'delivered'
  ));

UPDATE orders
SET fulfillment_status = 'processing'
WHERE payment_status = 'approved'
  AND status IN ('paid', 'paid_after_expiry')
  AND fulfillment_status = 'not_paid';

CREATE TABLE IF NOT EXISTS email_outbox (
  id UUID PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  recipient TEXT NOT NULL,
  template TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_ready
  ON email_outbox(status, available_at, created_at)
  WHERE status IN ('pending', 'sending');

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
  ON password_reset_tokens(user_id, expires_at);
