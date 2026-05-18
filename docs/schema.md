=== START ===

# Punto Base — Database Schema (Proposed v1)

**Status:** Designed but NOT YET BUILT in Supabase.
**Branch:** Documentation lives on `feat/auth` branch.
**Decision date:** May 6, 2026.
**Build target:** Build during the 30-day Claude Max sprint. Schema validated through real personal use during the build.

---

## Why this document exists

Schema design is hard to redo once data exists. This document captures the decisions made during design so we have a single source of truth. If we ever need to drop and rebuild the database, this document is the canonical reference for what to rebuild.

---

## High-level decisions made

1. **Tables:** 6 — `budget_categories`, `monthly_entries`, `salary_records`, `salary_deductions`, `adjustments`, `user_preferences`
2. **Section field:** plain `text` with `CHECK` constraint (flexible for adding new sections later)
3. **Month field:** `text` in `'YYYY-MM'` format (matches existing localStorage format)
4. **Deletes:** soft delete (`deleted_at` column) on `budget_categories`, `salary_records`, `salary_deductions`, `adjustments`. Hard delete on `monthly_entries` (cascade with parent category). `user_preferences` just gets updated, never deleted.
5. **New user seeding:** Postgres trigger on signup auto-creates default categories (Salary, Roth IRA, Taxable Brokerage, Emergency Fund) and default `user_preferences` row.
6. **Currencies supported:** USD, EUR, MXN, VES (Venezuelan Bolívares — added for personal use, not as a market commitment)

---

## Schema design principles

- **Money as `numeric(12, 2)`** — never `float`/`real`. Prevents floating-point math errors.
- **Every user-data table has `user_id`** — required for Row Level Security. Without it, can't isolate users.
- **Every table has `created_at`** (and `updated_at` where mutable) — for debugging and audit trails.
- **No stored computed values** — `variance` is computed on read as `expected − actual`, never stored.
- **UNIQUE constraints where logically required** — e.g., one `monthly_entries` row per (user, category, month).
- **Foreign keys with explicit `ON DELETE` behavior** — cascade where appropriate.
- **`uuid` primary keys** — auto-generated, no collisions across devices, prevents enumeration attacks.

---

## Table definitions

### `budget_categories`

The "rows" the user sees in the Budget tab. User-defined except for seeded defaults.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | NO | `gen_random_uuid()` | Primary key |
| user_id | uuid | NO | — | FK → auth.users.id, ON DELETE CASCADE |
| name | text | NO | — | "Roth IRA Contribution," "Rent," etc. |
| section | text | NO | — | CHECK IN ('income', 'pretax_investments', 'savings', 'fixed', 'variable', 'recreational') |
| subtype | text | YES | NULL | CHECK IN ('investment', 'savings'). Only set for `section = 'savings'`. |
| sort_order | integer | NO | 0 | For row reordering within a section |
| is_linked | boolean | NO | false | True if auto-populated from Salary tab data |
| linked_deduction_id | uuid | YES | NULL | FK → salary_deductions.id when is_linked. NULL otherwise. |
| created_at | timestamptz | NO | NOW() | |
| deleted_at | timestamptz | YES | NULL | Soft delete marker |

Indexes: (user_id), (user_id, deleted_at), (linked_deduction_id)

---

### `monthly_entries`

The Expected/Actual numbers per category per month.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | NO | `gen_random_uuid()` | Primary key |
| user_id | uuid | NO | — | FK → auth.users.id, ON DELETE CASCADE |
| category_id | uuid | NO | — | FK → budget_categories.id, ON DELETE CASCADE |
| month | text | NO | — | Format 'YYYY-MM'. CHECK matches `^\d{4}-\d{2}$` |
| expected | numeric(12, 2) | NO | 0 | |
| actual | numeric(12, 2) | NO | 0 | |
| created_at | timestamptz | NO | NOW() | |
| updated_at | timestamptz | NO | NOW() | Trigger updates on row change |

Constraints: UNIQUE(user_id, category_id, month).
Indexes: (user_id, month).

---

### `salary_records`

