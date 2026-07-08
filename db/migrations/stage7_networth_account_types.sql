-- Stage 7: Net Worth — extend investment_accounts with cash & debt types.
-- Run this in the Supabase SQL editor.
--
-- Adds 'checking', 'savings', and 'debt' to the account_type CHECK.
-- 'debt' balances are entered as what you owe (positive number);
-- the app subtracts them when computing net worth.

ALTER TABLE public.investment_accounts
  DROP CONSTRAINT IF EXISTS investment_accounts_account_type_check;

ALTER TABLE public.investment_accounts
  ADD CONSTRAINT investment_accounts_account_type_check
  CHECK (account_type IN (
    '401k', 'roth_ira', 'ira', 'brokerage', 'hsa', 'crypto',
    'cash', 'checking', 'savings', 'debt', 'other'
  ));
