(function () {
  'use strict';

  async function getClient() {
    if (window.supabaseClient) return window.supabaseClient;
    if (window.supabaseReady) return await window.supabaseReady;
    throw new Error('Supabase client not initialized');
  }

  async function getUserId() {
    if (window.puntoAuth && typeof window.puntoAuth.getCurrentUser === 'function') {
      const user = await window.puntoAuth.getCurrentUser();
      return user ? user.id : null;
    }
    const client = await getClient();
    const { data } = await client.auth.getUser();
    return data && data.user ? data.user.id : null;
  }

  function friendlyError(err) {
    if (!err) return 'Something went wrong. Please try again.';
    const raw = err.message || String(err);
    const msg = raw.toLowerCase();
    const code = (err.code || '').toString().toUpperCase();

    if (code === 'PGRST301' || msg.includes('jwt expired') || msg.includes('jwt')) {
      return 'Your session has expired. Please sign in again.';
    }
    if (code === '42501' || msg.includes('permission denied') || msg.includes('row-level security') || msg.includes('rls')) {
      return 'You do not have permission to access this data.';
    }
    if (msg.includes('network') || msg.includes('failed to fetch') || msg.includes('load failed')) {
      return 'Network error. Check your connection and try again.';
    }
    if (msg.includes('rate limit') || msg.includes('too many')) {
      return 'Too many requests. Please wait a moment and try again.';
    }
    return raw || 'Something went wrong. Please try again.';
  }

  function notSignedIn() {
    return { success: false, error: 'You are not signed in. Please sign in and try again.' };
  }

  async function getCategories() {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const { data, error } = await client
        .from('budget_categories')
        .select('id, name, section, subtype, sort_order, is_linked, linked_deduction_id, created_at')
        .eq('user_id', userId)
        .is('deleted_at', null)
        .order('section', { ascending: true })
        .order('sort_order', { ascending: true });
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data: data || [] };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  // Stage 5F-3: one-shot boot hydration of every is_linked=true budget_category.
  // budget_categories are spanning (one row per user per category, not per
  // month), so this Map needs to be populated independent of which month the
  // user lands on at boot. Returns { id, name } per row.
  async function listLinkedBudgetCategories() {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const { data, error } = await client
        .from('budget_categories')
        .select('id, name')
        .eq('user_id', userId)
        .eq('is_linked', true)
        .is('deleted_at', null);
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data: data || [] };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function getMonthlyEntries(month) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const { data, error } = await client
        .from('monthly_entries')
        .select('id, category_id, month, expected, actual')
        .eq('user_id', userId)
        .eq('month', month);
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data: data || [] };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function getSalaryRecord(month) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const { data, error } = await client
        .from('salary_records')
        .select('id, month, annual_gross, monthly_taxes, salary_source')
        .eq('user_id', userId)
        .eq('month', month)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data: data || null };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function getSalaryDeductions(salaryRecordId) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const { data, error } = await client
        .from('salary_deductions')
        .select('id, name, amount, deduction_type, sort_order')
        .eq('salary_record_id', salaryRecordId)
        .is('deleted_at', null)
        .order('sort_order', { ascending: true });
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data: data || [] };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function getAdjustments(month) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const { data, error } = await client
        .from('adjustments')
        .select('id, category_id, month, amount, note')
        .eq('user_id', userId)
        .eq('month', month)
        .is('deleted_at', null);
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data: data || [] };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  // Stage 5G: write a new adjustment to the dedicated `adjustments` table.
  // Mirrors insertSalarySeedTransaction's shape — accepts a client UUID so
  // the in-memory id round-trips. note='' becomes null per the same pattern
  // insertTransaction uses for description.
  async function insertAdjustment(payload) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      if (!payload || !payload.category_id || !payload.month) {
        return { success: false, error: 'insertAdjustment requires category_id and month' };
      }
      const row = {
        id:          payload.id || undefined,  // client UUID, server default fallback
        user_id:     userId,
        category_id: payload.category_id,
        month:       payload.month,
        amount:      payload.amount ?? 0,
        note:        payload.note || null,
      };
      const { data, error } = await client
        .from('adjustments')
        .insert(row)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  // Stage 5G: soft-delete an adjustment. The `adjustments` table HAS a
  // deleted_at column (unlike `transactions`), so we mirror
  // softDeleteSalaryDeduction's pattern: UPDATE deleted_at to now() with
  // the .is('deleted_at', null) guard preventing double-deletion.
  async function softDeleteAdjustment(id) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      if (!id) {
        return { success: false, error: 'softDeleteAdjustment requires id' };
      }
      const { data, error } = await client
        .from('adjustments')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', userId)
        .is('deleted_at', null)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function getTransactions(month) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const { data, error } = await client
        .from('transactions')
        .select(`
          id,
          monthly_entry_id,
          amount,
          description,
          transaction_date,
          transaction_type,
          source_id,
          monthly_entries!inner(month, category_id)
        `)
        .eq('user_id', userId)
        .eq('monthly_entries.month', month);
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data: data || [] };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function insertTransaction(payload) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const row = {
        id:               payload.id || undefined,
        user_id:          userId,
        monthly_entry_id: payload.monthly_entry_id,
        amount:           payload.amount,
        description:      payload.description || null,
        transaction_date: payload.transaction_date || null,
        transaction_type: payload.transaction_type || 'manual',
        source_id:        payload.source_id || null,
      };
      const { data, error } = await client
        .from('transactions')
        .insert(row)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function deleteTransaction(id) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const { error } = await client
        .from('transactions')
        .delete()
        .eq('id', id);
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  // Stage 5F-4: insert a salary_seed transaction. source_id references
  // either salary_deductions.id (deduction-backed seed) or salary_records.id
  // (take-home seed). The Stage 5A trigger recomputes monthly_entries.actual
  // = SUM(amount) on insert.
  async function insertSalarySeedTransaction(payload) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      if (!payload || !payload.monthly_entry_id) {
        return { success: false, error: 'insertSalarySeedTransaction requires monthly_entry_id' };
      }
      const row = {
        user_id:          userId,
        monthly_entry_id: payload.monthly_entry_id,
        amount:           payload.amount ?? 0,
        description:      null,
        transaction_date: null,
        transaction_type: 'salary_seed',
        source_id:        payload.source_id || null,
      };
      const { data, error } = await client
        .from('transactions')
        .insert(row)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  // Stage 5F-4: update an existing salary_seed transaction's amount in place.
  // The cached txn id is the entry point — caller maintains the cache. The
  // trigger recomputes monthly_entries.actual on UPDATE.
  async function updateSalarySeedTransaction(transactionId, fields) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      if (!transactionId) {
        return { success: false, error: 'updateSalarySeedTransaction requires transactionId' };
      }
      const update = { updated_at: new Date().toISOString() };
      if (fields && 'amount' in fields) update.amount = fields.amount;
      const { data, error } = await client
        .from('transactions')
        .update(update)
        .eq('id', transactionId)
        .eq('user_id', userId)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  // Stage 5F-4: hard-delete a salary_seed transaction (transactions has no
  // deleted_at column). Trigger fires on DELETE and recomputes
  // monthly_entries.actual to exclude this row.
  async function deleteSalarySeedTransaction(transactionId) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      if (!transactionId) {
        return { success: false, error: 'deleteSalarySeedTransaction requires transactionId' };
      }
      const { error } = await client
        .from('transactions')
        .delete()
        .eq('id', transactionId)
        .eq('user_id', userId);
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  // Stage 5F-4: boot hydration for the take-home salary_seed transaction
  // ids. Returns [{ txn_id, month }]. Uses a nested inner-join to filter
  // transactions whose parent monthly_entry's parent budget_category is the
  // income Salary row.
  async function listTakeHomeSalarySeeds() {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const { data, error } = await client
        .from('transactions')
        .select(`
          id,
          monthly_entries!inner(
            month,
            budget_categories!inner(section, name)
          )
        `)
        .eq('user_id', userId)
        .eq('transaction_type', 'salary_seed')
        .eq('monthly_entries.budget_categories.section', 'income')
        .eq('monthly_entries.budget_categories.name', 'Salary');
      if (error) return { success: false, error: friendlyError(error) };
      const rows = (data || []).map(r => ({
        txn_id: r.id,
        month:  r.monthly_entries && r.monthly_entries.month,
      })).filter(r => r.month);
      return { success: true, data: rows };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function insertMonthlyEntry(payload) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const row = {
        user_id:     userId,
        category_id: payload.category_id,
        month:       payload.month,
        expected:    payload.expected ?? 0,
        actual:      payload.actual   ?? 0,
      };
      const { data, error } = await client
        .from('monthly_entries')
        .insert(row)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function updateMonthlyEntry(payload) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const updates = {
        expected: payload.expected,
        // DO NOT include actual — trigger owns it
        // DO NOT include name — wrong table (Stage 5E)
      };
      const { data, error } = await client
        .from('monthly_entries')
        .update(updates)
        .eq('id', payload.id)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function insertBudgetCategory(payload) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const row = {
        id:                  payload.id || undefined,  // client UUID precedent
        user_id:             userId,
        name:                payload.name,
        section:             payload.section,
        subtype:             payload.subtype || null,
        sort_order:          payload.sort_order ?? 0,
        is_linked:           payload.is_linked || false,
        linked_deduction_id: payload.linked_deduction_id || null,
      };
      const { data, error } = await client
        .from('budget_categories')
        .insert(row)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function updateBudgetCategory({ id, ...fields }) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      if (!id) {
        return { success: false, error: 'updateBudgetCategory requires id' };
      }
      // Whitelist mutable fields. Stage 5F-3 adds is_linked + linked_deduction_id
      // for 5F-4's orphan-promote case (manual row → marked linked).
      const allowed = ['name', 'subtype', 'sort_order', 'is_linked', 'linked_deduction_id'];
      const update = {};
      for (const k of allowed) {
        if (k in fields) update[k] = fields[k];
      }
      if (Object.keys(update).length === 0) {
        return { success: true, data: null };  // no-op
      }
      const { data, error } = await client
        .from('budget_categories')
        .update(update)
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function softDeleteBudgetCategory(id) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      if (!id) {
        return { success: false, error: 'softDeleteBudgetCategory requires id' };
      }
      const { data, error } = await client
        .from('budget_categories')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  // Check-then-write upsert on (user_id, month). The underlying unique
  // constraint is partial — UNIQUE(user_id, month) WHERE deleted_at IS NULL
  // — and supabase-js's .upsert() can't pass the WHERE predicate to ON
  // CONFLICT, so a real .upsert() would 42P10 on first conflict. We do an
  // explicit SELECT-then-UPDATE-or-INSERT instead (5C-2 ensureMonthlyEntriesExist
  // uses the same pattern). Single-user single-device, so no race-window
  // concerns.
  async function upsertSalaryRecord(payload) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      if (!payload || !payload.monthKey) {
        return { success: false, error: 'upsertSalaryRecord requires monthKey' };
      }

      // 1. Look up an existing active record for this user+month.
      const { data: existing, error: selErr } = await client
        .from('salary_records')
        .select('id')
        .eq('user_id', userId)
        .eq('month', payload.monthKey)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle();
      if (selErr) return { success: false, error: friendlyError(selErr) };

      const fields = {
        annual_gross:  payload.annualGross ?? 0,
        monthly_taxes: payload.monthlyTaxes ?? 0,
        salary_source: payload.salarySource || 'manual',
        updated_at:    new Date().toISOString(),
      };

      if (existing && existing.id) {
        // 2a. UPDATE the existing row.
        const { data, error } = await client
          .from('salary_records')
          .update(fields)
          .eq('id', existing.id)
          .eq('user_id', userId)
          .select()
          .single();
        if (error) return { success: false, error: friendlyError(error) };
        return { success: true, data };
      }

      // 2b. INSERT a new row.
      const insertRow = {
        user_id: userId,
        month:   payload.monthKey,
        ...fields,
      };
      const { data, error } = await client
        .from('salary_records')
        .insert(insertRow)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function insertSalaryDeduction(payload) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      if (!payload || !payload.salaryRecordId) {
        return { success: false, error: 'insertSalaryDeduction requires salaryRecordId' };
      }
      const row = {
        id:               payload.id || undefined,  // client UUID precedent (see insertTransaction)
        salary_record_id: payload.salaryRecordId,
        user_id:          userId,
        name:             payload.name || '',
        amount:           payload.amount ?? 0,
        deduction_type:   payload.deductionType || 'investment',
        sort_order:       payload.sortOrder ?? 0,
      };
      const { data, error } = await client
        .from('salary_deductions')
        .insert(row)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function updateSalaryDeduction(id, fields) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      if (!id) {
        return { success: false, error: 'updateSalaryDeduction requires id' };
      }
      fields = fields || {};
      // Whitelist + camelCase→snake_case mapping
      const update = {};
      if ('name'          in fields) update.name           = fields.name;
      if ('amount'        in fields) update.amount         = fields.amount;
      if ('deductionType' in fields) update.deduction_type = fields.deductionType;
      if ('sortOrder'     in fields) update.sort_order     = fields.sortOrder;
      if (Object.keys(update).length === 0) {
        return { success: true, data: null };  // no-op
      }
      const { data, error } = await client
        .from('salary_deductions')
        .update(update)
        .eq('id', id)
        .eq('user_id', userId)
        .is('deleted_at', null)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function softDeleteSalaryDeduction(id) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      if (!id) {
        return { success: false, error: 'softDeleteSalaryDeduction requires id' };
      }
      const { data, error } = await client
        .from('salary_deductions')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', userId)
        .is('deleted_at', null)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  // Stage 5F-2.1: batch soft-delete every active deduction for a given
  // salary_record. One PostgREST PATCH affects all matching rows — single
  // round-trip regardless of N. Used by dualWriteSalaryMonthToApi to make
  // the DB state for a month exactly match in-memory state (cleanup-then-
  // insert), which prevents duplicate deductions from apply-forward.
  async function softDeleteSalaryDeductionsForRecord(salaryRecordId) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      if (!salaryRecordId) {
        return { success: false, error: 'softDeleteSalaryDeductionsForRecord requires salaryRecordId' };
      }
      const { error } = await client
        .from('salary_deductions')
        .update({ deleted_at: new Date().toISOString() })
        .eq('salary_record_id', salaryRecordId)
        .eq('user_id', userId)
        .is('deleted_at', null);
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  // ============================================================
  // Stage 6: Investing — accounts + monthly balance snapshots
  // ============================================================
  async function getInvestmentAccounts() {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const { data, error } = await client
        .from('investment_accounts')
        .select('id, name, account_type, sort_order')
        .eq('user_id', userId)
        .is('deleted_at', null)
        .order('sort_order', { ascending: true });
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data: data || [] };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function insertInvestmentAccount(payload) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const row = {
        id:           payload.id || undefined,  // client UUID precedent
        user_id:      userId,
        name:         payload.name || '',
        account_type: payload.account_type || 'brokerage',
        sort_order:   payload.sort_order ?? 0,
      };
      const { data, error } = await client
        .from('investment_accounts')
        .insert(row)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function updateInvestmentAccount({ id, ...fields }) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      if (!id) return { success: false, error: 'updateInvestmentAccount requires id' };
      const allowed = ['name', 'account_type', 'sort_order'];
      const update = { updated_at: new Date().toISOString() };
      for (const k of allowed) {
        if (k in fields) update[k] = fields[k];
      }
      const { data, error } = await client
        .from('investment_accounts')
        .update(update)
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function softDeleteInvestmentAccount(id) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      if (!id) return { success: false, error: 'softDeleteInvestmentAccount requires id' };
      const { data, error } = await client
        .from('investment_accounts')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', userId)
        .is('deleted_at', null)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  // All snapshots for the user in one call — data volume is tiny
  // (accounts × months), and the chart needs the full history anyway.
  async function getInvestmentSnapshots() {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const { data, error } = await client
        .from('investment_snapshots')
        .select('id, account_id, month, balance, flow_base')
        .eq('user_id', userId)
        .order('month', { ascending: true });
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data: data || [] };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  // SELECT-then-UPDATE-or-INSERT on (account_id, month) — same pattern as
  // upsertSalaryRecord. Single-user single-device, so no race concerns.
  async function upsertInvestmentSnapshot(payload) {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      if (!payload || !payload.account_id || !payload.month) {
        return { success: false, error: 'upsertInvestmentSnapshot requires account_id and month' };
      }
      const { data: existing, error: selErr } = await client
        .from('investment_snapshots')
        .select('id')
        .eq('user_id', userId)
        .eq('account_id', payload.account_id)
        .eq('month', payload.month)
        .limit(1)
        .maybeSingle();
      if (selErr) return { success: false, error: friendlyError(selErr) };

      if (existing && existing.id) {
        const { data, error } = await client
          .from('investment_snapshots')
          .update({ balance: payload.balance ?? 0, flow_base: payload.flow_base ?? null, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
          .eq('user_id', userId)
          .select()
          .single();
        if (error) return { success: false, error: friendlyError(error) };
        return { success: true, data };
      }

      const row = {
        user_id:    userId,
        account_id: payload.account_id,
        month:      payload.month,
        balance:    payload.balance ?? 0,
        flow_base:  payload.flow_base ?? null,
      };
      const { data, error } = await client
        .from('investment_snapshots')
        .insert(row)
        .select()
        .single();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function getUserPreferences() {
    try {
      const userId = await getUserId();
      if (!userId) return notSignedIn();
      const client = await getClient();
      const { data, error } = await client
        .from('user_preferences')
        .select('currency, sidebar_collapsed, onboarding_complete')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, data: data || null };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  window.puntoApi = {
    getCategories,
    listLinkedBudgetCategories,
    getMonthlyEntries,
    getSalaryRecord,
    getSalaryDeductions,
    getAdjustments,
    insertAdjustment,
    softDeleteAdjustment,
    getTransactions,
    insertTransaction,
    deleteTransaction,
    insertSalarySeedTransaction,
    updateSalarySeedTransaction,
    deleteSalarySeedTransaction,
    listTakeHomeSalarySeeds,
    insertMonthlyEntry,
    updateMonthlyEntry,
    insertBudgetCategory,
    updateBudgetCategory,
    softDeleteBudgetCategory,
    upsertSalaryRecord,
    insertSalaryDeduction,
    updateSalaryDeduction,
    softDeleteSalaryDeduction,
    softDeleteSalaryDeductionsForRecord,
    getUserPreferences,
    getInvestmentAccounts,
    insertInvestmentAccount,
    updateInvestmentAccount,
    softDeleteInvestmentAccount,
    getInvestmentSnapshots,
    upsertInvestmentSnapshot,
  };
})();