The Salary tab's per-month data.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | NO | `gen_random_uuid()` | Primary key |
| user_id | uuid | NO | — | FK → auth.users.id, ON DELETE CASCADE |
| month | text | NO | — | Format 'YYYY-MM' |
| annual_gross | numeric(12, 2) | NO | 0 | Annual pre-tax salary |
| monthly_taxes | numeric(12, 2) | NO | 0 | Manually entered from pay stub |
| salary_source | text | NO | 'manual' | CHECK IN ('manual', 'inherited') |
| created_at | timestamptz | NO | NOW() | |
| updated_at | timestamptz | NO | NOW() | |
| deleted_at | timestamptz | YES | NULL | |

Constraints: UNIQUE(user_id, month) WHERE deleted_at IS NULL.
Indexes: (user_id, month).

---

### `salary_deductions`

Pre-tax deductions list under each salary record.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | NO | `gen_random_uuid()` | Primary key |
| salary_record_id | uuid | NO | — | FK → salary_records.id, ON DELETE CASCADE |
| user_id | uuid | NO | — | FK → auth.users.id (denormalized for RLS performance) |
| name | text | NO | — | "401k Contribution," "HSA," etc. |
| amount | numeric(12, 2) | NO | 0 | |
| deduction_type | text | NO | — | CHECK IN ('investment', 'expense') |
| sort_order | integer | NO | 0 | |
| created_at | timestamptz | NO | NOW() | |
| deleted_at | timestamptz | YES | NULL | |

Indexes: (salary_record_id), (user_id).

---

### `adjustments`

Per-month one-off adjustments to linked rows.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | uuid | NO | `gen_random_uuid()` | Primary key |
| user_id | uuid | NO | — | FK → auth.users.id, ON DELETE CASCADE |
| category_id | uuid | NO | — | FK → budget_categories.id, ON DELETE CASCADE |
| month | text | NO | — | Format 'YYYY-MM' |
| amount | numeric(12, 2) | NO | 0 | Can be positive or negative |
| note | text | YES | NULL | User-entered reason |
| created_at | timestamptz | NO | NOW() | |
| deleted_at | timestamptz | YES | NULL | |

Indexes: (user_id, category_id, month).

---

### `user_preferences`

One row per user. Created via signup trigger.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| user_id | uuid | NO | — | Primary key, FK → auth.users.id, ON DELETE CASCADE |
| currency | text | NO | 'USD' | CHECK IN ('USD', 'EUR', 'MXN', 'VES') |
| sidebar_collapsed | boolean | NO | false | |
| onboarding_complete | boolean | NO | false | |
| updated_at | timestamptz | NO | NOW() | |

---

## Row Level Security (RLS) policies

Every table has RLS enabled. Pattern: a user can only see/modify rows where their `auth.uid()` matches the row's `user_id`.

Policies needed per table: SELECT, INSERT, UPDATE, DELETE.

---

## Signup trigger

When a new user signs up, a Postgres trigger fires and seeds:
1. Default `user_preferences` row
2. Default 4 categories: Salary (income), Roth IRA Contribution (savings/investment), Taxable Brokerage (savings/investment), Emergency Fund (savings/savings)

---

## Migration path from localStorage (Stage 6)

When a user logs in for the first time on a device with localStorage budget data, the app uploads that data to Supabase and clears localStorage. This is Stage 6 work, documented here so it isn't forgotten.

---

## Open questions / things to revisit

As I use the app during the build, watch for:

- [ ] Has any section felt limiting? Should anything be split or merged?
- [ ] Are there fields I wish I had on `budget_categories` (color? icon? note?)?
- [ ] Do I actually use the `salary_source = 'inherited'` distinction enough to justify keeping it?
- [ ] Is `numeric(12, 2)` enough room for all currencies?
- [ ] Does soft-delete behavior actually feel right, or is hard delete fine?
- [ ] Is the seeded default category list still right?

---

## Decisions deliberately deferred

- Goals/savings targets — feature not in current app
- Transactions/individual purchases — different product scope
- Multi-currency per user — app supports one currency per user
- Sharing budget with spouse/partner — major feature
- Recurring entry templates — feature not yet validated

If any of these become "I really need this," add a column or table at build time, not now.

=== END ===