-- Enable PostgreSQL trigram extension for fuzzy text search
-- This must be run before applying schema with trigram indexes
CREATE EXTENSION IF NOT EXISTS pg_trgm;
