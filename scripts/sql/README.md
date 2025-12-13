# Database SQL Scripts

This folder contains SQL scripts for database changes that cannot be safely managed by Drizzle ORM.

## Why This Exists

Drizzle's `db:push` doesn't correctly generate SQL for:
- GIN indexes with operator classes (e.g., `gin_trgm_ops`)
- PostgreSQL extensions (e.g., `pg_trgm`)
- Complex constraints

These scripts are applied **manually** after deployment to ensure correctness.

## How to Use

1. **Before deploying**: Test the script on the development database
2. **After deploying**: Run the script on the production database via the Database pane
3. **Mark as applied**: Add a comment with the date when applied

## Script Naming Convention

```
YYYYMMDD_description.sql
```

Example: `20251213_add_trigram_indexes.sql`

## Running Scripts

1. Open **Database** pane in Replit
2. Switch to **Production** (or Development for testing)
3. Click **Edit** to enable SQL execution
4. Copy/paste the script and run

## Applied Scripts Log

| Script | Dev Applied | Prod Applied |
|--------|-------------|--------------|
| 20251213_enable_pg_trgm.sql | Pending | Pending |
| 20251213_add_trigram_indexes.sql | Pending | Pending |
