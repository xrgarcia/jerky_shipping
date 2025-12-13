-- Enable pg_trgm extension for GIN text indexes (trigram search)
-- This must run BEFORE any tables with GIN indexes are created
CREATE EXTENSION IF NOT EXISTS pg_trgm;
