-- Stage 8: Debt Paydown — allow 'debt' as a budget_categories section.
-- Run this in the Supabase SQL editor.
--
-- Drops whatever CHECK constraint currently guards `section` (name-agnostic,
-- in case it wasn't created with the default name) and re-adds it with
-- 'debt' included.

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.budget_categories'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%section%'
  LOOP
    EXECUTE format('ALTER TABLE public.budget_categories DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.budget_categories
  ADD CONSTRAINT budget_categories_section_check
  CHECK (section IN (
    'income', 'fixed', 'variable', 'recreational',
    'savings', 'pretax_investments', 'debt'
  ));
