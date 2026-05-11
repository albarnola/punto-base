-- ============================================================
-- Stage 5A: Transactions table + RLS + trigger
-- ============================================================
-- Run order: this file is the source-of-truth SQL that was applied
-- to Supabase on 2026-05-10 to establish the writes-target data model
-- for Stage 5. The trigger maintains monthly_entries.actual as the
-- SUM of all transactions on that entry.
--
-- IMPORTANT: This SQL was applied directly via the Supabase SQL editor.
-- This file documents what was run; running it against a fresh database
-- would recreate the same state.

-- ------------------------------------------------------------
-- Table
-- ------------------------------------------------------------
CREATE TABLE public.transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monthly_entry_id uuid NOT NULL REFERENCES public.monthly_entries(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount           numeric(12,2) NOT NULL,
  description      text,
  transaction_date date,
  transaction_type text NOT NULL DEFAULT 'manual'
    CHECK (transaction_type IN ('manual', 'salary_seed')),
  source_id        uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_transactions_monthly_entry_id
  ON public.transactions(monthly_entry_id);

CREATE INDEX idx_transactions_user_id
  ON public.transactions(user_id);

CREATE INDEX idx_transactions_user_entry
  ON public.transactions(user_id, monthly_entry_id);

-- ------------------------------------------------------------
-- Row Level Security
-- ------------------------------------------------------------
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "transactions_select_own"
  ON public.transactions
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "transactions_insert_own"
  ON public.transactions
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "transactions_update_own"
  ON public.transactions
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "transactions_delete_own"
  ON public.transactions
  FOR DELETE
  USING (auth.uid() = user_id);

-- ------------------------------------------------------------
-- Trigger: maintain monthly_entries.actual = SUM(transactions.amount)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recompute_monthly_entry_actual(p_monthly_entry_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.monthly_entries
  SET actual = COALESCE(
    (SELECT SUM(amount) FROM public.transactions WHERE monthly_entry_id = p_monthly_entry_id),
    0
  )
  WHERE id = p_monthly_entry_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.transactions_recompute_actual()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    PERFORM public.recompute_monthly_entry_actual(NEW.monthly_entry_id);
    RETURN NEW;
  END IF;

  IF (TG_OP = 'DELETE') THEN
    PERFORM public.recompute_monthly_entry_actual(OLD.monthly_entry_id);
    RETURN OLD;
  END IF;

  IF (TG_OP = 'UPDATE') THEN
    PERFORM public.recompute_monthly_entry_actual(NEW.monthly_entry_id);
    IF (OLD.monthly_entry_id IS DISTINCT FROM NEW.monthly_entry_id) THEN
      PERFORM public.recompute_monthly_entry_actual(OLD.monthly_entry_id);
    END IF;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_transactions_recompute_actual ON public.transactions;

CREATE TRIGGER trg_transactions_recompute_actual
  AFTER INSERT OR UPDATE OR DELETE ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.transactions_recompute_actual();
