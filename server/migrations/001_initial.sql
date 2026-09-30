CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  compare_at_cents INTEGER CHECK (compare_at_cents IS NULL OR compare_at_cents >= price_cents),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  image_url TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment','paid','paid_after_expiry','expired','checkout_error')),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  shipping_address JSONB NOT NULL,
  payment_preference_id TEXT,
  payment_id TEXT,
  reservation_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_catalog ON products(active, category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_expiration ON orders(status, reservation_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_id ON orders(payment_id) WHERE payment_id IS NOT NULL;

INSERT INTO products (id, name, category, description, price_cents, compare_at_cents, stock, active)
VALUES
 ('11111111-1111-4111-8111-111111111111','Kaede, a Espadachim','Anime','Figure colecionável com acabamento de galeria.',140000,NULL,0,FALSE),
 ('22222222-2222-4222-8222-222222222222','Ryu Kuroba','Anime','Figure colecionável com desconto especial.',130000,150000,0,FALSE),
 ('33333333-3333-4333-8333-333333333333','Sentinela Vermelha','Games','Figure colecionável para sua estante.',150000,NULL,0,FALSE),
 ('44444444-4444-4444-8444-444444444444','Lady Vex','Games','Figure colecionável com preço promocional.',120000,140000,0,FALSE)
ON CONFLICT (id) DO NOTHING;
