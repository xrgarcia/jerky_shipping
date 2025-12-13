-- Script: Enable pg_trgm extension
-- Description: Enables PostgreSQL trigram extension for fuzzy text search
-- Prerequisite: None
-- Safe to re-run: Yes (IF NOT EXISTS)
--
-- IMPORTANT: Run this BEFORE 20251213_add_trigram_indexes.sql

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Verify extension is enabled
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_trgm';
