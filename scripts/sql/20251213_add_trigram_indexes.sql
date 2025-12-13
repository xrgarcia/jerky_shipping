-- Script: Add GIN trigram indexes for fast ILIKE search
-- Description: Creates GIN indexes with gin_trgm_ops for fuzzy text search on key columns
-- Prerequisite: 20251213_enable_pg_trgm.sql must be run first
-- Safe to re-run: Yes (IF NOT EXISTS)
--
-- These indexes dramatically speed up ILIKE '%search%' queries on:
-- - Order numbers, customer names, customer emails
-- - SKUs, product titles
-- - Tracking numbers

-- Orders table indexes
CREATE INDEX IF NOT EXISTS orders_order_number_trgm_idx 
  ON orders USING gin (order_number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS orders_customer_name_trgm_idx 
  ON orders USING gin (customer_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS orders_customer_email_trgm_idx 
  ON orders USING gin (customer_email gin_trgm_ops);

-- Order items table indexes
CREATE INDEX IF NOT EXISTS order_items_sku_trgm_idx 
  ON order_items USING gin (sku gin_trgm_ops);

CREATE INDEX IF NOT EXISTS order_items_title_trgm_idx 
  ON order_items USING gin (title gin_trgm_ops);

-- Shipments table index
CREATE INDEX IF NOT EXISTS shipments_tracking_number_trgm_idx 
  ON shipments USING gin (tracking_number gin_trgm_ops);

-- Verify indexes were created
SELECT indexname, tablename 
FROM pg_indexes 
WHERE indexname LIKE '%trgm%' 
ORDER BY tablename, indexname;
