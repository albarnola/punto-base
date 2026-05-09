# Stage 5 Plan — localStorage Writes → Supabase Writes

Locked architectural decisions for migrating the app's write path from localStorage to Supabase. Reads were migrated in Phase 4B (commits b9ebbfc through 6c9b5bd). Stage 5 is the writes counterpart.

## Locked decisions

1. **Optimistic UI.** Mutate state and re-render immediately, fire Supabase write in background, revert on failure.

2. **Write trigger.** Debounce 800ms after last keystroke, flush on blur, flush on `beforeunload` via `navigator.sendBeacon`.

3. **Transactions migrate to Supabase (Option A).** New `transactions` table, FK to `monthly_entries.id`. Per-transaction history is preserved.

4. **Postgres trigger maintains `monthly_entries.actual`.** Trigger on `transactions` recomputes the parent's actual = SUM of all transactions on insert/update/delete. App code only writes transactions; the actual stays consistent automatically.

5. **Coherent input model (Approach Q).** Everything is a transaction. Salary tab edits insert/delete `salary_seed` transactions atomically. User-added transactions are `manual` type. The Actual cell on a row is a UI shortcut; clicking it adds a manual transaction. There is no "type Actual directly" mode.

6. **Single global sync indicator in the header.** States: idle (green), saving (amber, pulsing), error (red), offline (gray). Hover shows last-saved-or-pending status. No per-row indicators in v1.

7. **Error and retry strategy.**
   - Network errors: auto-retry with exponential backoff (1s, 2s, 4s, 8s), then mark Error.
   - Application errors (RLS, validation, FK): no retry, immediate Error state.
   - Auth errors: defer to Stage 6 (just fail for now).
   - Pending writes queued in memory only for v1 (not persisted to localStorage).

8. **Offline behavior.** Full-screen overlay when `navigator.onLine` is false. App is unusable until reconnected. **TODO: upgrade to full offline-capable (read from cache, queue writes, replay on reconnect) in a later phase. This is a real product gap; budget apps are commonly used in low-connectivity environments. Plan for ~Stage 7 or 8.**

9. **localStorage → Supabase migration on first login (Big-bang, Option α).** When user logs in and localStorage has data but Supabase is empty for them, run a one-time migration that pushes everything up. Mark `localStorage.migratedAt` and skip on subsequent logins. Failure shows "migration failed" message; do NOT load empty Supabase state on top of unmigrated localStorage.

   **CRITICAL: Stage 5H must ship before logging into a real account for the first time post-Stage-5, or real localStorage data is at risk.**

## New schema (Stage 5A will create this)

```sql
transactions (
  id              uuid primary key default gen_random_uuid(),
  monthly_entry_id uuid not null references monthly_entries(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  amount          numeric(12,2) not null,
  description     text,
  transaction_date date,
  transaction_type text not null default 'manual'
    check (transaction_type in ('manual', 'salary_seed')),
  source_id       uuid,  -- references salary_records.id or salary_deductions.id when type='salary_seed'
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- RLS: user can only see/modify their own transactions
-- Trigger: AFTER INSERT/UPDATE/DELETE → recompute monthly_entries.actual
```

## Implementation order — 10 sub-phases

Each phase is roughly 1 session unless noted. Stage 5C is the architectural keystone; once its pattern is established, 5D-G are mechanical applications.

- **5A.** Schema for `transactions` table + RLS policies + trigger to maintain `monthly_entries.actual`. SQL only, no app code. (1 session)
- **5B.** Read transactions from Supabase, render in expanded row view. No writes yet. (1 session)
- **5C.** Write transactions to Supabase (add/edit/delete). Build optimistic UI + sync indicator + retry queue. **The hard one.** (3-4 sessions)
- **5D.** Write monthly_entries fields (Expected, name) to Supabase using 5C's infrastructure. (1 session)
- **5E.** Write categories (add/remove/rename) to Supabase. (1 session)
- **5F.** Salary tab writes — update salary_records, salary_deductions; auto-manage salary_seed transactions. (1 session)
- **5G.** Adjustments writes. (1 session)
- **5H.** localStorage → Supabase migration code with fixture-based testing. **Must ship before any real-user account logs in.** (2 sessions)
- **5I.** Re-enable the six buttons disabled in Phase 4B-4b (Copy from Previous Month, Apply to Future Months, Reset This Month, Clear All Data, Salary Apply to Future). They now perform real Supabase operations. Decide whether Export JSON stays disabled or becomes a Supabase-backed export. (1 session)
- **5J.** Offline overlay (Q8 v1). (1 session)

**Estimated total: ~12-14 sessions.**

## Out of scope for Stage 5

- Auth session refresh / re-login flow (Stage 6)
- Account deletion (Stage 6)
- Real offline support — queue writes, replay on reconnect (Stage 7+)
- Per-row sync indicators (deferred)
- Persistent retry queue across tab close (deferred)
- Conflict resolution for multi-device editing (deferred — single-user app for now)
- Performance: parallelize writes (deferred — get correctness first)

## Phase 4B reference

Reads migration is complete on `origin/feat/auth`. The commit stack:

```
6c9b5bd  feat(stage4): add loading overlay and parallelize Supabase reads     (4B-4a)
4ad7bf1  feat(stage4): disable localStorage-only Data buttons                  (4B-4b)
2a2e046  feat(stage4): read adjustments from Supabase                          (4B-3b)
86686ee  feat(stage4): read salary record and deductions from Supabase         (4B-3a)
fd5a69f  fix(stage4): re-stamp Supabase category IDs on month change           (4B-2c)
369d074  feat(stage4): read budget categories and monthly entries              (4B-1, 4B-2)
b9ebbfc  Add Supabase API helper module (read-only)                            (4A)
```

All decisions in this document supersede any conflicting earlier discussion.
