-- Stage 9: persist flow_base on investment snapshots.
--
-- flow_base records the account's Budget flow total (debt payments /
-- contributions, matched by name) at the moment a balance was typed.
-- Only flows logged AFTER that moment adjust the displayed balance, so the
-- estimate stays consistent across devices. Legacy snapshots keep NULL and
-- are treated as fixed for their month (no double-counting).
--
-- Run this in the Supabase SQL editor.

alter table public.investment_snapshots
  add column if not exists flow_base numeric;
