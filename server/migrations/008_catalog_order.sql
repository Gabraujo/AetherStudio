ALTER TABLE products
  ADD COLUMN catalog_position INTEGER;

WITH ordered_products AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY created_at DESC, name ASC, id ASC)::INTEGER AS position
  FROM products
)
UPDATE products AS product
SET catalog_position = ordered_products.position
FROM ordered_products
WHERE product.id = ordered_products.id;

ALTER TABLE products
  ALTER COLUMN catalog_position SET NOT NULL,
  ADD CONSTRAINT products_catalog_position_unique
    UNIQUE (catalog_position) DEFERRABLE INITIALLY DEFERRED;
