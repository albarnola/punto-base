-- ============================================================
-- Stage 6: Investing — accounts + monthly balance snapshots
-- ============================================================
-- Run this in the Supabase SQL editor (same as stage5a).
-- Two tables:
--   investment_accounts  — one row per account (401k, Roth, brokerage…)
--   investment_snapshots — one balance per account per month ('YYYY-MM',
--                          same month format as monthly_entries)
-- Balances carry forward in the app: the balance shown for a month is the
-- most recent snapshot at or before it, so you only log when things change.

-- ------------------------------------------------------------
-- Tables
-- ------------------------------------------------------------
CREATE TABLE public.investment_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  account_type text NOT NULL DEFAULT 'brokerage'
    CHECK (account_type IN ('401k', 'roth_ira', 'ira', 'brokerage', 'hsa', 'crypto', 'cash', 'other')),
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE INDEX idx_investment_accounts_user_id
  ON public.investment_accounts(user_id);

CREATE TABLE public.investment_snapshots (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.investment_accounts(id) ON DELETE CASCADE,
  month      text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  balance    numeric(14,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, month)
);

CREATE INDEX idx_investment_snapshots_user_id
  ON public.investment_snapshots(user_id);

CREATE INDEX idx_investment_snapshots_account_month
  ON public.investment_snapshots(account_id, month);

-- ------------------------------------------------------------
-- Row Level Security
-- ------------------------------------------------------------
ALTER TABLE public.investment_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "investment_accounts_select_own"
  ON public.investment_accounts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "investment_accounts_insert_own"
  ON public.investment_accounts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "investment_accounts_update_own"
  ON public.investment_accounts FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "investment_accounts_delete_own"
  ON public.investment_accounts FOR DELETE
  USING (auth.uid() = user_id);

ALTER TABLE public.investment_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "investment_snapshots_select_own"
  ON public.investment_snapshots FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "investment_snapshots_insert_own"
  ON public.investment_snapshots FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "investment_snapshots_update_own"
  ON public.investment_snapshots FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "investment_snapshots_delete_own"
  ON public.investment_snapshots FOR DELETE
  USING (auth.uid() = user_id);
