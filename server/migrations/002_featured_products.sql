ALTER TABLE products
  ADD COLUMN IF NOT EXISTS featured_position SMALLINT
  CHECK (featured_position BETWEEN 1 AND 4);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_featured_position
  ON products(featured_position)
  WHERE featured_position IS NOT NULL;
