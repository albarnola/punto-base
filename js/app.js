(() => {
  'use strict';

  // ============================================================
  // TRANSLATIONS
  // ============================================================
  const t = {
    en: {
      addRow:            '+ Add Row',
      remove:            '×',
      removeAriaLabel:   'Remove row',
      namePlaceholder:   'Name',
      confirmYes:        'Yes',
      confirmCancel:     'Cancel',
      resetMonth:        'Reset This Month',
      resetMonthConfirm: "Clear this month's transactions, expected values, and adjustments? Category rows are kept.",
      clearAll:          'Clear All Data',
      clearAllConfirm:   'Wipe all budget data? This cannot be undone.',
      exportJson:        'Export JSON',
income:            'Income',
      fixed:             'Fixed Expenses',
      variable:          'Variable Expenses',
      recreational:      'Recreational Expenses',
      savings:           'Savings & Investments',
      totalIncome:       'Total Income',
      totalExpenses:     'Total Expenses',
      net:               'Net',
      settings:          'Settings',
      addTransaction:    '+ Add',
      amountPlaceholder: 'Amount',
      notePlaceholder:   'Note (optional)',
      toggleTxn:         'Toggle transactions',
      noTransactions:    'No transactions yet.',
      migrated:          'Migrated',
    },
  };

  const T = (key, vars = {}) => {
    let str = t.en[key] ?? key;
    for (const [k, v] of Object.entries(vars)) str = str.replace(`{${k}}`, v);
    return str;
  };

  // ============================================================
  // DEFAULTS
  // ============================================================
  const DEFAULTS = {
    income:       [{ name: 'Salary' }],
    fixed:        [
      { name: 'Rent' }, { name: 'Car Payment' }, { name: 'Car Insurance' },
      { name: 'Electricity' }, { name: 'Wi-Fi' }, { name: 'Trash' },
      { name: 'Subscriptions' }, { name: 'Gym' }, { name: 'Phone' },
    ],
    variable:     [
      { name: 'Groceries' }, { name: 'Amazon' }, { name: 'Gas' },
      { name: 'Haircut' }, { name: 'Work Lunch' }, { name: 'Uber' },
      { name: 'Subway' }, { name: 'Dry Cleaning' }, { name: 'Clothing' },
    ],
    recreational: [{ name: 'Dates' }, { name: 'Drinks' }, { name: 'Travel' }],
    savings: [
      { name: 'Roth IRA Contribution' },
      { name: 'Taxable Brokerage' },
      { name: 'Emergency Fund' },
    ],
  };

  const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', MXN: '$', GBP: '£' };

  // Mobile viewport — used to drop decimals from monetary displays on narrow screens
  const MOBILE_MQL = window.matchMedia('(max-width: 767px)');

  // ============================================================
  // STATE
  // ============================================================
  const LS_KEY = 'puntobase_budget';
  let state        = null;
  let currentMonth = toMonthKey(new Date());
  const expandedRows = new Set();

  // Cache of Supabase categories from init's fetch, reused on month change
  // to re-stamp row IDs.
  let apiCategoriesCache = null;

  // Stage 5F-3 (extended by 5F-4): bridge between syncBudgetWithSalary's
  // synthesized linked rows (transient, render-time disposable) and the real
  // server-side budget_categories rows backing them.
  //
  // Key: normalized deduction name. Value:
  //   {
  //     budgetCategoryId:       <uuid>,
  //     monthlyEntryIdByMonth:  Map<monthKey, monthlyEntryId>,
  //     actualByMonth:          Map<monthKey, number>,   // 5F-4: trigger-maintained
  //     salarySeedTxnIdByMonth: Map<monthKey, txnId>,    // 5F-4: cached for update-in-place
  //   }
  //
  // budget_categories is spanning (one row per user per name) but the
  // monthly_entries / transactions / actual values are per-month, hence
  // the nested Maps.
  const linkedBudgetCategoryIds = new Map();

  function normalizeDeductionName(name) {
    return (name || '').trim().toLowerCase();
  }

  // Stage 5F-4 Part 4: cached salary_seed transaction id for the income
  // Salary row, keyed by monthKey. Separate from linkedBudgetCategoryIds
  // because the take-home seed is keyed on month (not on a deduction name)
  // and its source_id references salary_records.id (not salary_deductions.id).
  const takeHomeSalarySeedTxnIdByMonth = new Map();

  // Undo / redo
  const undoStack   = [];
  const redoStack   = [];
  const MAX_UNDO    = 20;
  let   pendingUndo   = null; // { snapshot, description } captured on input focus
  let   pendingAddRow = null; // { rowId, section, snapshot } — deferred undo for new rows
  let   toastEl       = null;
  let   toastTimer    = null;

  function toMonthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function newRow(name = '', expected = 0, order = 0) {
    return {
      id:           crypto.randomUUID(),
      name,
      expected,
      order,
      transactions: [],
      adjustments:  [],
    };
  }

  function newTransaction(amount, date, note = '', extras = {}) {
    return {
      id: crypto.randomUUID(),
      date,
      amount,
      note,
      // Stage 5 fields (populated by applier when reading from Supabase;
      // defaults are fine for locally-created transactions until Stage 5C
      // wires writes).
      monthly_entry_id: extras.monthly_entry_id || null,
      transaction_type: extras.transaction_type || 'manual',
      source_id:        extras.source_id        || null,
    };
  }

  function newAdjustment(amount = 0, note = '') {
    return { id: crypto.randomUUID(), amount, note };
  }

  const DEDUCTION_TYPES = ['investment', 'expense'];
  const EXPENSE_NAME_KEYWORDS = ['insurance', 'dental', 'vision', 'commuter', 'transit'];

  // Sub-types for rows in the Savings & Investments section.
  const SUBTYPES = ['investment', 'savings'];
  const SAVINGS_NAME_KEYWORDS = ['fund', 'savings'];

  function inferSubtype(name) {
    const lower = (name || '').toLowerCase();
    return SAVINGS_NAME_KEYWORDS.some(k => lower.includes(k)) ? 'savings' : 'investment';
  }

  function normalizeSubtype(subtype, name) {
    if (SUBTYPES.includes(subtype)) return subtype;
    return inferSubtype(name);
  }

  function inferDeductionType(name) {
    const lower = (name || '').toLowerCase();
    return EXPENSE_NAME_KEYWORDS.some(k => lower.includes(k)) ? 'expense' : 'investment';
  }

  function normalizeDeductionType(type, name) {
    if (DEDUCTION_TYPES.includes(type)) return type;
    return inferDeductionType(name);
  }

  function newDeduction(name = '', amount = 0, type = 'investment') {
    return {
      id:     crypto.randomUUID(),
      name,
      amount,
      type:   normalizeDeductionType(type, name),
    };
  }

  function defaultSalaryData() {
    return {
      annualGross: 0,
      deductions: [
        newDeduction('401(k) Contribution', 0, 'investment'),
        newDeduction('Health Insurance',    0, 'expense'),
        newDeduction('HSA',                 0, 'investment'),
      ],
      taxes: 0,
      salarySource: 'manual',
    };
  }

  function cloneSalaryData(src, salarySource = 'inherited') {
    return {
      annualGross: parseAmount(src.annualGross),
      deductions: (src.deductions || []).map(d =>
        newDeduction(d.name, parseAmount(d.amount), normalizeDeductionType(d.type, d.name))
      ),
      taxes: parseAmount(src.taxes),
      salarySource,
    };
  }

  function defaultMonthData(priorMonth = null) {
    if (priorMonth) {
      // Carry over name/expected/order/subtype to the new month — actuals
      // (transactions) and adjustments are intentionally per-month and reset.
      const copyRows = list => list.map((r, i) => {
        const nr = newRow(r.name, r.expected, r.order ?? i);
        if (r.subtype) nr.subtype = r.subtype;
        return nr;
      });
      return {
        income: copyRows(priorMonth.income),
        categories: {
          fixed:             copyRows(priorMonth.categories.fixed),
          variable:          copyRows(priorMonth.categories.variable),
          recreational:      copyRows(priorMonth.categories.recreational),
          savings:           copyRows(priorMonth.categories.savings || []),
          debt:              copyRows(priorMonth.categories.debt || []),
          pretaxInvestments: [],
        },
      };
    }
    return {
      income: DEFAULTS.income.map((d, i) => newRow(d.name, 0, i)),
      categories: {
        fixed:             DEFAULTS.fixed.map((d, i) => newRow(d.name, 0, i)),
        variable:          DEFAULTS.variable.map((d, i) => newRow(d.name, 0, i)),
        recreational:      DEFAULTS.recreational.map((d, i) => newRow(d.name, 0, i)),
        savings:           DEFAULTS.savings.map((d, i) => newRow(d.name, 0, i)),
        debt:              [],
        pretaxInvestments: [],
      },
    };
  }

  // ============================================================
  // MIGRATION
  // ============================================================
  function migrateRow(row, monthKey) {
    if (Array.isArray(row.transactions)) return;
    const actual = parseAmount(row.actual ?? 0);
    row.transactions = [];
    if (actual > 0) {
      const [y, m] = monthKey.split('-');
      row.transactions.push(newTransaction(actual, `${y}-${m}-01`, T('migrated')));
    }
    delete row.actual;
  }

  function migrateState(s) {
    if (!s.settings) s.settings = {};
    if (!s.settings.defaultTransactionDate) s.settings.defaultTransactionDate = 'today';
    if (!s.salaryData) s.salaryData = {};
    // Backfill `type` on deductions saved before the investment/expense split.
    for (const rec of Object.values(s.salaryData)) {
      if (!rec || !Array.isArray(rec.deductions)) continue;
      for (const ded of rec.deductions) {
        if (!DEDUCTION_TYPES.includes(ded.type)) {
          ded.type = inferDeductionType(ded.name);
        }
      }
    }
    for (const [monthKey, md] of Object.entries(s.months || {})) {
      if (!md) continue;
      (md.income || []).forEach(r => migrateRow(r, monthKey));
      if (md.categories && !md.categories.savings) {
        md.categories.savings = DEFAULTS.savings.map((d, i) => newRow(d.name, 0, i));
      }
      if (md.categories && !md.categories.pretaxInvestments) {
        md.categories.pretaxInvestments = [];
      }
      if (md.categories && !md.categories.debt) {
        md.categories.debt = [];
      }
      for (const list of Object.values(md.categories || {})) {
        (list || []).forEach(r => migrateRow(r, monthKey));
      }
    }
    // Assign order field to any row that doesn't have one yet
    for (const md of Object.values(s.months || {})) {
      if (!md) continue;
      (md.income || []).forEach((r, i) => { if (r.order === undefined) r.order = i; });
      for (const list of Object.values(md.categories || {})) {
        (list || []).forEach((r, i) => { if (r.order === undefined) r.order = i; });
      }
    }
    // Backfill `adjustments` on every row (used by linked rows).
    for (const md of Object.values(s.months || {})) {
      if (!md) continue;
      const allLists = [md.income || [], ...Object.values(md.categories || {})];
      for (const list of allLists) {
        for (const row of list || []) {
          if (!Array.isArray(row.adjustments)) row.adjustments = [];
        }
      }
    }
    // Backfill `subtype` on Savings & Investments rows.
    for (const md of Object.values(s.months || {})) {
      const savings = md?.categories?.savings || [];
      for (const row of savings) {
        if (!SUBTYPES.includes(row.subtype)) {
          row.subtype = inferSubtype(row.name);
        }
      }
    }
  }

  // ============================================================
  // PERSISTENCE
  // ============================================================
  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return null;
  }

  function saveState() {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  }

  function debounce(fn, ms) {
    let timer    = null;
    let lastArgs = null;
    let lastThis = null;

    const debounced = function (...args) {
      lastArgs = args;
      lastThis = this;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const a = lastArgs;
        const t = lastThis;
        lastArgs = null;
        lastThis = null;
        fn.apply(t, a);
      }, ms);
    };

    // Force a pending invocation to fire NOW (synchronously). No-op if no
    // call is pending. Used by flushSalaryEditSession + beforeunload to
    // close the localStorage-vs-Supabase drift window.
    debounced.flush = function () {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      if (lastArgs) {
        const a = lastArgs;
        const t = lastThis;
        lastArgs = null;
        lastThis = null;
        fn.apply(t, a);
      }
    };

    // Drop any pending invocation without firing it.
    debounced.cancel = function () {
      clearTimeout(timer);
      timer    = null;
      lastArgs = null;
      lastThis = null;
    };

    return debounced;
  }

  const debouncedSave = debounce(saveState, 250);

  // ============================================================
  // SYNC INDICATOR (Stage 5C-3-1)
  // ============================================================
  // Sync indicator state machine.
  // States: 'idle' (gray), 'pending' (amber), 'synced' (green, 1.5s
  // then idle), 'error' (red, until retry queue drains).
  let syncInFlight = 0;
  let syncRetryQueueSize = 0;
  let syncSyncedTimer = null;
  let syncHasErrorSinceLastDrain = false;

  function setSyncClass(cls) {
    const el = document.getElementById('sync-indicator');
    if (!el) return;
    el.classList.remove('sync-idle', 'sync-pending', 'sync-synced', 'sync-error');
    el.classList.add(cls);
    el.setAttribute('aria-label', `Sync status: ${cls.replace('sync-', '')}`);
  }

  function recomputeSyncState() {
    // Active work → pending (overrides everything else)
    if (syncInFlight > 0 || syncRetryQueueSize > 0) {
      if (syncSyncedTimer) { clearTimeout(syncSyncedTimer); syncSyncedTimer = null; }
      setSyncClass(syncHasErrorSinceLastDrain ? 'sync-error' : 'sync-pending');
      return;
    }
    // No active work + had an error → error sticks until next successful write
    if (syncHasErrorSinceLastDrain) {
      setSyncClass('sync-error');
      return;
    }
    // No active work, no recent error → synced briefly, then idle
    setSyncClass('sync-synced');
    if (syncSyncedTimer) clearTimeout(syncSyncedTimer);
    syncSyncedTimer = setTimeout(() => {
      setSyncClass('sync-idle');
      syncSyncedTimer = null;
    }, 1500);
  }

  function syncBeginWrite() {
    syncInFlight++;
    recomputeSyncState();
  }

  function syncEndWriteSuccess() {
    syncInFlight = Math.max(0, syncInFlight - 1);
    syncHasErrorSinceLastDrain = false;  // success clears the error flag
    recomputeSyncState();
  }

  function syncEndWriteFailure() {
    syncInFlight = Math.max(0, syncInFlight - 1);
    syncHasErrorSinceLastDrain = true;
    recomputeSyncState();
  }

  // Network-error retry with exponential backoff: 1s, 2s, 4s, 8s.
  // After 4 failed attempts, gives up and calls onFinalFailure.
  // App-level errors (4xx-equivalent) — i.e., result.success === false
  // with a non-network friendlyError — are NOT retried; onFinalFailure
  // fires immediately. The distinction: network errors throw or yield
  // success:false with no data; app errors yield success:false with a
  // structured error. For v1 we treat ALL success:false as terminal
  // (no retry). Anything that throws is a network error and IS retried.
  //
  // queueSize tracking lets the sync indicator reflect "something is
  // pending in retry land."
  const RETRY_DELAYS = [1000, 2000, 4000, 8000];

  async function withRetry(apiCall, onFinalFailure) {
    syncBeginWrite();
    let attempt = 0;
    while (true) {
      try {
        const result = await apiCall();
        if (result && result.success) {
          syncEndWriteSuccess();
          return;
        }
        // success:false (app error) — no retry
        syncEndWriteFailure();
        onFinalFailure(result?.error || 'Write failed');
        return;
      } catch (err) {
        // Network/throw — eligible for retry
        if (attempt >= RETRY_DELAYS.length) {
          syncEndWriteFailure();
          onFinalFailure(err);
          return;
        }
        syncRetryQueueSize++;
        recomputeSyncState();
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
        syncRetryQueueSize--;
        attempt++;
      }
    }
  }

  // ============================================================
  // EXPECTED-EDIT DEBOUNCE (Stage 5D)
  // ============================================================
  // Per-monthly_entry_id debounced flushers for Expected writes.
  // Each row has its own 800ms timer so edits across rows don't coalesce.
  const expectedFlushers = new Map();

  function flushExpectedWrite(row, section, preEditExpected) {
    // Re-read current expected at flush time — might have changed during the wait.
    const currentExpected = row.expected;
    withRetry(
      () => window.puntoApi.updateMonthlyEntry({
        id:       row.monthly_entry_id,
        expected: currentExpected,
      }),
      (err) => {
        console.warn('updateMonthlyEntry failure, reverting:', err);
        row.expected = preEditExpected;
        // Re-render the input value
        const tr = document.querySelector(`tr[data-id="${row.id}"]`);
        if (tr) {
          const input = tr.querySelector('input[data-field="expected"]');
          if (input) input.value = formatCurrency(preEditExpected);
        }
        // Repaint variance + summary
        updateRowCells(row.id, section);
        renderSummary();
        debouncedSave();
      }
    );
  }

  function getExpectedFlusher(monthlyEntryId) {
    let flusher = expectedFlushers.get(monthlyEntryId);
    if (!flusher) {
      flusher = debounce((row, section, capturedPreEditExpected) => {
        flushExpectedWrite(row, section, capturedPreEditExpected);
      }, 800);
      expectedFlushers.set(monthlyEntryId, flusher);
    }
    return flusher;
  }

  // ── Name-field per-row debounced writer (Stage 5E) ────────────
  // Mirrors the Expected pattern. section is threaded through closure so
  // the revert path can look the row up via the existing findRow helper.
  // Lifecycle (syncBeginWrite/Success/Failure) is handled inside withRetry,
  // so we do NOT wrap manually.
  const nameFlushers = new Map();

  function flushNameWrite(rowId, section, newName, preEditName) {
    withRetry(
      () => window.puntoApi.updateBudgetCategory({ id: rowId, name: newName }),
      (err) => {
        console.warn(`Stage 5E: name write failed for row ${rowId}, reverting to "${preEditName}":`, err);
        const row = findRow(section, rowId);
        if (row) {
          row.name = preEditName;
          renderAll();
          debouncedSave();
        }
      }
    );
  }

  function getNameFlusher(rowId) {
    let flusher = nameFlushers.get(rowId);
    if (!flusher) {
      flusher = debounce((section, newName, preEditName) => {
        flushNameWrite(rowId, section, newName, preEditName);
      }, 800);
      nameFlushers.set(rowId, flusher);
    }
    return flusher;
  }

  // ── Salary-record debounced writer (Stage 5F-2) ───────────────
  // One debouncer per month. Used by the gross / taxes inputs which
  // mutate the salary_record row directly.
  const salaryRecordFlushers = new Map();

  function getSalaryRecordFlusher(monthKey) {
    let flusher = salaryRecordFlushers.get(monthKey);
    if (!flusher) {
      flusher = debounce(async () => {
        const rec = state.salaryData?.[monthKey];
        if (!rec) return;
        if (!window.puntoApi || typeof window.puntoApi.upsertSalaryRecord !== 'function') return;
        const r = await window.puntoApi.upsertSalaryRecord({
          monthKey,
          annualGross:  parseAmount(rec.annualGross),
          monthlyTaxes: parseAmount(rec.taxes),
          salarySource: rec.salarySource || 'manual',
        });
        if (r && r.success && r.data) {
          rec.id = r.data.id;
        } else {
          console.warn(`5F-2 dual-write failed at upsertSalaryRecord (${monthKey}):`,
                       r && r.error);
          return;
        }
        // Stage 5F-4 Part 4: refresh the take-home salary_seed transaction.
        // Gross / taxes / deduction-amount edits all converge on this flusher
        // (the deduction-field handler also calls getSalaryRecordFlusher for
        // the salarySource flip), so this hook covers all three.
        await upsertTakeHomeSalarySeed(monthKey);
      }, 800);
      salaryRecordFlushers.set(monthKey, flusher);
    }
    return flusher;
  }

  // ── Salary-deduction debounced writer (Stage 5F-2) ────────────
  // One debouncer per deduction id. The deduction's id is the client
  // UUID stamped by newDeduction + passed through to the DB on INSERT.
  const salaryDeductionFlushers = new Map();

  function getSalaryDeductionFlusher(deductionId) {
    let flusher = salaryDeductionFlushers.get(deductionId);
    if (!flusher) {
      flusher = debounce(async (fields, ded, monthKey) => {
        if (!window.puntoApi || typeof window.puntoApi.updateSalaryDeduction !== 'function') return;
        const r = await window.puntoApi.updateSalaryDeduction(deductionId, fields);
        if (!r || !r.success) {
          console.warn(`5F-2 dual-write failed at updateSalaryDeduction (${deductionId}):`,
                       r && r.error);
        }
        // Stage 5F-3: when name stabilizes (after the typing debounce),
        // attempt to promote the deduction to a real budget_categories row
        // for this month. Idempotent — no-op for empty names, no-op if
        // already promoted (Map lookup hit). Fires for investment-type
        // only (the helper guards on this).
        // Stage 5F-4: AFTER promotion completes, also upsert the salary_seed
        // transaction so monthly_entries.actual reflects the deduction amount.
        // Order matters: promote populates the bridge Map's monthlyEntryIdByMonth,
        // which upsertSalarySeedForDeduction reads.
        if (ded && monthKey) {
          await promoteDeductionToCategory(ded, monthKey);
          await upsertSalarySeedForDeduction(ded, monthKey);
        }
      }, 800);
      salaryDeductionFlushers.set(deductionId, flusher);
    }
    return flusher;
  }

  function ensureMonth(key) {
    if (!state.months[key]) {
      const keys    = Object.keys(state.months).sort();
      const priorKey = keys.filter(k => k < key).pop();
      const prior   = priorKey ? state.months[priorKey] : null;
      state.months[key] = defaultMonthData(prior);
    }
  }

  function initState() {
    state = loadState();
    if (!state) {
      state = {
        settings: { currency: 'USD', numberFormat: 'us', defaultTransactionDate: 'today' },
        months: {},
        salaryData: {},
      };
    }
    migrateState(state);
    ensureMonth(currentMonth);
    ensureSalaryMonth(currentMonth);
    saveState();
  }

  function ensureSalaryMonth(key) {
    if (!state.salaryData) state.salaryData = {};
    if (state.salaryData[key]) return;
    const keys     = Object.keys(state.salaryData).sort();
    const priorKey = keys.filter(k => k < key).pop();
    state.salaryData[key] = priorKey
      ? cloneSalaryData(state.salaryData[priorKey], 'inherited')
      : defaultSalaryData();
  }

  // Map DB section names → in-memory category keys. The DB uses snake_case
  // and treats `income` as just another section; the local model puts income
  // at the top level and camelCases `pretax_investments`.
  const API_SECTION_MAP = {
    income:             'income',
    fixed:              'fixed',
    variable:           'variable',
    recreational:       'recreational',
    savings:            'savings',
    debt:               'debt',
    pretax_investments: 'pretaxInvestments',
  };

  async function loadCategoriesFromApi() {
    if (!window.puntoApi || typeof window.puntoApi.getCategories !== 'function') {
      console.error('puntoApi.getCategories is not available');
      return [];
    }
    const result = await window.puntoApi.getCategories();
    if (!result || !result.success) {
      console.error('Failed to load categories from Supabase:', result && result.error);
      return [];
    }
    return result.data || [];
  }

  function applyApiCategoriesToMonth(rows, monthKey = currentMonth) {
    const md = state.months[monthKey];
    md.income = [];
    md.categories = {
      fixed:             [],
      variable:          [],
      recreational:      [],
      savings:           [],
      debt:              [],
      pretaxInvestments: [],
    };
    const sorted = (rows || []).slice().sort((a, b) =>
      (a.sort_order ?? 0) - (b.sort_order ?? 0)
    );
    for (const cat of sorted) {
      // Stage 5F-4 Part 1B: linked rows are synthesized at render time by
      // syncBudgetWithSalary, not loaded into md.categories. Including them
      // here would cause duplicates with the synthesized row. The server-
      // side row's identity lives in linkedBudgetCategoryIds (the bridge
      // Map); render code reads only the synthesized row.
      if (cat.is_linked === true) continue;
      const localSection = API_SECTION_MAP[cat.section];
      if (!localSection) continue;
      const row = newRow(cat.name || '', 0, cat.sort_order ?? 0);
      row.id = cat.id;
      // Stage 5F-1: propagate linked-row flags. Today nothing in the app
      // writes is_linked=true, so existing data loads as false/null —
      // matching prior behavior. 5F-3 will populate these for real.
      row.isLinked         = cat.is_linked === true;
      row.linkedDeductionId = cat.linked_deduction_id || null;
      if (localSection === 'savings') {
        row.subtype = SUBTYPES.includes(cat.subtype)
          ? cat.subtype
          : inferSubtype(cat.name);
      }
      if (localSection === 'income') md.income.push(row);
      else md.categories[localSection].push(row);
    }
  }

  async function loadMonthlyEntriesFromApi(monthKey) {
    if (!window.puntoApi || typeof window.puntoApi.getMonthlyEntries !== 'function') {
      console.warn('puntoApi.getMonthlyEntries is not available');
      return [];
    }
    const result = await window.puntoApi.getMonthlyEntries(monthKey);
    if (!result || !result.success) {
      console.warn('Failed to load monthly entries from Supabase:', result && result.error);
      return [];
    }
    return result.data || [];
  }

  // Apply monthly_entries rows from Supabase to the in-memory model for the
  // given month. Each entry is matched to a row by entry.category_id ↔ row.id
  // (which equals the Supabase category UUID for rows seeded from the API).
  // Skips entries without a matching row — defensive against deleted categories.
  function applyApiMonthlyEntriesToMonth(entries, monthKey) {
    const md = state.months?.[monthKey];
    if (!md) return;
    const byId = new Map();
    for (const row of md.income || []) byId.set(row.id, row);
    for (const list of Object.values(md.categories || {})) {
      for (const row of list || []) byId.set(row.id, row);
    }
    // Stage 5F-3: also build a reverse Map of budgetCategoryId → linkedEntry
    // so we can populate monthlyEntryIdByMonth for entries belonging to
    // linked (synthesized) rows whose in-memory id won't match category_id.
    const linkedByCategoryId = new Map();
    for (const linkedEntry of linkedBudgetCategoryIds.values()) {
      if (linkedEntry && linkedEntry.budgetCategoryId) {
        linkedByCategoryId.set(linkedEntry.budgetCategoryId, linkedEntry);
      }
    }
    for (const entry of entries || []) {
      const row = byId.get(entry.category_id);
      if (row) {
        row.expected = parseAmount(entry.expected);
        row.actual   = parseAmount(entry.actual);
        row.monthly_entry_id = entry.id;
        continue;
      }
      // No in-memory row matched — check if this entry belongs to a linked
      // budget_category we know about. If so, stash its monthly_entry_id
      // AND its actual into the bridge Map. Stage 5F-4 Part 1C: actualByMonth
      // is the source of truth for the synthesized row's Actual cell once
      // Part 6 flips the read path.
      const linkedEntry = linkedByCategoryId.get(entry.category_id);
      if (linkedEntry) {
        linkedEntry.monthlyEntryIdByMonth.set(monthKey, entry.id);
        linkedEntry.actualByMonth.set(monthKey, parseAmount(entry.actual));
      }
    }
  }

  // Ensure every in-memory row for the given month has a monthly_entry_id.
  // Categories with no monthly_entries row for this month get one inserted
  // and the returned id stamped back. Common case is a no-op fast path.
  // Best-effort: per-row failures are logged but don't throw — the writer in
  // 5C-3 can handle a still-missing id as a fallback if needed.
  async function ensureMonthlyEntriesExist(monthKey) {
    const md = state.months?.[monthKey];
    if (!md) return;
    const allRows = [
      ...(md.income || []),
      ...Object.values(md.categories || {}).flatMap(l => l || []),
    ];
    const missing = allRows.filter(r => r.id && !r.monthly_entry_id);
    if (missing.length === 0) return;
    if (!window.puntoApi || typeof window.puntoApi.insertMonthlyEntry !== 'function') {
      console.warn('puntoApi.insertMonthlyEntry is not available; skipping ensureMonthlyEntriesExist');
      return;
    }
    const results = await Promise.all(missing.map(row =>
      window.puntoApi.insertMonthlyEntry({
        category_id: row.id,
        month:       monthKey,
        expected:    parseAmount(row.expected || 0),
        actual:      parseAmount(row.actual   || 0),
      })
    ));
    for (let i = 0; i < missing.length; i++) {
      const row    = missing[i];
      const result = results[i];
      if (result && result.success && result.data && result.data.id) {
        row.monthly_entry_id = result.data.id;
      } else {
        console.warn(`Failed to ensure monthly_entry for row "${row.name || row.id}":`,
                     result && result.error);
      }
    }
    saveState();
  }

  // ============================================================
  // RECURRING ROWS (auto-carry expected values into fresh months)
  // ============================================================
  // A month is "fresh" when it has no monthly_entries or every entry is
  // zero/zero (the auto-created placeholders). On first visit to a fresh
  // month, expected values are seeded from the nearest prior month that
  // has any non-zero expected, then persisted: rows whose entry already
  // exists are updated in place; rows without one are inserted by
  // ensureMonthlyEntriesExist right after. Actuals always start at zero.
  // Best-effort: localStorage is authoritative; failures are logged.
  function monthIsFresh(entries) {
    return (entries || []).every(e =>
      parseAmount(e.expected) === 0 && parseAmount(e.actual) === 0
    );
  }

  async function seedExpectedFromPriorMonth(monthKey) {
    const md = state.months?.[monthKey];
    if (!md) return;
    if (!window.puntoApi || typeof window.puntoApi.getMonthlyEntries !== 'function') return;
    // Only seed the current or future months — browsing back to an old empty
    // month shouldn't fabricate budget history.
    if (monthKey < toMonthKey(new Date())) return;

    let [y, m] = monthKey.split('-').map(Number);
    for (let hop = 0; hop < 12; hop++) {
      m--;
      if (m === 0) { m = 12; y--; }
      const priorKey = `${y}-${String(m).padStart(2, '0')}`;
      const result   = await window.puntoApi.getMonthlyEntries(priorKey);
      const entries  = (result && result.success && result.data) || [];
      const nonZero  = entries.filter(e => parseAmount(e.expected) !== 0);
      if (nonZero.length === 0) continue;

      // Categories are global, so row.id matches entry.category_id across months.
      const byId = new Map();
      for (const row of md.income || []) byId.set(row.id, row);
      for (const list of Object.values(md.categories || {})) {
        for (const row of list || []) byId.set(row.id, row);
      }

      const updates = [];
      let seeded = 0;
      for (const entry of nonZero) {
        const row = byId.get(entry.category_id);
        if (!row) continue;
        row.expected = parseAmount(entry.expected);
        seeded++;
        if (row.monthly_entry_id) {
          updates.push(window.puntoApi.updateMonthlyEntry({
            id:       row.monthly_entry_id,
            expected: row.expected,
          }));
        }
      }

      if (seeded > 0) {
        saveState();
        if (updates.length > 0) {
          const results = await Promise.all(updates);
          for (const r of results) {
            if (!r || !r.success) console.warn('Recurring seed update failed:', r && r.error);
          }
        }
        const priorName = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long' });
        showToast(`Budget carried over from ${priorName}`);
      }
      return;
    }
  }

  // ============================================================
  // SALARY DUAL-WRITE (Stage 5F-2 + 5F-2.1 cleanup)
  // ============================================================
  // Make DB state for one month exactly match in-memory state. Idempotent:
  // soft-deletes any existing salary_deductions for the salary_record
  // BEFORE inserting the current set. Without the cleanup step, apply-
  // forward to a previously-visited month would duplicate deductions —
  // cloneSalaryData wipes salaryRecordId stamps, so old DB rows would
  // accumulate alongside fresh inserts.
  //
  // Best-effort: localStorage is authoritative; failures are logged.
  // Each deduction's client UUID is passed through to the INSERT so DOM
  // data-deduction-id attributes stay valid through the round-trip.
  // No caller today re-inserts deductions whose ids already exist in the
  // DB — 5F-3+ would need to revisit this if that changes (PK collision
  // risk on the freshly-inserted ids).
  async function dualWriteSalaryMonthToApi(monthKey) {
    const rec = state.salaryData?.[monthKey];
    if (!rec) return;
    if (!window.puntoApi || typeof window.puntoApi.upsertSalaryRecord !== 'function') {
      console.warn('5F-2 dual-write skipped: puntoApi.upsertSalaryRecord unavailable');
      return;
    }
    const recResult = await window.puntoApi.upsertSalaryRecord({
      monthKey,
      annualGross:  parseAmount(rec.annualGross),
      monthlyTaxes: parseAmount(rec.taxes),
      salarySource: rec.salarySource || 'manual',
    });
    if (!recResult || !recResult.success || !recResult.data) {
      console.warn(`5F-2 dual-write failed at upsertSalaryRecord (${monthKey}):`,
                   recResult && recResult.error);
      return;
    }
    rec.id = recResult.data.id;
    const recordId = recResult.data.id;

    // Stage 5F-2.1: batch-soft-delete every existing deduction for this
    // salary_record. One PATCH regardless of N. Initial-month case is a
    // no-op (no existing rows match). Proceed even if cleanup fails —
    // worst case is duplicates, which is recoverable; better than aborting
    // the upsert and leaving the month with no deductions at all.
    if (typeof window.puntoApi.softDeleteSalaryDeductionsForRecord === 'function') {
      const cleanupResult = await window.puntoApi.softDeleteSalaryDeductionsForRecord(recordId);
      if (!cleanupResult || !cleanupResult.success) {
        console.warn(`5F-2.1 cleanup failed at softDeleteSalaryDeductionsForRecord (${monthKey}):`,
                     cleanupResult && cleanupResult.error);
      }
    }

    // Insert all current in-memory deductions as fresh DB rows. No longer
    // filters by `!d.salaryRecordId` — the cleanup above means any prior
    // DB state is gone, so we want to insert everything in-memory.
    const deductions = rec.deductions || [];
    if (deductions.length === 0) return;
    const results = await Promise.all(deductions.map((d, idx) =>
      window.puntoApi.insertSalaryDeduction({
        id:             d.id,                  // pass client UUID
        salaryRecordId: recordId,
        name:           d.name,
        amount:         parseAmount(d.amount),
        deductionType:  d.type || 'investment',
        sortOrder:      idx,
      })
    ));
    for (let i = 0; i < deductions.length; i++) {
      const d = deductions[i];
      const r = results[i];
      if (r && r.success && r.data && r.data.id) {
        d.salaryRecordId = recordId;
        // d.id stays the same (we passed it in)
      } else {
        console.warn(`5F-2.1 dual-write failed at insertSalaryDeduction (${d.name}):`,
                     r && r.error);
      }
    }

    // Stage 5F-3 (Part B): for each investment-type deduction, ensure a
    // real budget_categories row exists (spanning across months — one per
    // user per name) AND a monthly_entries row for THIS month. Idempotent.
    // Parallel across deductions; per-deduction the helper is sequential
    // (insertBudgetCategory → insertMonthlyEntry).
    await Promise.all(
      deductions.map(d => promoteDeductionToCategory(d, monthKey))
    );
    // Stage 5F-4 Part 3: write/update salary_seed transactions for each
    // promoted deduction. Order matters — promote must complete first so
    // monthlyEntryIdByMonth is populated. Parallel across deductions.
    await Promise.all(
      deductions.map(d => upsertSalarySeedForDeduction(d, monthKey))
    );
    // Stage 5F-4 Part 4: also seed the take-home salary_seed on the income
    // Salary row for this month. No-op if the Salary row's monthly_entry_id
    // isn't yet stamped (warn-and-skip inside the helper).
    await upsertTakeHomeSalarySeed(monthKey);
  }

  // After applyApiSalaryToMonth runs, the in-memory record either has a
  // .id (DB had a row) or doesn't (DB had nothing — applyApiSalaryToMonth
  // early-returned, leaving the ensureSalaryMonth skeleton). In the latter
  // case, fire the dual-write to push the skeleton up.
  async function ensureSalaryRecordExists(monthKey) {
    const rec = state.salaryData?.[monthKey];
    if (!rec) return;
    if (rec.id) return;  // DB already has it
    await dualWriteSalaryMonthToApi(monthKey);
  }

  // ============================================================
  // LINKED-CATEGORY PROMOTION (Stage 5F-3)
  // ============================================================
  // Boot-time: load every is_linked=true budget_category into the bridge
  // Map. budget_categories is spanning (one row per user per name) so the
  // hydration is independent of which month the user lands on. Without
  // this, navigating to an unvisited month and adding a deduction whose
  // name matches an existing-elsewhere linked category would create a
  // duplicate budget_categories row.
  async function hydrateLinkedBudgetCategoryIds() {
    if (!window.puntoApi || typeof window.puntoApi.listLinkedBudgetCategories !== 'function') {
      console.warn('5F-3 hydration skipped: puntoApi.listLinkedBudgetCategories unavailable');
      return;
    }
    const result = await window.puntoApi.listLinkedBudgetCategories();
    if (!result || !result.success) {
      console.warn('5F-3 hydration failed at listLinkedBudgetCategories:', result && result.error);
      return;
    }
    for (const row of (result.data || [])) {
      const key = normalizeDeductionName(row.name);
      if (!key) continue;
      if (!linkedBudgetCategoryIds.has(key)) {
        linkedBudgetCategoryIds.set(key, {
          budgetCategoryId:       row.id,
          monthlyEntryIdByMonth:  new Map(),
          actualByMonth:          new Map(),
          salarySeedTxnIdByMonth: new Map(),
        });
      }
    }
  }

  // Promote an investment-type salary deduction to a real budget_categories
  // row (if not already present) AND ensure a monthly_entries row exists
  // for the given month. Idempotent: safe to call repeatedly. Updates
  // linkedBudgetCategoryIds in place. Best-effort: failures are logged.
  //
  // Does NOT touch the synthesized row in md.categories.pretaxInvestments.
  // The synthesized row keeps its disposable client UUID forever; this
  // helper produces the parallel server-side identity that 5F-4 will use
  // to write salary_seed transactions.
  async function promoteDeductionToCategory(deduction, monthKey) {
    if (!deduction) return;
    if ((deduction.type || 'investment') !== 'investment') return; // expense-type stays Salary-only
    const name = (deduction.name || '').trim();
    if (!name) return;  // empty name — wait for the user to type something
    const key = normalizeDeductionName(name);
    if (!window.puntoApi) return;

    let entry = linkedBudgetCategoryIds.get(key);

    if (!entry) {
      // No existing budget_category for this name — INSERT one.
      if (typeof window.puntoApi.insertBudgetCategory !== 'function') return;
      // Compute sort_order from the current month's pretaxInvestments list
      // so the new row sits at the end of that section visually. Other
      // months' lists may have different lengths; this is best-effort.
      const md = state.months?.[monthKey];
      const list = md?.categories?.pretaxInvestments || [];
      const nextOrder = list.reduce((m, r) => Math.max(m, r.order ?? 0), -1) + 1;
      const result = await window.puntoApi.insertBudgetCategory({
        name,
        section:             'pretaxInvestments',
        subtype:             null,
        sort_order:          nextOrder,
        is_linked:           true,
        linked_deduction_id: null,  // see architectural note in 5F-3 prompt
      });
      if (!result || !result.success || !result.data || !result.data.id) {
        console.error('5F-3 promote failed at insertBudgetCategory for deduction:',
                      deduction.id, name, result && result.error);
        return;
      }
      entry = {
        budgetCategoryId:       result.data.id,
        monthlyEntryIdByMonth:  new Map(),
        actualByMonth:          new Map(),
        salarySeedTxnIdByMonth: new Map(),
      };
      linkedBudgetCategoryIds.set(key, entry);
    }

    // Ensure a monthly_entries row for this month. Skip if we already
    // tracked one (from boot hydration or a prior call).
    if (entry.monthlyEntryIdByMonth.has(monthKey)) return;
    if (typeof window.puntoApi.insertMonthlyEntry !== 'function') return;
    const meResult = await window.puntoApi.insertMonthlyEntry({
      category_id: entry.budgetCategoryId,
      month:       monthKey,
      expected:    0,
      actual:      0,
    });
    if (meResult && meResult.success && meResult.data && meResult.data.id) {
      entry.monthlyEntryIdByMonth.set(monthKey, meResult.data.id);
    } else {
      console.warn(`5F-3 promote: monthly_entries insert failed for "${name}" / ${monthKey}:`,
                   meResult && meResult.error);
    }
  }

  // Stage 5F-4 Part 3: ensure there's a salary_seed transaction for this
  // (deduction, month) with the right amount. Update-in-place model: first
  // call inserts and caches the txn id in salarySeedTxnIdByMonth; subsequent
  // calls UPDATE the cached row. Optimistically updates actualByMonth so the
  // next render reflects the new value without a round-trip.
  //
  // Requires promoteDeductionToCategory to have run first (the bridge entry
  // and its monthlyEntryIdByMonth must be populated). Investment-type only.
  async function upsertSalarySeedForDeduction(deduction, monthKey) {
    if (!deduction || !monthKey) return;
    if ((deduction.type || 'investment') !== 'investment') return;
    const name = (deduction.name || '').trim();
    if (!name) return;
    if (!window.puntoApi) return;
    const key = normalizeDeductionName(name);
    const entry = linkedBudgetCategoryIds.get(key);
    if (!entry) {
      console.warn(`5F-4 upsertSalarySeed: no bridge entry for "${name}"`);
      return;
    }
    const monthlyEntryId = entry.monthlyEntryIdByMonth.get(monthKey);
    if (!monthlyEntryId) {
      console.warn(`5F-4 upsertSalarySeed: no monthly_entry for "${name}" / ${monthKey}`);
      return;
    }
    const amount = parseAmount(deduction.amount);
    const cachedTxnId = entry.salarySeedTxnIdByMonth.get(monthKey);

    if (cachedTxnId) {
      if (typeof window.puntoApi.updateSalarySeedTransaction !== 'function') return;
      const r = await window.puntoApi.updateSalarySeedTransaction(cachedTxnId, { amount });
      if (!r || !r.success) {
        console.warn(`5F-4 updateSalarySeed failed for "${name}" / ${monthKey}:`,
                     r && r.error);
      }
    } else {
      if (typeof window.puntoApi.insertSalarySeedTransaction !== 'function') return;
      const r = await window.puntoApi.insertSalarySeedTransaction({
        monthly_entry_id: monthlyEntryId,
        amount,
        source_id:        deduction.id,
      });
      if (r && r.success && r.data && r.data.id) {
        entry.salarySeedTxnIdByMonth.set(monthKey, r.data.id);
      } else {
        console.warn(`5F-4 insertSalarySeed failed for "${name}" / ${monthKey}:`,
                     r && r.error);
      }
    }

    // Optimistic update — render reflects new amount without waiting for
    // the next applyApiMonthlyEntriesToMonth round-trip.
    entry.actualByMonth.set(monthKey, amount);
  }

  // Stage 5F-4 Part 4: ensure there's a salary_seed transaction on the
  // income Salary row for this month, amount = computeTakeHome(rec). Same
  // update-in-place model as the deduction seed. The Salary row's
  // monthly_entry_id must already be stamped (5C-2 precreate); if missing
  // we warn-and-skip. source_id references salary_records.id (so
  // listTakeHomeSalarySeeds can be distinguished from deduction seeds via
  // the join on budget_categories.section='income').
  async function upsertTakeHomeSalarySeed(monthKey) {
    if (!monthKey) return;
    if (!window.puntoApi) return;
    const md = state.months?.[monthKey];
    if (!md) return;
    const salaryRow = (md.income || []).find(r =>
      (r.name || '').trim().toLowerCase() === 'salary'
    );
    if (!salaryRow || !salaryRow.monthly_entry_id) {
      console.warn(`5F-4 take-home: no monthly_entry_id for Salary row in ${monthKey}`);
      return;
    }
    const rec = state.salaryData?.[monthKey];
    if (!rec || !rec.id) return;
    const amount = parseAmount(computeTakeHome(rec));
    const cachedTxnId = takeHomeSalarySeedTxnIdByMonth.get(monthKey);

    if (cachedTxnId) {
      if (typeof window.puntoApi.updateSalarySeedTransaction !== 'function') return;
      const r = await window.puntoApi.updateSalarySeedTransaction(cachedTxnId, { amount });
      if (!r || !r.success) {
        console.warn(`5F-4 updateTakeHome failed for ${monthKey}:`, r && r.error);
      }
    } else {
      if (typeof window.puntoApi.insertSalarySeedTransaction !== 'function') return;
      const r = await window.puntoApi.insertSalarySeedTransaction({
        monthly_entry_id: salaryRow.monthly_entry_id,
        amount,
        source_id:        rec.id,
      });
      if (r && r.success && r.data && r.data.id) {
        takeHomeSalarySeedTxnIdByMonth.set(monthKey, r.data.id);
      } else {
        console.warn(`5F-4 insertTakeHome failed for ${monthKey}:`, r && r.error);
      }
    }

    // Optimistic update — render reflects new take-home immediately.
    salaryRow.actual = amount;
  }

  async function hydrateTakeHomeSalarySeedIds() {
    if (!window.puntoApi || typeof window.puntoApi.listTakeHomeSalarySeeds !== 'function') {
      console.warn('5F-4 hydration skipped: puntoApi.listTakeHomeSalarySeeds unavailable');
      return;
    }
    const result = await window.puntoApi.listTakeHomeSalarySeeds();
    if (!result || !result.success || !Array.isArray(result.data)) {
      console.warn('5F-4 hydration failed at listTakeHomeSalarySeeds:', result && result.error);
      return;
    }
    for (const row of result.data) {
      if (row && row.month && row.txn_id) {
        takeHomeSalarySeedTxnIdByMonth.set(row.month, row.txn_id);
      }
    }
  }

  // Two sequential API calls: salary_records (one row per user per month, may
  // be null for new users) and — only when a record exists — its deductions.
  // Returns { record, deductions } in raw snake_case shape; the applier maps
  // field names (monthly_taxes → taxes, deduction_type → type).
  async function loadSalaryFromApi(monthKey) {
    if (!window.puntoApi || typeof window.puntoApi.getSalaryRecord !== 'function') {
      console.warn('puntoApi.getSalaryRecord is not available');
      return { record: null, deductions: [] };
    }
    const recResult = await window.puntoApi.getSalaryRecord(monthKey);
    if (!recResult || !recResult.success) {
      console.warn('Failed to load salary record from Supabase:', recResult && recResult.error);
      return { record: null, deductions: [] };
    }
    const record = recResult.data;
    if (!record) return { record: null, deductions: [] };
    if (typeof window.puntoApi.getSalaryDeductions !== 'function') {
      console.warn('puntoApi.getSalaryDeductions is not available');
      return { record, deductions: [] };
    }
    const dedResult = await window.puntoApi.getSalaryDeductions(record.id);
    if (!dedResult || !dedResult.success) {
      console.warn('Failed to load salary deductions from Supabase:', dedResult && dedResult.error);
      return { record, deductions: [] };
    }
    return { record, deductions: dedResult.data || [] };
  }

  // Replace state.salaryData[monthKey] with a freshly-built record from the
  // API. When record is null, leave the existing (defaultSalaryData) skeleton
  // alone so the renderer keeps working for new users.
  function applyApiSalaryToMonth({ record, deductions }, monthKey) {
    if (!record) return;
    if (!state.salaryData) state.salaryData = {};
    state.salaryData[monthKey] = {
      id:           record.id,
      annualGross:  parseAmount(record.annual_gross),
      taxes:        parseAmount(record.monthly_taxes),
      salarySource: record.salary_source,
      deductions: (deductions || []).map(d => ({
        id:             d.id,
        salaryRecordId: record.id,
        name:           d.name,
        amount:         parseAmount(d.amount),
        type:           d.deduction_type,
      })),
    };
  }

  async function loadAdjustmentsFromApi(monthKey) {
    if (!window.puntoApi || typeof window.puntoApi.getAdjustments !== 'function') {
      console.warn('puntoApi.getAdjustments is not available');
      return [];
    }
    const result = await window.puntoApi.getAdjustments(monthKey);
    if (!result || !result.success) {
      console.warn('Failed to load adjustments from Supabase:', result && result.error);
      return [];
    }
    return result.data || [];
  }

  // Replace each row's adjustments[] with the API's adjustments for that
  // category, routed via entry.category_id ↔ row.id. Drops category_id and
  // month from the stored shape — the row owns the linkage by containment,
  // and the per-month state already scopes by month. Idempotent: every row
  // gets a fresh array (or [] if there are no matching adjustments).
  function applyApiAdjustmentsToMonth(adjustments, monthKey) {
    const md = state.months?.[monthKey];
    if (!md) return;
    const byCategoryId = new Map();
    for (const a of adjustments || []) {
      const slim = { id: a.id, amount: parseAmount(a.amount), note: a.note };
      const list = byCategoryId.get(a.category_id);
      if (list) list.push(slim);
      else byCategoryId.set(a.category_id, [slim]);
    }
    const allRows = [
      ...(md.income || []),
      ...Object.values(md.categories || {}).flatMap(l => l || []),
    ];
    for (const row of allRows) {
      row.adjustments = byCategoryId.get(row.id) || [];
    }
  }

  async function loadTransactionsFromApi(monthKey) {
    if (!window.puntoApi || typeof window.puntoApi.getTransactions !== 'function') {
      console.warn('puntoApi.getTransactions is not available');
      return [];
    }
    const result = await window.puntoApi.getTransactions(monthKey);
    if (!result || !result.success) {
      console.warn('Failed to load transactions from Supabase:', result && result.error);
      return [];
    }
    return result.data || [];
  }

  // Replace each row's transactions[] with the API's transactions for that
  // category. Transactions FK to monthly_entries.id, but in-memory rows are
  // keyed by budget_categories.id (row.id), so we bridge via the joined
  // monthly_entries.category_id selected in the loader. Idempotent: every
  // row gets a fresh array (or [] if there are no matching transactions).
  function applyApiTransactionsToMonth(apiTransactions, monthKey) {
    const md = state.months?.[monthKey];
    if (!md) return;
    const byCategoryId = new Map();
    for (const txn of apiTransactions || []) {
      const parent = txn.monthly_entries;
      const categoryId = parent && parent.category_id;
      if (!categoryId) continue;
      const list = byCategoryId.get(categoryId);
      if (list) list.push(txn);
      else byCategoryId.set(categoryId, [txn]);
    }
    const allRows = [
      ...(md.income || []),
      ...Object.values(md.categories || {}).flatMap(l => l || []),
    ];
    for (const row of allRows) {
      if (!row.id) continue;
      const dbTxns = byCategoryId.get(row.id) || [];
      row.transactions = dbTxns.map(t => ({
        id:               t.id,
        date:             t.transaction_date || '',
        amount:           parseAmount(t.amount),
        note:             t.description || '',
        monthly_entry_id: t.monthly_entry_id,
        transaction_type: t.transaction_type || 'manual',
        source_id:        t.source_id || null,
      }));
    }
  }

  function showLoadingOverlay() {
    const el = document.getElementById('app-loading-overlay');
    if (el) {
      el.hidden = false;
      el.setAttribute('aria-hidden', 'false');
    }
  }

  function hideLoadingOverlay() {
    const el = document.getElementById('app-loading-overlay');
    if (el) {
      el.hidden = true;
      el.setAttribute('aria-hidden', 'true');
    }
  }

  // ============================================================
  // FORMATTING
  // ============================================================
  function formatCurrency(amount) {
    const { currency, numberFormat } = state.settings;
    const sym    = CURRENCY_SYMBOLS[currency] ?? '$';
    const locale = numberFormat === 'eu' ? 'de-DE' : 'en-US';
    const digits = MOBILE_MQL.matches ? 0 : 2;
    const formatted = Math.abs(amount).toLocaleString(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    return (amount < 0 ? '-' : '') + sym + formatted;
  }

  function parseAmount(val) {
    const n = parseFloat(String(val).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function getDefaultDate() {
    if (state.settings.defaultTransactionDate === 'first') {
      const [y, m] = currentMonth.split('-');
      return `${y}-${m}-01`;
    }
    return new Date().toISOString().slice(0, 10);
  }

  // ============================================================
  // CALCULATIONS
  // ============================================================
  function sumTransactions(row) {
    return (row.transactions || []).reduce((acc, t) => acc + parseAmount(t.amount), 0);
  }

  function sumAdjustments(row) {
    return (row.adjustments || []).reduce((acc, a) => acc + parseAmount(a.amount), 0);
  }

  // Linked savings/fixed rows: Actual = row.actual (DB-trigger-computed from
  // salary_seed transactions) + sum of adjustments, with fallback to the
  // legacy linked-expected compute when row.actual isn't yet hydrated.
  // All other rows (including the linked income row): prefer row.actual
  // when set by the API; otherwise fall back to summing the row's
  // transactions.
  function getActual(row, section, monthKey = currentMonth) {
    if (isLinkedAdjustableRow(row, section, monthKey)) {
      // Stage 5F-4 Part 6: prefer DB-trigger-computed row.actual (which sums
      // the salary_seed transaction). Adjustments still live in row.adjustments
      // (separate from the transactions table — Stage 5G migrates them), so
      // they need to be added on top.
      // Fallback when row.actual isn't populated yet: legacy compute via
      // getLinkedExpected. This covers (a) initial render before the
      // applier runs, (b) rows that haven't been promoted yet, (c) post-5H
      // migration data.
      if (typeof row.actual === 'number' && !isNaN(row.actual)) {
        return parseAmount(row.actual) + sumAdjustments(row);
      }
      return getLinkedExpected(row, section, monthKey) + sumAdjustments(row);
    }
    if (typeof row.actual === 'number' && !isNaN(row.actual)) {
      return parseAmount(row.actual);
    }
    return sumTransactions(row);
  }

  // Linked rows that use the adjustments mechanism (Pre-Tax Investments only).
  // The income Salary row is linked but keeps editable transactions per stage 2.
  function isLinkedAdjustableRow(row, section, monthKey = currentMonth) {
    if (section !== 'pretaxInvestments') return false;
    return isLinkedRow(row, section, monthKey);
  }

  function sumListExpected(list) {
    return list.reduce((acc, r) => acc + parseAmount(r.expected), 0);
  }

  function sumListActual(list) {
    return list.reduce((acc, r) => {
      if (typeof r.actual === 'number' && !isNaN(r.actual)) {
        return acc + parseAmount(r.actual);
      }
      return acc + sumTransactions(r);
    }, 0);
  }

  function computeSummary(monthData, monthKey = currentMonth) {
    const salaryActive = isSalaryActive(monthKey);
    const takeHome     = getSalaryTakeHomeForMonth(monthKey);

    const incomeExp = monthData.income.reduce((acc, r) =>
      acc + getEffectiveExpected(r, 'income', monthKey), 0);
    const incomeAct = sumListActual(monthData.income);

    const cats             = monthData.categories;
    const fixedRows        = cats.fixed             || [];
    const variableRows     = cats.variable          || [];
    const recreationalRows = cats.recreational      || [];
    const savRows          = cats.savings           || [];
    const debtRows         = cats.debt              || [];
    const pretaxRows       = cats.pretaxInvestments || [];

    // Savings & Investments and the expense sections are post-tax only now —
    // every row's expected/actual comes from user input, no linked deductions.
    const fixedExp        = sumListExpected(fixedRows);
    const variableExp     = sumListExpected(variableRows);
    const recreationalExp = sumListExpected(recreationalRows);
    const savExp          = sumListExpected(savRows);
    const debtExp         = sumListExpected(debtRows);

    const fixedAct        = sumListActual(fixedRows);
    const variableAct     = sumListActual(variableRows);
    const recreationalAct = sumListActual(recreationalRows);
    const savAct          = sumListActual(savRows);
    const debtAct         = sumListActual(debtRows);

    // SAVINGS / INVESTMENTS subtype-based actual sums (Savings & Investments).
    // Per-row, prefer row.actual when set by the API; otherwise sum transactions.
    const savingsBySubtype = (subtype) => savRows.reduce((acc, r) => {
      if (getRowSubtype(r, 'savings', monthKey) !== subtype) return acc;
      if (typeof r.actual === 'number' && !isNaN(r.actual)) {
        return acc + parseAmount(r.actual);
      }
      return acc + sumTransactions(r);
    }, 0);
    const savingsActSubtype     = savingsBySubtype('savings');
    const investmentsActSubtype = savingsBySubtype('investment');

    // Pre-Tax Investments: actual = linked Expected + adjustments. Display-only
    // section — completely excluded from UNALLOCATED and NET subtractions.
    const pretaxAct = pretaxRows.reduce((acc, r) =>
      acc + getActual(r, 'pretaxInvestments', monthKey), 0);

    const expensesExp = fixedExp + variableExp + recreationalExp;
    const expensesAct = fixedAct + variableAct + recreationalAct;
    // Debt paydown allocates income (zero-based budgeting) but is tracked
    // separately from expenses — like savings, it's balance-sheet money.
    const allocatedExp = expensesExp + savExp + debtExp;

    // UNALLOCATED — Take-Home (or manual income fallback) minus all post-tax
    // expected. Pre-Tax Investments are NOT subtracted: that money is already
    // deducted from gross before take-home is computed.
    const baseIncome  = salaryActive ? takeHome : incomeExp;
    const incomeBasis = Math.max(baseIncome, incomeAct);
    const unallocated = incomeBasis - allocatedExp;

    // NET — Take-Home (or manual income fallback) minus post-tax actuals.
    // Pre-Tax Investments are NOT subtracted (already in take-home).
    const netActual = incomeBasis - expensesAct - savAct - debtAct;

    return {
      incomeExpected:     incomeExp,
      incomeActual:       incomeAct,
      incomeBasis:        incomeBasis,
      expensesExpected:   expensesExp,
      expensesActual:     expensesAct,
      savingsExpected:    savExp,
      savingsExpectedAll: savExp,
      savingsActual:      savingsActSubtype,                  // SAVINGS tile
      investmentsActual:  investmentsActSubtype + pretaxAct,  // INVESTMENTS tile (post-tax + pre-tax)
      debtExpected:       debtExp,
      debtActual:         debtAct,
      allocatedExpected:  allocatedExp,
      unallocated:        unallocated,
      netExpected:        incomeExp - allocatedExp,
      netActual:          netActual,
    };
  }

  // ============================================================
  // SALARY ↔ BUDGET LINKING
  // ============================================================
  const SALARY_INCOME_LABEL = 'Salary';
  // Pre-tax investment deductions populate the Pre-Tax Investments section.
  // Pre-tax expense deductions live ONLY on the Salary tab — no Budget row.
  const LINKED_SECTION_BY_TYPE = { investment: 'pretaxInvestments' };
  const TYPE_BY_LINKED_SECTION = { pretaxInvestments: 'investment' };

  function getSalaryDeductionsForMonth(monthKey) {
    return state.salaryData?.[monthKey]?.deductions || [];
  }

  function getSalaryTakeHomeForMonth(monthKey) {
    const rec = state.salaryData?.[monthKey];
    if (!rec) return 0;
    return computeTakeHome(rec);
  }

  // Salary linking only applies when there's positive take-home — otherwise we
  // fall back to manual income on the Budget page (per spec).
  function isSalaryActive(monthKey = currentMonth) {
    return getSalaryTakeHomeForMonth(monthKey) > 0;
  }

  function findSalaryDeductionByName(name, monthKey, requiredType = null) {
    const trimmed = (name || '').trim();
    if (!trimmed) return null;
    const matches = getSalaryDeductionsForMonth(monthKey)
      .filter(d => (d.name || '').trim() === trimmed);
    if (matches.length === 0) return null;
    if (requiredType) {
      return matches.find(d => normalizeDeductionType(d.type, d.name) === requiredType) || null;
    }
    return matches[0];
  }

  function isLinkedIncomeRow(row) {
    return (row?.name || '').trim() === SALARY_INCOME_LABEL;
  }

  function getLinkedExpected(row, section, monthKey = currentMonth) {
    if (!row) return null;
    if (!isSalaryActive(monthKey)) return null;
    if (section === 'income' && isLinkedIncomeRow(row)) {
      return getSalaryTakeHomeForMonth(monthKey);
    }
    const requiredType = TYPE_BY_LINKED_SECTION[section];
    if (requiredType) {
      const ded = findSalaryDeductionByName(row.name, monthKey, requiredType);
      if (ded) return parseAmount(ded.amount);
    }
    return null;
  }

  function getEffectiveExpected(row, section, monthKey = currentMonth) {
    const linked = getLinkedExpected(row, section, monthKey);
    return linked !== null ? linked : parseAmount(row.expected);
  }

  function isLinkedRow(row, section, monthKey = currentMonth) {
    return getLinkedExpected(row, section, monthKey) !== null;
  }

  // Subtype only applies to rows in the Savings & Investments section,
  // which is post-tax-only — every row is user-owned.
  function getRowSubtype(row, section, monthKey = currentMonth) {
    if (section !== 'savings' || !row) return null;
    return normalizeSubtype(row.subtype, row.name);
  }

  // Sync the budget against the salary deductions for the given month.
  // - Investment deductions back linked rows in the Pre-Tax Investments section.
  // - Expense deductions are NOT rendered on the Budget page at all — they
  //   live only on the Salary tab.
  // - Auto-creates rows for new investment deductions, removes rows whose
  //   deduction was removed or whose type was changed to expense.
  // - Migrates any legacy linked rows still living in savings/fixed: investment
  //   ones move to Pre-Tax Investments (preserving their adjustments); expense
  //   ones are dropped from the Budget page entirely.
  function syncBudgetWithSalary(monthKey) {
    const md = state.months?.[monthKey];
    if (!md) return;
    if (!md.categories) md.categories = {};
    if (!md.categories.savings)           md.categories.savings           = [];
    if (!md.categories.fixed)             md.categories.fixed             = [];
    if (!md.categories.debt)              md.categories.debt              = [];
    if (!md.categories.pretaxInvestments) md.categories.pretaxInvestments = [];

    const allDeductions = isSalaryActive(monthKey)
      ? getSalaryDeductionsForMonth(monthKey).filter(d => (d.name || '').trim() !== '')
      : [];
    const investmentDeductions = allDeductions.filter(
      d => normalizeDeductionType(d.type, d.name) === 'investment'
    );
    const investmentNames = new Set(
      investmentDeductions.map(d => (d.name || '').trim())
    );

    // Migration: any legacy linked rows in savings/fixed need to leave those
    // sections (they're now post-tax-only). Investment-matching rows move to
    // pretaxInvestments to preserve adjustments; everything else is dropped.
    const relocateOut = (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const row = list[i];
        if (!row.linkedToSalary) continue;
        list.splice(i, 1);
        const name = (row.name || '').trim();
        if (investmentNames.has(name) &&
            !md.categories.pretaxInvestments.some(p => (p.name || '').trim() === name)) {
          md.categories.pretaxInvestments.push(row);
        }
      }
    };
    relocateOut(md.categories.savings);
    relocateOut(md.categories.fixed);

    syncSectionWithDeductions(md.categories.pretaxInvestments, investmentDeductions, monthKey);
  }

  function syncSectionWithDeductions(list, deductions, monthKey = currentMonth) {
    const dedNames = new Set(deductions.map(d => (d.name || '').trim()));

    // Remove orphaned linked rows (flag set, no matching deduction in this section).
    for (let i = list.length - 1; i >= 0; i--) {
      const row = list[i];
      if (row.linkedToSalary && !dedNames.has((row.name || '').trim())) {
        list.splice(i, 1);
      }
    }

    // Stage 5F-4 Part 1D: helper to stamp row.actual + row.monthly_entry_id
    // from the bridge Map. Called for both newly-synthesized rows and existing
    // rows being re-flagged on re-render. Without this, the synthesized row's
    // Actual stays at undefined and getActual's row.actual branch (post-Part 6)
    // can't fire.
    const hydrateFromBridge = (row, dedName) => {
      const bridgeEntry = linkedBudgetCategoryIds.get(normalizeDeductionName(dedName));
      if (!bridgeEntry) return;
      const actual = bridgeEntry.actualByMonth.get(monthKey);
      if (typeof actual === 'number') row.actual = actual;
      const entryId = bridgeEntry.monthlyEntryIdByMonth.get(monthKey);
      if (entryId) row.monthly_entry_id = entryId;
    };

    // Ensure every deduction has a matching row in this section; flag matches as linked.
    for (const ded of deductions) {
      const dedName = (ded.name || '').trim();
      const existing = list.find(r => (r.name || '').trim() === dedName);
      if (!existing) {
        const nextOrder = list.reduce((m, r) => Math.max(m, r.order ?? 0), -1) + 1;
        const newR = newRow(ded.name, parseAmount(ded.amount), nextOrder);
        newR.linkedToSalary = true;
        hydrateFromBridge(newR, dedName);
        list.push(newR);
      } else {
        if (!existing.linkedToSalary) existing.linkedToSalary = true;
        // Re-hydrate every render so mid-session promotions reach the row.
        hydrateFromBridge(existing, dedName);
      }
    }
  }

  // Display order for sections that may contain linked rows: linked rows first
  // (in deduction-list order), then unlinked rows (in their stored order).
  function sortLinkedRows(list, monthKey, section) {
    const requiredType = TYPE_BY_LINKED_SECTION[section];
    const deductions = (requiredType && isSalaryActive(monthKey))
      ? getSalaryDeductionsForMonth(monthKey)
          .filter(d => normalizeDeductionType(d.type, d.name) === requiredType)
      : [];
    const dedOrder = new Map();
    deductions.forEach((d, i) => {
      const n = (d.name || '').trim();
      if (n && !dedOrder.has(n)) dedOrder.set(n, i);
    });

    const linked = [];
    const unlinked = [];
    for (const row of list) {
      const n = (row.name || '').trim();
      if (dedOrder.has(n)) linked.push(row);
      else unlinked.push(row);
    }
    linked.sort((a, b) =>
      dedOrder.get((a.name || '').trim()) - dedOrder.get((b.name || '').trim())
    );
    unlinked.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return [...linked, ...unlinked];
  }

  // ============================================================
  // VARIANCE HELPERS
  // ============================================================
  function formatVariance(expected, actual, section) {
    const diff = actual - expected;
    if (diff === 0) return { text: formatCurrency(0), className: 'variance-neutral' };
    const isOver     = diff > 0;
    const overIsGood = section === 'income' || section === 'savings' || section === 'debt';
    const className  = (overIsGood === isOver) ? 'variance-good' : 'variance-bad';
    const magnitude  = formatCurrency(Math.abs(diff));
    const text       = isOver ? magnitude : `(${magnitude})`;
    return { text, className };
  }

  // ============================================================
  // DOM HELPERS
  // ============================================================
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') node.className = v;
      else if (k === 'textContent') node.textContent = v;
      else if (k.startsWith('data-')) node.setAttribute(k, v);
      else node.setAttribute(k, v);
    }
    for (const child of children) {
      if (child == null) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  // ============================================================
  // DATA LOOKUP
  // ============================================================
  function getRowList(section) {
    const md = state.months[currentMonth];
    return section === 'income' ? md.income : md.categories[section];
  }

  function findRow(section, id) {
    return getRowList(section)?.find(r => r.id === id);
  }

  // ============================================================
  // UNDO / REDO
  // ============================================================
  function _pushEntry(description, snapshot) {
    undoStack.push({ description, snapshot });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
  }

  // Commit a deferred add-row undo entry using the row's current name.
  // Called automatically before any other undoable action, and on undo/redo.
  function flushPendingAddRow() {
    if (!pendingAddRow) return;
    const { rowId, section, snapshot } = pendingAddRow;
    pendingAddRow = null;
    const md   = state.months[currentMonth];
    const list = section === 'income' ? md?.income : md?.categories?.[section];
    const row  = list?.find(r => r.id === rowId);
    _pushEntry(`add row '${row?.name || ''}'`, snapshot);
  }

  function pushUndo(description, snapshot = null) {
    flushPendingAddRow();
    _pushEntry(description, snapshot ?? JSON.parse(JSON.stringify(state)));
  }

  function applyUndo() {
    flushPendingAddRow(); // commit pending add then immediately undo it
    flushSalaryEditSession();
    if (undoStack.length === 0) { showToast('Nothing to undo'); return; }
    const { description, snapshot } = undoStack.pop();
    redoStack.push({ description, snapshot: JSON.parse(JSON.stringify(state)) });
    state = snapshot;
    if (!state.months[currentMonth]) ensureMonth(currentMonth);
    if (!state.salaryData?.[currentMonth]) ensureSalaryMonth(currentMonth);
    renderAll();
    debouncedSave();
    showToast(`Undid: ${description}`);
  }

  function applyRedo() {
    flushPendingAddRow();
    flushSalaryEditSession();
    if (redoStack.length === 0) { showToast('Nothing to redo'); return; }
    const { description, snapshot } = redoStack.pop();
    undoStack.push({ description, snapshot: JSON.parse(JSON.stringify(state)) });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    state = snapshot;
    if (!state.months[currentMonth]) ensureMonth(currentMonth);
    if (!state.salaryData?.[currentMonth]) ensureSalaryMonth(currentMonth);
    renderAll();
    debouncedSave();
    showToast(`Redid: ${description}`);
  }

  function showToast(message) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.classList.remove('toast-visible');
    void toastEl.offsetWidth; // force reflow to restart transition
    toastEl.classList.add('toast-visible');
    toastTimer = setTimeout(() => toastEl.classList.remove('toast-visible'), 2000);
  }

  // ============================================================
  // RENDER — MAIN ROW
  // ============================================================
  function renderRow(row, section, isFirst = false, isLast = false) {
    const linkedExpected = getLinkedExpected(row, section);
    const isLinked       = linkedExpected !== null;
    const adjustable     = isLinkedAdjustableRow(row, section);
    const expectedValue  = isLinked ? linkedExpected : parseAmount(row.expected);
    const actual         = getActual(row, section);
    const { text: varianceText, className: varianceClass } = formatVariance(expectedValue, actual, section);
    const isExpanded     = expandedRows.has(row.id);

    const linkTooltip = section === 'income'
      ? 'Edit on the Salary page'
      : 'Pre-tax contribution. Edit on the Salary page';

    const trClassName = [
      isExpanded ? 'row-expanded' : '',
      isLinked   ? 'row-linked'   : '',
    ].filter(Boolean).join(' ');

    const tr = el('tr', {
      'data-id':      row.id,
      'data-section': section,
      className:      trClassName,
    });

    const chevron = el('button', {
      className:       'btn-chevron',
      'aria-expanded': isExpanded ? 'true' : 'false',
      'aria-label':    T('toggleTxn'),
      textContent:     isExpanded ? '▾' : '▸',
    });

    const isMobile = MOBILE_MQL.matches;
    const nameInput = el(isMobile ? 'textarea' : 'input', {
      placeholder:   T('namePlaceholder'),
      'aria-label':  `Name for ${row.name || 'new row'}`,
      'data-field':  'name',
      ...(isMobile ? { rows: '1' } : { type: 'text' }),
    });
    nameInput.value = row.name;
    // Linked Pre-Tax Investments row names are read-only — sync would otherwise auto-revert any rename
    if (isLinked && section === 'pretaxInvestments') {
      nameInput.readOnly = true;
      nameInput.title = linkTooltip;
    }
    if (isMobile) {
      // Enter blurs the field instead of inserting a newline (names are single-value)
      nameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
      });
    }

    const nameCell = el('div', { className: 'name-cell' });
    nameCell.appendChild(chevron);
    nameCell.appendChild(nameInput);
    if (isLinked) {
      const badge = el('span', {
        className: 'linked-badge',
        title:     linkTooltip,
        textContent: 'from Salary',
      });
      nameCell.appendChild(badge);
    }
    // Sub-type chooser for non-linked Savings & Investments rows.
    if (section === 'savings' && !isLinked) {
      const subtypeSelect = el('select', {
        className:    'row-subtype',
        'data-field': 'subtype',
        'aria-label': `Sub-type for ${row.name || 'this row'}`,
        title:        'Investment = market-exposed; Savings = liquid cash',
      });
      subtypeSelect.append(
        el('option', { value: 'investment', textContent: 'Investment' }),
        el('option', { value: 'savings',    textContent: 'Savings'    }),
      );
      subtypeSelect.value = getRowSubtype(row, section);
      nameCell.appendChild(subtypeSelect);
    }

    let expectedCell;
    if (isLinked) {
      expectedCell = el('div', {
        className:    'expected-readonly',
        title:        linkTooltip,
        'aria-label': `Expected for ${row.name} (read-only — edit on Salary page)`,
        textContent:  formatCurrency(expectedValue),
      });
    } else {
      const expectedInput = el('input', {
        type:         'text',
        inputmode:    'decimal',
        value:         formatCurrency(expectedValue),
        'aria-label': `Expected for ${row.name}`,
        'data-field': 'expected',
      });
      expectedInput.addEventListener('focus', () => {
        const raw = parseAmount(expectedInput.value);
        expectedInput.value = raw === 0 ? '' : String(raw);
      });
      expectedInput.addEventListener('blur', () => {
        const raw = parseAmount(expectedInput.value);
        expectedInput.value = formatCurrency(raw);
      });
      expectedInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
      });
      expectedCell = expectedInput;
    }

    // Action buttons — hidden for Pre-Tax Investments rows (must be edited via Salary page).
    const actionsWrapper = el('div', { className: 'row-actions' });
    if (!(isLinked && section === 'pretaxInvestments')) {
      const upBtn = el('button', {
        className:     'btn-reorder',
        'aria-label':  'Move row up',
        'data-action': 'move-up',
        textContent:   '▲',
      });
      if (isFirst) upBtn.disabled = true;

      const downBtn = el('button', {
        className:     'btn-reorder',
        'aria-label':  'Move row down',
        'data-action': 'move-down',
        textContent:   '▼',
      });
      if (isLast) downBtn.disabled = true;

      const removeBtn = el('button', {
        className:     'btn-remove',
        'aria-label':  T('removeAriaLabel'),
        'data-action': 'remove',
        textContent:   T('remove'),
      });

      actionsWrapper.appendChild(upBtn);
      actionsWrapper.appendChild(downBtn);
      actionsWrapper.appendChild(removeBtn);
    }

    // Linked savings/fixed rows: Actual is auto-computed (Expected + adjustments) and read-only.
    let actualCell;
    if (adjustable) {
      actualCell = el('div', {
        className:    'expected-readonly',
        title:        'Auto-computed: Expected + adjustments. Use + Add adjustment to alter.',
        'aria-label': `Actual for ${row.name} (read-only — adjusts via this row's expansion panel)`,
        textContent:  formatCurrency(actual),
      });
    }

    tr.appendChild(el('td', {}, nameCell));
    tr.appendChild(el('td', { 'data-label': 'Expected' }, expectedCell));
    tr.appendChild(adjustable
      ? el('td', { 'data-label': 'Actual' }, actualCell)
      : el('td', { 'data-label': 'Actual', textContent: formatCurrency(actual) }));
    tr.appendChild(el('td', { 'data-label': 'Variance', className: varianceClass, textContent: varianceText }));
    tr.appendChild(el('td', {}, actionsWrapper));
    return tr;
  }

  // ============================================================
  // RENDER — TRANSACTION PANEL
  // ============================================================
  function renderTransactionItem(txn, rowId, section) {
    const div = el('div', {
      className:      'transaction-item',
      'data-txn-id':  txn.id,
      'data-row-id':  rowId,
      'data-section': section,
    });
    div.appendChild(el('span', { className: 'txn-date',   textContent: formatDate(txn.date) }));
    div.appendChild(el('span', { className: 'txn-amount', textContent: formatCurrency(parseAmount(txn.amount)) }));
    div.appendChild(el('span', { className: 'txn-note',   textContent: txn.note || '' }));
    div.appendChild(el('button', {
      className:     'btn-remove',
      'aria-label':  'Remove transaction',
      'data-action': 'remove-txn',
      textContent:   '×',
    }));
    return div;
  }

  function renderTransactionPanel(row, section) {
    const panelTr = el('tr', {
      className:        'transaction-panel',
      'data-panel-for': row.id,
      'data-section':   section,
    });

    const td = document.createElement('td');
    td.setAttribute('colspan', '5');

    const inner = el('div', { className: 'transaction-panel-inner' });

    // Transaction list
    const list = el('div', { className: 'transaction-list', id: `txn-list-${row.id}` });
    if (row.transactions.length === 0) {
      list.appendChild(el('p', { className: 'txn-empty', textContent: T('noTransactions') }));
    } else {
      for (const txn of row.transactions) {
        list.appendChild(renderTransactionItem(txn, row.id, section));
      }
    }
    inner.appendChild(list);

    // Add form
    const form = el('div', {
      className:      'transaction-add-form',
      'data-row-id':  row.id,
      'data-section': section,
    });

    const dateInput   = el('input', { type: 'date',   className: 'txn-input-date',   value: getDefaultDate() });
    const amountInput = el('input', { type: 'text', inputmode: 'decimal', className: 'txn-input-amount', placeholder: T('amountPlaceholder') });
    const noteInput   = el('input', { type: 'text',   className: 'txn-input-note',   placeholder: T('notePlaceholder') });
    const addBtn      = el('button', { className: 'btn-add-txn', 'data-action': 'add-txn', textContent: T('addTransaction') });

    // Show formatted currency when navigating out; raw number when editing.
    amountInput.addEventListener('focus', () => {
      const n = parseAmount(amountInput.value);
      amountInput.value = n === 0 ? '' : String(n);
    });
    amountInput.addEventListener('blur', () => {
      const n = parseAmount(amountInput.value);
      amountInput.value = n === 0 ? '' : formatCurrency(n);
    });

    // Enter submits from amount or note
    [amountInput, noteInput].forEach(input => {
      input.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });
    });

    form.append(dateInput, amountInput, noteInput, addBtn);
    inner.appendChild(form);
    td.appendChild(inner);
    panelTr.appendChild(td);
    return panelTr;
  }

  // ============================================================
  // RENDER — ADJUSTMENTS PANEL (linked savings/fixed rows)
  // ============================================================
  function renderAdjustmentItem(adj, rowId, section) {
    const amount = parseAmount(adj.amount);
    const div = el('div', {
      className:      'adjustment-item',
      'data-adj-id':  adj.id,
      'data-row-id':  rowId,
      'data-section': section,
    });
    const sign = amount > 0 ? '+' : (amount < 0 ? '-' : '');
    const display = sign + formatCurrency(Math.abs(amount));
    const amountClass = amount > 0
      ? 'adj-amount adj-amount--pos'
      : amount < 0
        ? 'adj-amount adj-amount--neg'
        : 'adj-amount';
    div.appendChild(el('span', { className: amountClass, textContent: display }));
    div.appendChild(el('span', { className: 'adj-note', textContent: adj.note || '' }));
    div.appendChild(el('button', {
      className:     'btn-remove',
      'aria-label':  'Remove adjustment',
      'data-action': 'remove-adjustment',
      textContent:   '×',
    }));
    return div;
  }

  function renderAdjustmentsPanel(row, section) {
    const panelTr = el('tr', {
      className:        'transaction-panel adjustment-panel',
      'data-panel-for': row.id,
      'data-section':   section,
    });

    const td = document.createElement('td');
    td.setAttribute('colspan', '5');

    const inner = el('div', { className: 'transaction-panel-inner' });

    const list = el('div', { className: 'adjustment-list', id: `adj-list-${row.id}` });
    const adjustments = row.adjustments || [];
    if (adjustments.length === 0) {
      list.appendChild(el('p', { className: 'adj-empty', textContent: 'No adjustments yet.' }));
    } else {
      for (const adj of adjustments) {
        list.appendChild(renderAdjustmentItem(adj, row.id, section));
      }
    }
    inner.appendChild(list);

    // Toggle button — clicking expands the inline form below.
    const toggleBtn = el('button', {
      className:     'btn-add-adj-toggle',
      'data-action': 'toggle-adjustment-form',
      textContent:   '+ Add adjustment',
    });
    inner.appendChild(toggleBtn);

    // Form, hidden by default; revealed via toggle button.
    const form = el('div', {
      className:      'adjustment-add-form hidden',
      'data-row-id':  row.id,
      'data-section': section,
    });
    const amountInput = el('input', {
      type:        'number',
      className:   'adj-input-amount',
      placeholder: 'Amount (positive or negative)',
      step:        '0.01',
    });
    const noteInput = el('input', {
      type:        'text',
      className:   'adj-input-note',
      placeholder: 'Note (optional)',
    });
    const cancelBtn = el('button', {
      className:     'btn-cancel-adj',
      'data-action': 'cancel-adjustment-form',
      textContent:   'Cancel',
    });
    const submitBtn = el('button', {
      className:     'btn-add-adj',
      'data-action': 'add-adjustment',
      textContent:   'Add',
    });
    [amountInput, noteInput].forEach(input => {
      input.addEventListener('keydown', e => { if (e.key === 'Enter') submitBtn.click(); });
    });
    form.append(amountInput, noteInput, cancelBtn, submitBtn);
    inner.appendChild(form);

    td.appendChild(inner);
    panelTr.appendChild(td);
    return panelTr;
  }

  function renderRowExpansionPanel(row, section) {
    if (isLinkedAdjustableRow(row, section)) {
      return renderAdjustmentsPanel(row, section);
    }
    return renderTransactionPanel(row, section);
  }

  // ============================================================
  // RENDER — TABLES & SUMMARY
  // ============================================================
  function renderTable(tbodyId, rows, section) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    tbody.closest('table')?.classList.add('budget-cards');
    tbody.innerHTML = '';

    let sorted;
    let firstReorderableIdx = -1;
    let lastReorderableIdx  = -1;
    if (section === 'pretaxInvestments') {
      // All rows are linked; preserve deduction order, no reorder controls.
      sorted = sortLinkedRows(rows, currentMonth, section);
    } else {
      sorted = [...rows].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      if (sorted.length > 0) {
        firstReorderableIdx = 0;
        lastReorderableIdx  = sorted.length - 1;
      }
    }

    if (sorted.length === 0 && section !== 'pretaxInvestments') {
      const tr = el('tr', {});
      const td = el('td', { colSpan: '5', className: 'table-empty' });
      const debtAccounts = section === 'debt' ? getDebtAccounts() : [];
      if (debtAccounts.length > 0) {
        td.appendChild(el('span', {
          textContent: 'Plan payments toward the debt on your Net Worth page. ',
        }));
        const seedBtn = el('button', {
          type: 'button',
          className: 'btn-link',
          textContent: `+ Add ${debtAccounts.length === 1 ? 'a row' : 'rows'} from your debt account${debtAccounts.length === 1 ? '' : 's'}`,
        });
        seedBtn.addEventListener('click', () => debtSeedRowsFromAccounts());
        td.appendChild(seedBtn);
      } else {
        td.textContent = 'No rows yet — use “+ Add” below to create one.';
      }
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i];
      const isFirst = i === firstReorderableIdx;
      const isLast  = i === lastReorderableIdx;
      tbody.appendChild(renderRow(row, section, isFirst, isLast));
      if (expandedRows.has(row.id)) {
        tbody.appendChild(renderRowExpansionPanel(row, section));
      }
    }
  }

  // ---- Debt Paydown helpers ----
  function getDebtAccounts() {
    return (investing?.accounts || []).filter(a => a.account_type === 'debt');
  }

  // Create one budget row per Net Worth debt account (skipping any account
  // whose name already has a row). Rows are plain budget rows — the account
  // is only used to prefill the name.
  function debtSeedRowsFromAccounts() {
    const list = getRowList('debt');
    const accounts = getDebtAccounts().filter(acc => {
      const name = (acc.name || '').trim().toLowerCase();
      return name && !list.some(r => (r.name || '').trim().toLowerCase() === name);
    });
    if (accounts.length === 0) { showToast('Those accounts already have rows'); return; }
    pushUndo('add debt paydown rows');
    let nextOrder = list.reduce((max, r) => Math.max(max, r.order ?? 0), -1) + 1;
    for (const acc of accounts) {
      const row = newRow(acc.name, 0, nextOrder++);
      list.push(row);
      withRetry(
        async () => {
          const result = await window.puntoApi.insertBudgetCategory({
            id:                  row.id,
            name:                row.name,
            section:             'debt',
            subtype:             null,
            sort_order:          row.order ?? 0,
            is_linked:           false,
            linked_deduction_id: null,
          });
          if (result && result.success) await ensureMonthlyEntriesExist(currentMonth);
          return result;
        },
        (err) => {
          console.warn(`Debt seed: insertBudgetCategory failed for row ${row.id}:`, err);
          const idx = list.findIndex(r => r.id === row.id);
          if (idx !== -1) list.splice(idx, 1);
          renderAll();
          debouncedSave();
        }
      );
    }
    renderAll();
    debouncedSave();
  }

  function renderAllTables() {
    const md = state.months[currentMonth];
    const pretaxRows = md.categories.pretaxInvestments || [];
    renderTable('income-body',             md.income,                     'income');
    renderTable('pretax-investments-body', pretaxRows,                    'pretaxInvestments');
    renderTable('fixed-body',              md.categories.fixed,           'fixed');
    renderTable('variable-body',           md.categories.variable,        'variable');
    renderTable('recreational-body',       md.categories.recreational,    'recreational');
    renderTable('savings-body',            md.categories.savings || [],   'savings');
    refreshDebtSection();

    const pretaxSection = document.getElementById('pretax-investments-section');
    if (pretaxSection) pretaxSection.style.display = pretaxRows.length > 0 ? '' : 'none';
  }

  // Debt Paydown visibility: show the section when the month has debt rows
  // or Net Worth has debt accounts; otherwise show only the quiet
  // "+ Add debt paydown" entry line (which creates the first row).
  // Also called from renderInvesting() so adding/removing a debt account on
  // the Net Worth page updates the Budget page immediately.
  function refreshDebtSection() {
    const md = state.months[currentMonth];
    if (!md) return;
    const debtRows = md.categories.debt || [];
    renderTable('debt-body', debtRows, 'debt');
    const showDebt    = debtRows.length > 0 || getDebtAccounts().length > 0;
    const debtSection = document.getElementById('debt-section');
    const debtEntry   = document.getElementById('debt-entry');
    if (debtSection) debtSection.hidden = !showDebt;
    if (debtEntry)   debtEntry.hidden   = showDebt;
  }

  // Per-group subtotals in the unified Expenses card header rows.
  function renderExpenseGroupSubtotals() {
    const md = state.months[currentMonth];
    if (!md) return;
    const groups = {
      fixed:        md.categories.fixed        || [],
      variable:     md.categories.variable     || [],
      recreational: md.categories.recreational || [],
    };
    let actTotal = 0;
    let expTotal = 0;
    for (const [key, rows] of Object.entries(groups)) {
      const act = sumListActual(rows);
      const exp = sumListExpected(rows);
      actTotal += act;
      expTotal += exp;
      const el = document.getElementById(`${key}-subtotal`);
      if (el) el.textContent = `${formatCurrency(act)} of ${formatCurrency(exp)}`;
    }
    const actEl = document.getElementById('expenses-total-actual');
    const expEl = document.getElementById('expenses-total-expected');
    if (actEl) actEl.textContent = formatCurrency(actTotal);
    if (expEl) expEl.textContent = formatCurrency(expTotal);
  }

  function renderSummary() {
    const sum = computeSummary(state.months[currentMonth]);

    renderExpenseGroupSubtotals();

    const incomeEl      = document.getElementById('summary-income');
    const expensesEl    = document.getElementById('summary-expenses');
    const unallocatedEl = document.getElementById('summary-unallocated');
    const savedInvestedEl = document.getElementById('summary-saved-invested');
    const netEl         = document.getElementById('summary-net');
    const insightEl     = document.getElementById('summary-insight');

    if (incomeEl) incomeEl.textContent = formatCurrency(sum.incomeBasis);
    if (expensesEl) expensesEl.textContent = formatCurrency(sum.expensesActual);

    if (unallocatedEl) {
      const u = Math.round(sum.unallocated * 100) / 100;
      unallocatedEl.textContent = formatCurrency(u);
      unallocatedEl.className   = u === 0 ? 'unallocated-success'
                                : u > 0   ? 'unallocated-warning'
                                          : 'unallocated-danger';
    }

    if (savedInvestedEl) {
      savedInvestedEl.textContent = formatCurrency(sum.savingsActual + sum.investmentsActual);
    }

    // Debt paydown item only appears when the month plans or logs debt payments.
    const debtItemEl = document.getElementById('summary-debt-item');
    const debtEl     = document.getElementById('summary-debt');
    if (debtItemEl) debtItemEl.hidden = sum.debtExpected === 0 && sum.debtActual === 0;
    if (debtEl) debtEl.textContent = formatCurrency(sum.debtActual);

    if (netEl) {
      netEl.textContent = formatCurrency(sum.netActual);
      netEl.className   = sum.netActual >= 0 ? 'positive' : 'negative';
    }

    const cashflowEl = document.getElementById('summary-cashflow');
    if (cashflowEl) {
      // Savings stays out (transfer between own accounts), but debt payments
      // are cash leaving your pocket — subtract them.
      const cf = sum.incomeActual - sum.expensesActual - sum.debtActual;
      cashflowEl.textContent = formatCurrency(cf);
      cashflowEl.className    = cf >= 0 ? 'positive' : 'negative';
    }

    if (insightEl) {
      const u = Math.round(sum.unallocated * 100) / 100;
      let text, cls;
      if (sum.incomeExpected === 0) {
        text = 'Add your expected income to start budgeting';
        cls  = 'summary-insight insight-neutral';
      } else if (u === 0) {
        text = 'Every dollar has a job ✓';
        cls  = 'summary-insight insight-success';
      } else if (u > 0) {
        text = `You have ${formatCurrency(u)} left to allocate`;
        cls  = 'summary-insight insight-warning';
      } else {
        text = `Your plan exceeds your income by ${formatCurrency(Math.abs(u))}`;
        cls  = 'summary-insight insight-danger';
      }
      insightEl.textContent = text;
      insightEl.className   = cls;
    }
  }

  function renderAll() {
    syncBudgetWithSalary(currentMonth);
    renderAllTables();
    renderSummary();
    renderSalary();
    renderDashboard();
    renderInvesting();
    syncCopyBtnLabel();
    syncApplyFutureBtnLabel();
  }

  // ============================================================
  // DASHBOARD
  // ============================================================
  function renderDashboard() {
    const headingEl  = document.getElementById('dashboard-heading');
    const subtitleEl = document.getElementById('dashboard-subtitle');
    const incomeEl   = document.getElementById('dashboard-income');
    const spentEl    = document.getElementById('dashboard-spent');
    const savedEl    = document.getElementById('dashboard-saved');
    const netEl      = document.getElementById('dashboard-net');
    if (!headingEl || !incomeEl) return;

    const [y, m]    = currentMonth.split('-').map(Number);
    const monthName = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const md  = state.months[currentMonth];
    const sum = computeSummary(md);

    // TOTAL INCOME — hybrid basis: past months use actual income received
    // (falling back to the projection when no actuals were logged); the
    // current and future months keep the full-month projection so Net Cash
    // Left stays a useful end-of-month forecast.
    const realMonthKey = toMonthKey(new Date());
    const isPastMonth  = currentMonth < realMonthKey;
    const projected    = sum.incomeExpected;
    const received     = sum.incomeActual;
    const totalIncome  = (isPastMonth && received > 0) ? received : projected;

    // TOTAL SAVED combines post-tax + pre-tax (the existing summary's
    // savings + investments tiles already split this the same way).
    const totalSpent  = sum.expensesActual;
    const totalSaved  = sum.savingsActual + sum.investmentsActual;

    // NET CASH LEFT subtracts only post-tax savings — pre-tax was never
    // in the take-home pool to begin with.
    const postTaxSavingsAct = sumListActual(md.categories.savings || []);
    const netCash = totalIncome - totalSpent - postTaxSavingsAct - sum.debtActual;
    const netRounded = Math.round(netCash * 100) / 100;

    headingEl.textContent = `${monthName} at a glance`;

    // Empty state: no income, spending, or savings anywhere in the month.
    const isEmptyMonth = projected === 0 && received === 0 &&
                         totalSpent === 0 && totalSaved === 0 &&
                         sum.debtExpected === 0 && sum.debtActual === 0;
    const emptyEl = document.getElementById('dashboard-empty');
    const tilesEl = document.getElementById('dashboard-tiles');
    if (emptyEl) emptyEl.hidden = !isEmptyMonth;
    if (tilesEl) tilesEl.hidden = isEmptyMonth;
    if (subtitleEl) subtitleEl.hidden = isEmptyMonth;

    incomeEl.textContent  = formatCurrency(totalIncome);

    // Income tile sub-line: current month shows what's actually landed so
    // far; past months note the projection when actuals replaced it.
    const incomeSubEl = document.getElementById('dashboard-income-sub');
    if (incomeSubEl) {
      const differs = Math.round(received * 100) !== Math.round(projected * 100);
      if (currentMonth === realMonthKey && received > 0 && differs) {
        incomeSubEl.textContent = `${formatCurrency(received)} received so far`;
        incomeSubEl.hidden = false;
      } else if (isPastMonth && received > 0 && differs) {
        incomeSubEl.textContent = `vs ${formatCurrency(projected)} projected`;
        incomeSubEl.hidden = false;
      } else {
        incomeSubEl.hidden = true;
      }
    }
    spentEl.textContent   = formatCurrency(totalSpent);
    savedEl.textContent   = formatCurrency(totalSaved);
    netEl.textContent     = formatCurrency(netRounded);
    netEl.className = 'dashboard-tile-value ' +
      (netRounded > 0 ? 'positive' : netRounded < 0 ? 'negative' : 'neutral');

    // Past months show settled cash; current/future months are a forecast.
    const netLabelEl = document.getElementById('dashboard-net-label');
    if (netLabelEl) {
      netLabelEl.textContent = isPastMonth ? 'Net Cash Left' : 'Expected Cash Left';
    }

    if (subtitleEl) {
      const unallocatedRounded = Math.round(sum.unallocated * 100) / 100;
      const savingsRate = totalIncome > 0 ? totalSaved / totalIncome : 0;
      let subtitle;
      if (totalIncome === 0) {
        subtitle = 'Add your income on the Salary page to start budgeting';
      } else if (netRounded < 0) {
        subtitle = `You spent ${formatCurrency(Math.abs(netRounded))} more than you earned this month`;
      } else if (savingsRate >= 0.20) {
        const pct = Math.round(savingsRate * 100);
        subtitle = `Strong savings month — you saved ${pct}% of your income`;
      } else if (unallocatedRounded === 0) {
        subtitle = 'Every dollar has a job ✓';
      } else {
        subtitle = `Your financial summary for ${monthName}`;
      }
      subtitleEl.textContent = subtitle;
    }

    // Safe to spend: remaining flexible budget (Variable + Recreational)
    // divided by days left. Only meaningful for the current calendar month.
    const ssEl = document.getElementById('dashboard-safespend');
    if (ssEl) {
      const now    = new Date();
      const nowKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const flexExpected = sumListExpected(md.categories.variable || []) +
                           sumListExpected(md.categories.recreational || []);
      if (nowKey !== currentMonth || flexExpected <= 0) {
        ssEl.hidden = true;
      } else {
        const flexActual = sumListActual(md.categories.variable || []) +
                           sumListActual(md.categories.recreational || []);
        const remaining   = flexExpected - flexActual;
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const daysLeft    = daysInMonth - now.getDate() + 1; // includes today
        const perDay      = Math.max(0, remaining) / daysLeft;
        const valueEl = document.getElementById('safespend-value');
        const noteEl  = document.getElementById('safespend-note');
        ssEl.hidden = false;
        ssEl.classList.toggle('safespend--over', remaining < 0);
        if (valueEl) valueEl.textContent = formatCurrency(perDay);
        if (noteEl) {
          noteEl.textContent = remaining < 0
            ? `${formatCurrency(Math.abs(remaining))} over your flexible budget this month`
            : `${formatCurrency(remaining)} of flexible spending left · ${daysLeft} day${daysLeft === 1 ? '' : 's'} to go`;
        }
      }
    }

    // Spending breakdown bar (fixed / variable / recreational)
    const bdEl = document.getElementById('dashboard-breakdown');
    if (bdEl) {
      const cats = md.categories;
      const parts = [
        ['fixed',        sumListActual(cats.fixed        || [])],
        ['variable',     sumListActual(cats.variable     || [])],
        ['recreational', sumListActual(cats.recreational || [])],
      ];
      const totalParts = parts.reduce((acc, [, v]) => acc + v, 0);
      bdEl.hidden = totalParts <= 0;
      if (totalParts > 0) {
        for (const [key, val] of parts) {
          const seg = document.getElementById(`breakdown-seg-${key}`);
          const amt = document.getElementById(`breakdown-amt-${key}`);
          const pct = (val / totalParts) * 100;
          if (seg) {
            seg.style.width = pct + '%';
            seg.style.display = val > 0 ? '' : 'none';
          }
          if (amt) amt.textContent = `${formatCurrency(val)} · ${Math.round(pct)}%`;
        }
        const totalEl = document.getElementById('breakdown-total');
        if (totalEl) totalEl.textContent = formatCurrency(totalParts);
      }
    }

    renderTrends();
  }

  // ============================================================
  // TRENDS (last 6 months of actuals on the dashboard)
  // ============================================================
  // Past months are fetched from monthly_entries once and cached for the
  // session; the current month is always computed live from local state so
  // the chart tracks edits without refetching. Hidden until at least two
  // months in the window have any activity.
  const trendsCache = new Map(); // monthKey -> { income, fixed, variable, recreational }

  function trendsWindowKeys() {
    const [y, m] = currentMonth.split('-').map(Number);
    const keys = [];
    for (let i = 5; i >= 0; i--) keys.push(toMonthKey(new Date(y, m - 1 - i, 1)));
    return keys;
  }

  function computeCurrentMonthTotals() {
    const md = state.months?.[currentMonth];
    const t  = { income: 0, fixed: 0, variable: 0, recreational: 0 };
    if (!md) return t;
    for (const row of md.income || []) t.income += getActual(row, 'income');
    for (const g of ['fixed', 'variable', 'recreational']) {
      for (const row of md.categories?.[g] || []) t[g] += getActual(row, g);
    }
    return t;
  }

  async function ensureTrendsData() {
    const missing = trendsWindowKeys().filter(k => k !== currentMonth && !trendsCache.has(k));
    if (missing.length === 0) return;
    if (!apiCategoriesCache) return;
    if (!window.puntoApi || typeof window.puntoApi.getMonthlyEntries !== 'function') return;
    const sectionById = new Map();
    for (const cat of apiCategoriesCache) {
      sectionById.set(cat.id, API_SECTION_MAP[cat.section]);
    }
    const results = await Promise.all(missing.map(k => window.puntoApi.getMonthlyEntries(k)));
    missing.forEach((k, i) => {
      const entries = (results[i] && results[i].success && results[i].data) || [];
      const t = { income: 0, fixed: 0, variable: 0, recreational: 0 };
      for (const e of entries) {
        const sec = sectionById.get(e.category_id);
        if (t[sec] !== undefined) t[sec] += parseAmount(e.actual);
      }
      trendsCache.set(k, t);
    });
  }

  function renderTrends() {
    const card  = document.getElementById('dashboard-trends');
    const chart = document.getElementById('trends-chart');
    if (!card || !chart) return;
    ensureTrendsData().then(() => {
      const empty = { income: 0, fixed: 0, variable: 0, recreational: 0 };
      const data = trendsWindowKeys().map(k => ({
        key: k,
        t:   k === currentMonth ? computeCurrentMonthTotals() : (trendsCache.get(k) || empty),
      }));
      const spendOf = t => t.fixed + t.variable + t.recreational;
      const active  = data.filter(d => d.t.income > 0 || spendOf(d.t) > 0).length;
      if (active < 2) { card.hidden = true; return; }

      const max = Math.max(1, ...data.map(d => Math.max(d.t.income, spendOf(d.t))));
      card.hidden = false;
      chart.innerHTML = '';
      for (const d of data) {
        const [y, m]  = d.key.split('-').map(Number);
        const name    = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' });
        const spend   = spendOf(d.t);
        const col = el('div', {
          className: 'trend-col' + (d.key === currentMonth ? ' trend-col--current' : ''),
          title:     `${name}: income ${formatCurrency(d.t.income)} · spent ${formatCurrency(spend)}`,
        });
        const bars = el('div', { className: 'trend-bars' });

        const incomeBar = el('div', { className: 'trend-bar trend-bar--income' });
        incomeBar.style.height = ((d.t.income / max) * 100).toFixed(1) + '%';

        const spendBar = el('div', { className: 'trend-bar trend-bar--spend' });
        spendBar.style.height = ((spend / max) * 100).toFixed(1) + '%';
        for (const g of ['recreational', 'variable', 'fixed']) {
          if (spend > 0 && d.t[g] > 0) {
            const seg = el('div', { className: `trend-seg seg--${g}` });
            seg.style.height = ((d.t[g] / spend) * 100).toFixed(1) + '%';
            spendBar.appendChild(seg);
          }
        }

        bars.append(incomeBar, spendBar);
        col.append(bars, el('span', { className: 'trend-month', textContent: name }));
        chart.appendChild(col);
      }
    });
  }

  // ============================================================
  // INVESTING (Stage 6: accounts + monthly balance snapshots)
  // ============================================================
  // Accounts and snapshots live in their own Supabase tables
  // (investment_accounts / investment_snapshots) with a localStorage cache
  // for instant paint. Balances carry forward: the balance shown for a
  // month is the most recent snapshot at or before it.
  const INVESTING_LS_KEY = 'puntoBaseInvesting';

  const INVEST_TYPES = {
    '401k':      '401(k)',
    roth_ira:    'Roth IRA',
    ira:         'Trad. IRA',
    brokerage:   'Brokerage',
    hsa:         'HSA',
    crypto:      'Crypto',
    cash:        'Cash',
    checking:    'Checking',
    savings:     'Savings',
    debt:        'Debt',
    other:       'Other',
  };

  let investing = loadInvesting();
  let investingHydrated = false;   // fetched from API this session
  let investingLoadPromise = null;

  function loadInvesting() {
    try {
      const raw = localStorage.getItem(INVESTING_LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.accounts) && Array.isArray(parsed.snapshots)) return parsed;
      }
    } catch {}
    return { accounts: [], snapshots: [] };
  }

  function saveInvesting() {
    try { localStorage.setItem(INVESTING_LS_KEY, JSON.stringify(investing)); } catch {}
  }

  function ensureInvestingData() {
    if (investingHydrated) return Promise.resolve();
    if (investingLoadPromise) return investingLoadPromise;
    if (!window.puntoApi ||
        typeof window.puntoApi.getInvestmentAccounts !== 'function' ||
        typeof window.puntoApi.getInvestmentSnapshots !== 'function') {
      return Promise.resolve();
    }
    investingLoadPromise = Promise.all([
      window.puntoApi.getInvestmentAccounts(),
      window.puntoApi.getInvestmentSnapshots(),
    ]).then(([accRes, snapRes]) => {
      if (accRes && accRes.success && snapRes && snapRes.success) {
        investing = { accounts: accRes.data, snapshots: snapRes.data };
        investingHydrated = true;
        saveInvesting();
      }
    }).catch(() => {}).finally(() => { investingLoadPromise = null; });
    return investingLoadPromise;
  }

  function investSnapshotFor(accountId, month) {
    return investing.snapshots.find(s => s.account_id === accountId && s.month === month) || null;
  }

  // Carry-forward balance: most recent snapshot at or before `month`.
  // 'YYYY-MM' strings compare correctly lexicographically.
  function investBalanceAsOf(accountId, month) {
    let best = null;
    for (const s of investing.snapshots) {
      if (s.account_id !== accountId || s.month > month) continue;
      if (!best || s.month > best.month) best = s;
    }
    return best ? parseAmount(best.balance) : null;
  }

  // Assets vs. debt at `month`. Debt balances are entered as what you owe
  // (positive) and subtracted when computing net worth.
  function investBreakdownAt(month) {
    let assets = 0, debt = 0, any = false;
    for (const acc of investing.accounts) {
      const bal = investBalanceAsOf(acc.id, month);
      if (bal === null) continue;
      any = true;
      if (acc.account_type === 'debt') debt += bal; else assets += bal;
    }
    return any ? { net: assets - debt, assets, debt } : null;
  }

  function investPortfolioAt(month) {
    const b = investBreakdownAt(month);
    return b ? b.net : null;
  }

  async function investSetBalance(accountId, month, balance) {
    const existing = investSnapshotFor(accountId, month);
    if (existing) {
      if (parseAmount(existing.balance) === balance) return;
      existing.balance = balance;
    } else {
      investing.snapshots.push({ id: null, account_id: accountId, month, balance });
    }
    saveInvesting();
    renderInvesting();
    if (window.puntoApi && typeof window.puntoApi.upsertInvestmentSnapshot === 'function') {
      const res = await window.puntoApi.upsertInvestmentSnapshot({ account_id: accountId, month, balance });
      if (res && res.success && res.data) {
        const snap = investSnapshotFor(accountId, month);
        if (snap) { snap.id = res.data.id; saveInvesting(); }
      } else if (res && res.error) {
        showToast(`Sync failed: ${res.error}`);
      }
    }
  }

  async function investAddAccount() {
    const acc = {
      id:           crypto.randomUUID(),
      name:         '',
      account_type: 'brokerage',
      sort_order:   investing.accounts.length,
      _isNew:       true,   // rendered in edit mode; persisted on first name save
    };
    investing.accounts.push(acc);
    renderInvesting();
    const input = document.querySelector(`#invest-accounts-body tr[data-id="${acc.id}"] input[data-field="name"]`);
    input?.focus();
  }

  async function investPersistAccount(acc) {
    if (!window.puntoApi || typeof window.puntoApi.insertInvestmentAccount !== 'function') return;
    const res = await window.puntoApi.insertInvestmentAccount({
      id: acc.id, name: acc.name, account_type: acc.account_type, sort_order: acc.sort_order,
    });
    if (res && res.success) { delete acc._isNew; saveInvesting(); }
    else if (res && res.error) showToast(`Sync failed: ${res.error}`);
  }

  async function investUpdateAccount(acc, fields) {
    Object.assign(acc, fields);
    saveInvesting();
    if (acc._isNew) {
      if (acc.name) await investPersistAccount(acc);
      return;
    }
    if (window.puntoApi && typeof window.puntoApi.updateInvestmentAccount === 'function') {
      const res = await window.puntoApi.updateInvestmentAccount({ id: acc.id, ...fields });
      if (res && !res.success && res.error) showToast(`Sync failed: ${res.error}`);
    }
  }

  async function investRemoveAccount(accountId) {
    const acc = investing.accounts.find(a => a.id === accountId);
    if (!acc) return;
    const label = acc.name || 'this account';
    if (!window.confirm(`Remove ${label}? Its balance history will no longer be shown.`)) return;
    investing.accounts = investing.accounts.filter(a => a.id !== accountId);
    investing.snapshots = investing.snapshots.filter(s => s.account_id !== accountId);
    saveInvesting();
    renderInvesting();
    if (!acc._isNew && window.puntoApi && typeof window.puntoApi.softDeleteInvestmentAccount === 'function') {
      const res = await window.puntoApi.softDeleteInvestmentAccount(accountId);
      if (res && !res.success && res.error) showToast(`Sync failed: ${res.error}`);
    }
  }

  function renderInvestingTiles() {
    const totalEl   = document.getElementById('invest-total');
    const changeEl  = document.getElementById('invest-change');
    const contribEl = document.getElementById('invest-contrib');
    if (!totalEl) return;

    const bk    = investBreakdownAt(currentMonth);
    const total = bk ? bk.net : null;
    totalEl.textContent = formatCurrency(total ?? 0);
    totalEl.classList.toggle('negative', total !== null && total < 0);

    const subEl = document.getElementById('invest-total-sub');
    if (subEl) {
      if (bk && bk.debt > 0) {
        subEl.textContent = `${formatCurrency(bk.assets)} assets − ${formatCurrency(bk.debt)} debt`;
        subEl.hidden = false;
      } else {
        subEl.hidden = true;
      }
    }

    const [y, m]  = currentMonth.split('-').map(Number);
    const prevKey = toMonthKey(new Date(y, m - 2, 1));
    const prev    = investPortfolioAt(prevKey);
    if (changeEl) {
      if (total === null || prev === null) {
        changeEl.textContent = '—';
        changeEl.className = 'dashboard-tile-value neutral';
      } else {
        const delta = Math.round((total - prev) * 100) / 100;
        const sign  = delta > 0 ? '+' : delta < 0 ? '−' : '';
        changeEl.textContent = `${sign}${formatCurrency(Math.abs(delta))}`;
        changeEl.className = 'dashboard-tile-value ' +
          (delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral');
      }
    }

    if (contribEl) {
      const md = state.months[currentMonth];
      const contrib = md ? computeSummary(md).investmentsActual : 0;
      contribEl.textContent = formatCurrency(contrib);
    }

    // Debt Paid tile — mirrors Contributed: pulls the Budget page's debt
    // section actual for this month. Balances aren't auto-nudged; the tile
    // reminds the user to update debt balances by hand.
    const debtTileEl = document.getElementById('invest-debt-paid-tile');
    const debtPaidEl = document.getElementById('invest-debt-paid');
    if (debtTileEl && debtPaidEl) {
      const md = state.months[currentMonth];
      const paid = md ? computeSummary(md).debtActual : 0;
      debtTileEl.hidden = paid === 0;
      debtPaidEl.textContent = formatCurrency(paid);
    }
  }

  function renderInvestingChart() {
    const card  = document.getElementById('invest-chart-card');
    const chart = document.getElementById('invest-chart');
    if (!card || !chart) return;

    const snapMonths = investing.snapshots.map(s => s.month);
    if (snapMonths.length === 0) { card.hidden = true; return; }
    const firstMonth = snapMonths.reduce((a, b) => (a < b ? a : b));

    // Window: from first snapshot to selected month, capped at 12 bars.
    const keys = [];
    const [cy, cm] = currentMonth.split('-').map(Number);
    for (let i = 11; i >= 0; i--) {
      const k = toMonthKey(new Date(cy, cm - 1 - i, 1));
      if (k >= firstMonth) keys.push(k);
    }
    const data = keys.map(k => ({ key: k, total: investPortfolioAt(k) ?? 0 }));
    if (data.length < 2) { card.hidden = true; return; }

    card.hidden = false;
    const rangeEl = document.getElementById('invest-chart-range');
    if (rangeEl) rangeEl.textContent = `Last ${data.length} months`;

    const max = Math.max(1, ...data.map(d => d.total));
    chart.innerHTML = '';
    for (const d of data) {
      const [y, m] = d.key.split('-').map(Number);
      const name   = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' });
      const col = el('div', {
        className: 'trend-col' + (d.key === currentMonth ? ' trend-col--current' : ''),
        title:     `${name}: ${formatCurrency(d.total)}`,
      });
      const bars = el('div', { className: 'trend-bars' });
      const bar  = el('div', { className: 'trend-bar trend-bar--portfolio' });
      bar.style.height = ((Math.max(0, d.total) / max) * 100).toFixed(1) + '%';
      bars.appendChild(bar);
      col.append(bars, el('span', { className: 'trend-month', textContent: name }));
      chart.appendChild(col);
    }
  }

  function renderInvestingAccounts() {
    const body = document.getElementById('invest-accounts-body');
    if (!body) return;
    body.innerHTML = '';

    if (investing.accounts.length === 0) {
      const tr = el('tr', { className: 'invest-empty-row' });
      const td = el('td', { colSpan: '4', className: 'invest-empty' });
      td.appendChild(el('p', {
        textContent: 'No accounts yet — add investments, cash, and debts to track your net worth.',
      }));
      const btn = el('button', {
        type: 'button',
        className: 'btn-primary',
        textContent: '+ Add your first account',
      });
      btn.addEventListener('click', () => investAddAccount());
      td.appendChild(btn);
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    for (const acc of investing.accounts) {
      const isDebt = acc.account_type === 'debt';
      const tr = el('tr', { 'data-id': acc.id, className: isDebt ? 'invest-row--debt' : '' });

      // Name
      const nameInput = el('input', {
        type: 'text',
        placeholder: 'Account name',
        'aria-label': `Name for ${acc.name || 'new account'}`,
        'data-field': 'name',
      });
      nameInput.value = acc.name;
      nameInput.addEventListener('blur', () => {
        const name = nameInput.value.trim();
        if (name !== acc.name) investUpdateAccount(acc, { name });
      });
      nameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
      });
      const nameTd = el('td');
      const nameCell = el('div', { className: 'name-cell' });
      nameCell.appendChild(nameInput);
      nameTd.appendChild(nameCell);

      // Type
      const typeSelect = el('select', {
        className: 'row-subtype invest-type',
        'aria-label': `Type for ${acc.name || 'this account'}`,
      });
      for (const [value, label] of Object.entries(INVEST_TYPES)) {
        typeSelect.appendChild(el('option', { value, textContent: label }));
      }
      typeSelect.value = acc.account_type || 'brokerage';
      typeSelect.addEventListener('change', () => {
        investUpdateAccount(acc, { account_type: typeSelect.value });
        renderInvesting();   // debt/asset flip changes net worth + row styling
      });
      const typeTd = el('td');
      typeTd.appendChild(typeSelect);

      // Balance for the selected month (carry-forward as placeholder)
      const snap    = investSnapshotFor(acc.id, currentMonth);
      const carried = investBalanceAsOf(acc.id, currentMonth);
      const balInput = el('input', {
        type: 'text',
        inputmode: 'decimal',
        className: isDebt ? 'invest-balance--debt' : '',
        'aria-label': `${isDebt ? 'Amount owed' : 'Balance'} for ${acc.name || 'this account'}`,
        'data-field': 'balance',
      });
      if (snap) {
        balInput.value = formatCurrency(parseAmount(snap.balance));
      } else {
        balInput.value = '';
        balInput.placeholder = carried !== null ? `${formatCurrency(carried)} (carried)` : formatCurrency(0);
      }
      balInput.addEventListener('focus', () => {
        const raw = parseAmount(balInput.value);
        balInput.value = raw === 0 ? '' : String(raw);
      });
      balInput.addEventListener('blur', () => {
        if (balInput.value.trim() === '') {
          // No entry for this month — keep carry-forward, don't write a zero.
          const s = investSnapshotFor(acc.id, currentMonth);
          if (!s) { renderInvesting(); return; }
        }
        investSetBalance(acc.id, currentMonth, parseAmount(balInput.value));
      });
      balInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); balInput.blur(); }
      });
      const balTd = el('td');
      balTd.appendChild(balInput);

      // Actions
      const removeBtn = el('button', {
        className: 'btn-remove',
        'aria-label': `Remove ${acc.name || 'account'}`,
        textContent: '✕',
      });
      removeBtn.addEventListener('click', () => investRemoveAccount(acc.id));
      const actionsTd = el('td');
      const actions = el('div', { className: 'row-actions' });
      actions.appendChild(removeBtn);
      actionsTd.appendChild(actions);

      tr.append(nameTd, typeTd, balTd, actionsTd);
      body.appendChild(tr);
    }
  }

  function renderInvesting() {
    if (!document.getElementById('page-investing')) return;
    renderInvestingTiles();
    renderInvestingChart();
    renderInvestingAccounts();
    refreshDebtSection();   // Budget's Debt Paydown visibility tracks debt accounts
    ensureInvestingData().then(() => {
      if (investingHydrated && !renderInvesting._repainted) {
        renderInvesting._repainted = true;
        renderInvestingTiles();
        renderInvestingChart();
        renderInvestingAccounts();
        refreshDebtSection();
      }
    });
  }

  function initInvesting() {
    document.getElementById('invest-add-account')
      ?.addEventListener('click', () => investAddAccount());
  }

  function initDashboardEmptyState() {
    document.getElementById('empty-goto-salary')
      ?.addEventListener('click', () => showPage('salary'));
    document.getElementById('empty-goto-budget')
      ?.addEventListener('click', () => showPage('budget'));
  }

  // ============================================================
  // CSV IMPORT
  // ============================================================
  // Import bank/card CSV exports as transactions: pick the date /
  // description / amount columns, assign each row to a budget category,
  // and bulk-add into the currently selected month. Rows dated outside
  // the selected month are listed but can't be imported (switch months).

  // Minimal RFC-4180-ish parser: quoted fields, escaped quotes, CRLF.
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(c => c.trim() !== '')) rows.push(row);
        row = [];
      } else field += ch;
    }
    row.push(field);
    if (row.some(c => c.trim() !== '')) rows.push(row);
    return rows;
  }

  // Normalize a CSV date cell to 'YYYY-MM-DD', or null if unparseable.
  function parseCsvDate(s) {
    s = (s || '').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);          // ISO
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);          // US M/D/Y
    if (m) {
      let yr = Number(m[3]); if (yr < 100) yr += 2000;
      return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return null;
  }

  function parseCsvAmount(s) {
    s = (s || '').trim().replace(/[$,\s]/g, '');
    if (/^\(.*\)$/.test(s)) s = '-' + s.slice(1, -1);          // (12.34) = negative
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  const IMPORT_SECTIONS = [
    ['income',       'Income'],
    ['fixed',        'Fixed'],
    ['variable',     'Variable'],
    ['recreational', 'Recreational'],
    ['savings',      'Savings & Investments'],
    ['debt',         'Debt Paydown'],
  ];

  function importRowsForSection(section) {
    const md = state.months[currentMonth];
    return section === 'income' ? (md.income || []) : (md.categories[section] || []);
  }

  let importModalEl = null;

  function closeImportModal() {
    importModalEl?.remove();
    importModalEl = null;
    document.removeEventListener('keydown', onImportEsc);
  }

  function onImportEsc(e) { if (e.key === 'Escape') closeImportModal(); }

  function openImportModal(csvRows) {
    closeImportModal();
    if (!csvRows.length || csvRows[0].length < 2) {
      showToast('Could not read that file as a CSV.');
      return;
    }

    const colCount  = Math.max(...csvRows.map(r => r.length));
    const first     = csvRows[0];
    const hasHeader = first.some(c => /date|desc|memo|payee|amount|amt|debit|credit|balance|name|detail/i.test(c)) &&
                      !first.some(c => parseCsvDate(c));
    const headers   = hasHeader
      ? first.map((c, i) => c.trim() || `Column ${i + 1}`)
      : Array.from({ length: colCount }, (_, i) => `Column ${i + 1}`);
    const dataRows  = hasHeader ? csvRows.slice(1) : csvRows;

    // Auto-detect columns.
    const guessCol = (re, validate) => {
      for (let i = 0; i < colCount; i++) {
        if (hasHeader && re.test(headers[i])) return i;
      }
      for (let i = 0; i < colCount; i++) {
        if (dataRows[0] && validate(dataRows[0][i])) return i;
      }
      return -1;
    };
    let dateCol = guessCol(/date|posted/i, c => !!parseCsvDate(c));
    let descCol = guessCol(/desc|memo|payee|name|detail|merchant/i,
      c => !!c && !parseCsvDate(c) && parseCsvAmount(c) === null);
    let amtCol  = guessCol(/amount|amt|debit|value/i,
      c => parseCsvAmount(c) !== null && !parseCsvDate(c));

    const backdrop = el('div', { className: 'import-backdrop' });
    const modal    = el('div', { className: 'import-modal', role: 'dialog', 'aria-label': 'Import CSV' });

    const title    = el('h2', { className: 'import-title', textContent: 'Import CSV' });
    const closeBtn = el('button', { className: 'btn-icon import-close', 'aria-label': 'Close' }, '✕');
    closeBtn.addEventListener('click', closeImportModal);

    const body = el('div', { className: 'import-body' });
    modal.append(el('div', { className: 'import-header' }, title, closeBtn), body);
    backdrop.appendChild(modal);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) closeImportModal(); });
    document.body.appendChild(backdrop);
    importModalEl = backdrop;
    document.addEventListener('keydown', onImportEsc);

    // ---- Step 1: column mapping ----
    function renderStep1() {
      body.innerHTML = '';

      const makeSelect = (selected) => {
        const sel = el('select', { className: 'row-subtype import-col-select' });
        headers.forEach((h, i) => {
          const opt = el('option', { value: String(i), textContent: h });
          if (i === selected) opt.selected = true;
          sel.appendChild(opt);
        });
        return sel;
      };
      const dateSel = makeSelect(dateCol === -1 ? 0 : dateCol);
      const descSel = makeSelect(descCol === -1 ? 0 : descCol);
      const amtSel  = makeSelect(amtCol  === -1 ? 0 : amtCol);

      const negCount  = dataRows.filter(r => (parseCsvAmount(r[Number(amtSel.value)]) ?? 0) < 0).length;
      const flipCheck = el('input', { type: 'checkbox', id: 'import-flip' });
      flipCheck.checked = negCount > dataRows.length / 2;

      const mapGrid = el('div', { className: 'import-map-grid' },
        el('label', { textContent: 'Date column' }),        dateSel,
        el('label', { textContent: 'Description column' }), descSel,
        el('label', { textContent: 'Amount column' }),      amtSel,
      );
      const flipRow = el('div', { className: 'import-flip-row' });
      const flipLabel = el('label', { for: 'import-flip', textContent: ' Money out is negative in this file (flip signs on import)' });
      flipRow.append(flipCheck, flipLabel);

      const preview = el('div', { className: 'import-preview' });
      const renderPreview = () => {
        preview.innerHTML = '';
        const tbl = el('table', { className: 'import-preview-table' });
        const thead = el('thead', {});
        thead.appendChild(el('tr', {},
          el('th', { textContent: 'Date' }),
          el('th', { textContent: 'Description' }),
          el('th', { textContent: 'Amount' }),
        ));
        const tbody = el('tbody', {});
        for (const r of dataRows.slice(0, 5)) {
          const rawAmt = parseCsvAmount(r[Number(amtSel.value)]);
          const amt    = rawAmt === null ? null : (flipCheck.checked ? -rawAmt : rawAmt);
          tbody.appendChild(el('tr', {},
            el('td', { textContent: parseCsvDate(r[Number(dateSel.value)]) || '—' }),
            el('td', { textContent: (r[Number(descSel.value)] || '').trim() || '—' }),
            el('td', { textContent: amt === null ? '—' : formatCurrency(amt) }),
          ));
        }
        tbl.append(thead, tbody);
        preview.append(
          el('p', { className: 'section-note', textContent: `Preview — first ${Math.min(5, dataRows.length)} of ${dataRows.length} rows` }),
          tbl,
        );
      };
      [dateSel, descSel, amtSel, flipCheck].forEach(x => x.addEventListener('change', renderPreview));
      renderPreview();

      const nextBtn = el('button', { className: 'btn-primary', textContent: 'Next: assign categories' });
      nextBtn.addEventListener('click', () => {
        renderStep2(Number(dateSel.value), Number(descSel.value), Number(amtSel.value), flipCheck.checked);
      });

      body.append(mapGrid, flipRow, preview, el('div', { className: 'import-actions' }, nextBtn));
    }

    // ---- Step 2: category assignment ----
    function renderStep2(dCol, xCol, aCol, flip) {
      body.innerHTML = '';

      const parsed = dataRows.map(r => {
        const rawAmt = parseCsvAmount(r[aCol]);
        return {
          date:   parseCsvDate(r[dCol]),
          note:   (r[xCol] || '').trim(),
          amount: rawAmt === null ? null : (flip ? -rawAmt : rawAmt),
        };
      }).filter(p => p.amount !== null && p.amount !== 0);

      const inMonth  = parsed.filter(p => p.date && p.date.slice(0, 7) === currentMonth);
      const outMonth = parsed.length - inMonth.length;

      if (inMonth.length === 0) {
        body.append(
          el('p', { className: 'import-note', textContent:
            `None of the ${parsed.length} rows fall in ${currentMonth}. ` +
            'Switch to the right month (top of the page) and import again.' }),
          el('div', { className: 'import-actions' },
            (() => { const b = el('button', { className: 'btn-secondary', textContent: 'Back' });
                     b.addEventListener('click', renderStep1); return b; })()),
        );
        return;
      }

      const catSelects = [];
      const tbl   = el('table', { className: 'import-assign-table' });
      const thead = el('thead', {});
      thead.appendChild(el('tr', {},
        el('th', { textContent: '' }),
        el('th', { textContent: 'Date' }),
        el('th', { textContent: 'Description' }),
        el('th', { textContent: 'Amount' }),
        el('th', { textContent: 'Category' }),
      ));
      const tbody = el('tbody', {});
      for (const p of inMonth) {
        const check = el('input', { type: 'checkbox' });
        check.checked = true;
        const sel = el('select', { className: 'row-subtype import-cat-select' });
        sel.appendChild(el('option', { value: '', textContent: '— skip —' }));
        for (const [section, label] of IMPORT_SECTIONS) {
          const rows = importRowsForSection(section).filter(r => (r.name || '').trim());
          if (!rows.length) continue;
          const grp = el('optgroup', { label });
          for (const r of rows) grp.appendChild(el('option', { value: `${section}:${r.id}`, textContent: r.name }));
          sel.appendChild(grp);
        }
        catSelects.push({ p, check, sel });
        tbody.appendChild(el('tr', {},
          el('td', {}, check),
          el('td', { textContent: p.date }),
          el('td', { className: 'import-desc', textContent: p.note || '—' }),
          el('td', { textContent: formatCurrency(p.amount) }),
          el('td', {}, sel),
        ));
      }
      tbl.append(thead, tbody);

      const backBtn   = el('button', { className: 'btn-secondary', textContent: 'Back' });
      backBtn.addEventListener('click', renderStep1);
      const importBtn = el('button', { className: 'btn-primary', textContent: 'Import' });
      importBtn.addEventListener('click', () => {
        const picks = catSelects.filter(x => x.check.checked && x.sel.value);
        if (!picks.length) { showToast('Assign a category to at least one row.'); return; }
        runCsvImport(picks.map(x => {
          const [section, rowId] = x.sel.value.split(':');
          return { section, rowId, amount: x.p.amount, date: x.p.date, note: x.p.note };
        }));
      });

      const notes = [];
      if (outMonth > 0) notes.push(`${outMonth} row${outMonth === 1 ? '' : 's'} dated outside ${currentMonth} not shown — switch months to import them.`);
      body.append(
        el('p', { className: 'section-note', textContent: `${inMonth.length} rows in this month. Uncheck rows or leave category as “skip” to leave them out.` }),
        el('div', { className: 'import-table-wrap' }, tbl),
        ...notes.map(n => el('p', { className: 'import-note', textContent: n })),
        el('div', { className: 'import-actions' }, backBtn, importBtn),
      );
    }

    renderStep1();
  }

  function runCsvImport(items) {
    pushUndo('CSV import');
    let count = 0;
    for (const it of items) {
      const row = findRow(it.section, it.rowId);
      if (!row) continue;
      const txn = newTransaction(it.amount, it.date, it.note);
      if (!Array.isArray(row.transactions)) row.transactions = [];
      row.transactions.push(txn);
      bumpRowActual(row, txn.amount);
      count++;
      if (row.monthly_entry_id) {
        withRetry(
          () => window.puntoApi.insertTransaction({
            id:               txn.id,
            monthly_entry_id: row.monthly_entry_id,
            amount:           txn.amount,
            description:      txn.note || null,
            transaction_date: txn.date || null,
            transaction_type: 'manual',
          }),
          (err) => console.warn('CSV import Supabase write failed:', err),
        );
      }
    }
    saveState();
    closeImportModal();
    renderAll();
    showToast(`Imported ${count} transaction${count === 1 ? '' : 's'}`);
  }

  function initCsvImport() {
    const btn  = document.getElementById('import-csv-btn');
    const file = document.getElementById('import-csv-file');
    if (!btn || !file) return;
    btn.addEventListener('click', () => { file.value = ''; file.click(); });
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => openImportModal(parseCSV(String(reader.result || '')));
      reader.onerror = () => showToast('Could not read that file.');
      reader.readAsText(f);
    });
  }

  // ============================================================
  // SURGICAL CELL UPDATE (after transaction change)
  // ============================================================
  function updateRowCells(rowId, section) {
    const row = findRow(section, rowId);
    if (!row) return;
    const tr = document.querySelector(`tr[data-id="${rowId}"]`);
    if (!tr) return;

    const actual = getActual(row, section);
    const { text: varianceText, className: varianceClass } = formatVariance(getEffectiveExpected(row, section), actual, section);

    const actualTd   = tr.children[2];
    const varianceTd = tr.children[3];
    if (actualTd) {
      const readonlyDiv = actualTd.querySelector('.expected-readonly');
      if (readonlyDiv) readonlyDiv.textContent = formatCurrency(actual);
      else actualTd.textContent = formatCurrency(actual);
    }
    if (varianceTd) {
      varianceTd.textContent = varianceText;
      varianceTd.className   = varianceClass;
    }
  }

  // ============================================================
  // EXPAND / COLLAPSE
  // ============================================================
  function toggleRow(rowId, section) {
    const mainTr = document.querySelector(`tr[data-id="${rowId}"]`);
    if (!mainTr) return;
    const chevron = mainTr.querySelector('.btn-chevron');

    if (expandedRows.has(rowId)) {
      expandedRows.delete(rowId);
      document.querySelector(`tr[data-panel-for="${rowId}"]`)?.remove();
      mainTr.classList.remove('row-expanded');
      if (chevron) { chevron.textContent = '▸'; chevron.setAttribute('aria-expanded', 'false'); }
    } else {
      expandedRows.add(rowId);
      const row = findRow(section, rowId);
      if (!row) return;
      const panelTr = renderRowExpansionPanel(row, section);
      mainTr.insertAdjacentElement('afterend', panelTr);
      mainTr.classList.add('row-expanded');
      if (chevron) { chevron.textContent = '▾'; chevron.setAttribute('aria-expanded', 'true'); }
      // For non-linked rows, focus the transaction amount input. Adjustment rows
      // require a click on "+ Add adjustment" first, so no auto-focus there.
      panelTr.querySelector('.txn-input-amount')?.focus();
    }
  }

  // ============================================================
  // REORDER ROWS
  // ============================================================
  function reorderRow(section, rowId, direction) {
    const realMonth   = toMonthKey(new Date());
    const viewedMonth = currentMonth;
    const md          = state.months[viewedMonth];
    const list        = section === 'income' ? md.income : md.categories[section];

    const sorted = [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const idx    = sorted.findIndex(r => r.id === rowId);
    if (idx === -1) return;

    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;

    const rowA  = sorted[idx];
    const rowB  = sorted[swapIdx];
    const nameA = rowA.name;
    const nameB = rowB.name;

    pushUndo(`reorder '${nameA}'`);

    // Stage 5E: capture pre-swap orders BEFORE the tempOrder dance so the
    // revert path can restore the original values if the Supabase write fails.
    const preSwapOrderA = rowA.order ?? idx;
    const preSwapOrderB = rowB.order ?? swapIdx;
    const rowAId        = rowA.id;
    const rowBId        = rowB.id;

    // Swap orders in the viewed month
    const tempOrder = rowA.order ?? idx;
    rowA.order      = rowB.order ?? swapIdx;
    rowB.order      = tempOrder;

    // Propagate forward: current real month and any future months with data
    if (viewedMonth >= realMonth) {
      const futureKeys = Object.keys(state.months)
        .filter(k => k > viewedMonth)
        .sort();
      for (const key of futureKeys) {
        const fmd   = state.months[key];
        if (!fmd) continue;
        const fList = section === 'income' ? fmd.income : fmd.categories?.[section];
        if (!fList) continue;
        const fRowA = fList.find(r => r.name === nameA);
        const fRowB = fList.find(r => r.name === nameB);
        if (!fRowA || !fRowB) continue;
        const tempO = fRowA.order ?? 0;
        fRowA.order = fRowB.order ?? 0;
        fRowB.order = tempO;
      }
    }

    renderAll();
    debouncedSave();

    // Stage 5E: write the swap to Supabase. Two parallel UPDATEs via Promise.all
    // wrapped in withRetry's apiCall so a single retry covers both. The
    // forward-propagation to future months is a localStorage-era artifact;
    // sort_order is global per category on the server, so server-side there's
    // nothing to propagate. Any local divergence in future months self-heals
    // on next page load.
    withRetry(
      async () => {
        const [resA, resB] = await Promise.all([
          window.puntoApi.updateBudgetCategory({ id: rowAId, sort_order: rowA.order }),
          window.puntoApi.updateBudgetCategory({ id: rowBId, sort_order: rowB.order }),
        ]);
        if (!resA.success || !resB.success) {
          return { success: false, error: (resA.error || resB.error || 'partial reorder failure') };
        }
        return { success: true };
      },
      (err) => {
        console.warn(`Stage 5E: reorder write failed for rows ${rowAId}, ${rowBId}, reverting:`, err);
        const rA = findRow(section, rowAId);
        const rB = findRow(section, rowBId);
        if (rA) rA.order = preSwapOrderA;
        if (rB) rB.order = preSwapOrderB;
        renderAll();
        debouncedSave();
      }
    );
  }

  // ============================================================
  // ADD / REMOVE TRANSACTION
  // ============================================================

  // Keep the cached row.actual in sync with a local transaction change.
  // Only adjust when it's already a populated number; otherwise leave it
  // unset so getActual's sumTransactions fallback stays in effect.
  function bumpRowActual(row, delta) {
    if (typeof row.actual === 'number' && !isNaN(row.actual)) {
      row.actual = parseAmount(row.actual) + delta;
    }
  }

  function addTransaction(rowId, section, form) {
    const dateInput   = form.querySelector('.txn-input-date');
    const amountInput = form.querySelector('.txn-input-amount');
    const noteInput   = form.querySelector('.txn-input-note');

    const amount = parseAmount(amountInput.value);
    if (amount === 0) return;

    const row = findRow(section, rowId);
    if (!row) return;
    pushUndo(`edit to ${row.name}`);

    const txn = newTransaction(amount, dateInput.value || getDefaultDate(), noteInput.value.trim());
    row.transactions.push(txn);
    bumpRowActual(row, txn.amount);

    // Optimistic Supabase write (5C-3-1).
    if (!row.monthly_entry_id) {
      console.warn(
        `addTransaction: row "${row.name}" has no monthly_entry_id; ` +
        `skipping Supabase write. Stage 5E/5F will fix.`
      );
    } else {
      const capturedRow     = row;
      const capturedTxn     = txn;
      const capturedRowId   = rowId;
      const capturedSection = section;
      withRetry(
        () => window.puntoApi.insertTransaction({
          id:               capturedTxn.id,
          monthly_entry_id: capturedRow.monthly_entry_id,
          amount:           capturedTxn.amount,
          description:      capturedTxn.note || null,
          transaction_date: capturedTxn.date || null,
          transaction_type: 'manual',
        }),
        (err) => {
          console.warn('addTransaction Supabase failure, reverting:', err);
          const idx = capturedRow.transactions.findIndex(t => t.id === capturedTxn.id);
          if (idx !== -1) {
            capturedRow.transactions.splice(idx, 1);
            bumpRowActual(capturedRow, -capturedTxn.amount);
            const list = document.getElementById(`txn-list-${capturedRowId}`);
            const itemEl = list?.querySelector(`[data-txn-id="${capturedTxn.id}"]`);
            itemEl?.remove();
            if (list && capturedRow.transactions.length === 0) {
              list.appendChild(el('p', { className: 'txn-empty', textContent: T('noTransactions') }));
            }
            updateRowCells(capturedRowId, capturedSection);
            renderSummary();
            debouncedSave();
          }
        }
      );
    }

    const list = document.getElementById(`txn-list-${rowId}`);
    if (list) {
      list.querySelector('.txn-empty')?.remove();
      list.appendChild(renderTransactionItem(txn, rowId, section));
    }

    amountInput.value = '';
    noteInput.value   = '';
    amountInput.focus();

    updateRowCells(rowId, section);
    renderSummary();
    debouncedSave();
  }

  function removeTransaction(rowId, section, txnId, itemEl) {
    const row = findRow(section, rowId);
    if (!row) return;
    const idx = row.transactions.findIndex(t => t.id === txnId);
    if (idx === -1) return;
    pushUndo(`edit to ${row.name}`);
    const removedTxn = row.transactions.splice(idx, 1)[0];
    bumpRowActual(row, -removedTxn.amount);
    itemEl.remove();

    // Optimistic Supabase write (5C-3-1).
    if (!row.monthly_entry_id) {
      console.warn(
        `removeTransaction: row "${row.name}" has no monthly_entry_id; ` +
        `skipping Supabase write.`
      );
    } else {
      const capturedRow     = row;
      const capturedTxn     = removedTxn;
      const capturedIdx     = idx;
      const capturedRowId   = rowId;
      const capturedSection = section;
      withRetry(
        () => window.puntoApi.deleteTransaction(capturedTxn.id),
        (err) => {
          console.warn('removeTransaction Supabase failure, reverting:', err);
          capturedRow.transactions.splice(capturedIdx, 0, capturedTxn);
          bumpRowActual(capturedRow, capturedTxn.amount);
          const list = document.getElementById(`txn-list-${capturedRowId}`);
          if (list) {
            list.querySelector('.txn-empty')?.remove();
            const restoredEl = renderTransactionItem(capturedTxn, capturedRowId, capturedSection);
            const siblings = list.querySelectorAll('[data-txn-id]');
            if (siblings[capturedIdx]) {
              list.insertBefore(restoredEl, siblings[capturedIdx]);
            } else {
              list.appendChild(restoredEl);
            }
            updateRowCells(capturedRowId, capturedSection);
            renderSummary();
            debouncedSave();
          }
        }
      );
    }

    const list = document.getElementById(`txn-list-${rowId}`);
    if (list && row.transactions.length === 0) {
      list.appendChild(el('p', { className: 'txn-empty', textContent: T('noTransactions') }));
    }

    updateRowCells(rowId, section);
    renderSummary();
    debouncedSave();
  }

  async function addAdjustment(rowId, section, form) {
    const amountInput = form.querySelector('.adj-input-amount');
    const noteInput   = form.querySelector('.adj-input-note');

    const amount = parseAmount(amountInput.value);
    if (amount === 0) return;

    const row = findRow(section, rowId);
    if (!row) return;
    pushUndo(`adjustment to ${row.name}`);

    if (!Array.isArray(row.adjustments)) row.adjustments = [];
    const adj = newAdjustment(amount, noteInput.value.trim());
    row.adjustments.push(adj);

    const list = document.getElementById(`adj-list-${rowId}`);
    if (list) {
      list.querySelector('.adj-empty')?.remove();
      list.appendChild(renderAdjustmentItem(adj, rowId, section));
    }

    amountInput.value = '';
    noteInput.value   = '';
    form.classList.add('hidden');

    updateRowCells(rowId, section);
    renderSummary();
    debouncedSave();

    // Stage 5G: dual-write to Supabase. Warn-on-failure pattern (matches
    // 5F-2). localStorage stays authoritative; failures will reconcile when
    // applyApiAdjustmentsToMonth overwrites row.adjustments on next reload —
    // a failed-write adjustment is lost from the user's perspective. Same
    // drift trade-off as 5F-2's tab-close-during-debounce. row.id is the
    // budget_categories.id post-5F-3/4 (synthesized rows have the budget
    // category UUID stamped by the bridge Map).
    if (window.puntoApi && typeof window.puntoApi.insertAdjustment === 'function') {
      const result = await window.puntoApi.insertAdjustment({
        id:          adj.id,
        category_id: row.id,
        month:       currentMonth,
        amount:      adj.amount,
        note:        adj.note,
      });
      if (!result || !result.success) {
        console.warn('5G: insertAdjustment failed:', result && result.error);
      }
    }
  }

  async function removeAdjustment(rowId, section, adjId, itemEl) {
    const row = findRow(section, rowId);
    if (!row) return;
    const adjustments = row.adjustments || [];
    const idx = adjustments.findIndex(a => a.id === adjId);
    if (idx === -1) return;
    pushUndo(`remove adjustment from ${row.name}`);
    adjustments.splice(idx, 1);
    itemEl.remove();

    const list = document.getElementById(`adj-list-${rowId}`);
    if (list && adjustments.length === 0) {
      list.appendChild(el('p', { className: 'adj-empty', textContent: 'No adjustments yet.' }));
    }

    updateRowCells(rowId, section);
    renderSummary();
    debouncedSave();

    // Stage 5G: dual-write soft-delete. Same warn-on-failure pattern as
    // addAdjustment. localStorage is authoritative; a failed soft-delete
    // leaves the row deleted-in-memory but still present in the DB until
    // next reload's applyApiAdjustmentsToMonth overwrites (which would
    // RE-ADD it from the DB). Same drift class as 5F-2.
    if (window.puntoApi && typeof window.puntoApi.softDeleteAdjustment === 'function') {
      const result = await window.puntoApi.softDeleteAdjustment(adjId);
      if (!result || !result.success) {
        console.warn('5G: softDeleteAdjustment failed:', result && result.error);
      }
    }
  }

  // ============================================================
  // EVENT DELEGATION
  // ============================================================
  function handleTableInput(e) {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const { id, section } = tr.dataset;
    const field = e.target.dataset.field;
    if (!field) return;

    const row = findRow(section, id);
    if (!row) return;

    if (field === 'name') {
      // Stage 5E: write to budget_categories via debounced flusher
      const preEditName = row.name;  // capture BEFORE mutation
      row.name = e.target.value;
      if (row.id) {
        const flusher = getNameFlusher(row.id);
        flusher(section, row.name, preEditName);
      }
    } else if (field === 'expected') {
      const preEditExpected = row.expected;
      row.expected = parseAmount(e.target.value);
      const actual  = getActual(row, section);
      const { text: varianceText, className: varianceClass } = formatVariance(getEffectiveExpected(row, section), actual, section);
      const varTd = tr.children[3];
      if (varTd) {
        varTd.textContent = varianceText;
        varTd.className   = varianceClass;
      }
      renderSummary();
      // Stage 5D: Supabase write for Expected.
      if (!row.monthly_entry_id) {
        console.warn(
          `Expected edit on row "${row.name}" has no monthly_entry_id; ` +
          `skipping Supabase write (locally-created or linked row).`
        );
      } else {
        const flusher = getExpectedFlusher(row.monthly_entry_id);
        flusher(row, section, preEditExpected);
      }
    } else if (field === 'subtype') {
      // Stage 5E: write to budget_categories immediately (<select> is atomic, no debounce)
      const preEditSubtype = row.subtype;  // capture BEFORE mutation
      row.subtype = normalizeSubtype(e.target.value, row.name);
      renderSummary();
      if (row.id) {
        withRetry(
          () => window.puntoApi.updateBudgetCategory({ id: row.id, subtype: row.subtype }),
          (err) => {
            console.warn(`Stage 5E: subtype write failed for row ${row.id}, reverting:`, err);
            row.subtype = preEditSubtype;
            renderAll();
            debouncedSave();
          }
        );
      }
    }

    debouncedSave();
  }

  function handleTableClick(e) {
    // Chevron
    const chevron = e.target.closest('.btn-chevron');
    if (chevron) {
      const tr = chevron.closest('tr[data-id]');
      if (tr) toggleRow(tr.dataset.id, tr.dataset.section);
      return;
    }

    // Move row up
    const moveUpBtn = e.target.closest('[data-action="move-up"]');
    if (moveUpBtn) {
      const tr = moveUpBtn.closest('tr[data-id]');
      if (tr) reorderRow(tr.dataset.section, tr.dataset.id, 'up');
      return;
    }

    // Move row down
    const moveDownBtn = e.target.closest('[data-action="move-down"]');
    if (moveDownBtn) {
      const tr = moveDownBtn.closest('tr[data-id]');
      if (tr) reorderRow(tr.dataset.section, tr.dataset.id, 'down');
      return;
    }

    // Remove row
    const removeRowBtn = e.target.closest('[data-action="remove"]');
    if (removeRowBtn) {
      const tr = removeRowBtn.closest('tr[data-id]');
      if (!tr) return;
      const { id, section } = tr.dataset;
      const list    = getRowList(section);
      const idx     = list.findIndex(r => r.id === id);
      if (idx === -1) return;
      const rowName    = list[idx]?.name || 'unnamed';
      const removedRow = list[idx];           // capture for revert
      pushUndo(`delete row '${rowName}'`);
      list.splice(idx, 1);
      expandedRows.delete(id);
      renderAll();
      debouncedSave();

      // Stage 5E: soft-delete in Supabase. Orphan monthly_entries / transactions /
      // adjustments persist server-side but are silently dropped by the read path
      // (per Q5/Q6 of pre-work diagnostic).
      withRetry(
        () => window.puntoApi.softDeleteBudgetCategory(id),
        (err) => {
          console.warn(`Stage 5E: softDeleteBudgetCategory failed for row ${id}, restoring locally:`, err);
          list.splice(idx, 0, removedRow);  // restore at original index
          renderAll();
          debouncedSave();
        }
      );
      return;
    }

    // Remove transaction
    const removeTxnBtn = e.target.closest('[data-action="remove-txn"]');
    if (removeTxnBtn) {
      const item = removeTxnBtn.closest('.transaction-item');
      if (!item) return;
      const { txnId, rowId, section } = item.dataset;
      removeTransaction(rowId, section, txnId, item);
      return;
    }

    // Add transaction
    const addTxnBtn = e.target.closest('[data-action="add-txn"]');
    if (addTxnBtn) {
      const form = addTxnBtn.closest('.transaction-add-form');
      if (!form) return;
      addTransaction(form.dataset.rowId, form.dataset.section, form);
      return;
    }

    // Toggle adjustment form (linked rows)
    const toggleAdjBtn = e.target.closest('[data-action="toggle-adjustment-form"]');
    if (toggleAdjBtn) {
      const inner = toggleAdjBtn.closest('.transaction-panel-inner');
      const form  = inner?.querySelector('.adjustment-add-form');
      if (form) {
        form.classList.toggle('hidden');
        if (!form.classList.contains('hidden')) {
          form.querySelector('.adj-input-amount')?.focus();
        }
      }
      return;
    }

    // Cancel adjustment form
    const cancelAdjBtn = e.target.closest('[data-action="cancel-adjustment-form"]');
    if (cancelAdjBtn) {
      const form = cancelAdjBtn.closest('.adjustment-add-form');
      if (form) {
        form.querySelector('.adj-input-amount').value = '';
        form.querySelector('.adj-input-note').value   = '';
        form.classList.add('hidden');
      }
      return;
    }

    // Add adjustment
    const addAdjBtn = e.target.closest('[data-action="add-adjustment"]');
    if (addAdjBtn) {
      const form = addAdjBtn.closest('.adjustment-add-form');
      if (!form) return;
      addAdjustment(form.dataset.rowId, form.dataset.section, form);
      return;
    }

    // Remove adjustment
    const removeAdjBtn = e.target.closest('[data-action="remove-adjustment"]');
    if (removeAdjBtn) {
      const item = removeAdjBtn.closest('.adjustment-item');
      if (!item) return;
      const { adjId, rowId, section } = item.dataset;
      removeAdjustment(rowId, section, adjId, item);
      return;
    }

    // Add row
    const addRowBtn = e.target.closest('.btn-add[data-category]');
    if (addRowBtn) {
      const section   = addRowBtn.dataset.category;
      const list      = getRowList(section);
      const nextOrder = list.reduce((max, r) => Math.max(max, r.order ?? 0), -1) + 1;
      flushPendingAddRow(); // commit any previous pending-add before creating another
      const row        = newRow('', 0, nextOrder);
      const preAddSnap = JSON.parse(JSON.stringify(state));
      list.push(row);
      pendingAddRow = { rowId: row.id, section, snapshot: preAddSnap };
      renderAll();
      document.getElementById(`${section}-body`)
        ?.querySelector(`tr[data-id="${row.id}"] input`)?.focus();
      debouncedSave();

      // Stage 5E: INSERT into Supabase, then precreate monthly_entry for current month.
      // ensureMonthlyEntriesExist is awaited INSIDE the apiCall (vs. .then on the
      // outer withRetry) because withRetry returns undefined, not the API result.
      withRetry(
        async () => {
          const result = await window.puntoApi.insertBudgetCategory({
            id:                  row.id,           // client UUID
            name:                row.name || '',
            section:             section,
            subtype:             null,             // newRow doesn't set; defaults at render
            sort_order:          row.order ?? 0,
            is_linked:           row.isLinked === true,
            linked_deduction_id: row.linkedDeductionId || null,
          });
          if (result && result.success) {
            // Best-effort precreate of the current month's monthly_entry so 5C-3
            // transaction writes succeed without the locally-created-row gap.
            await ensureMonthlyEntriesExist(currentMonth);
          }
          return result;
        },
        (err) => {
          // Terminal failure: row was never persisted server-side, undo locally
          console.warn(`Stage 5E: insertBudgetCategory failed for row ${row.id}, removing locally:`, err);
          const idx = list.findIndex(r => r.id === row.id);
          if (idx !== -1) list.splice(idx, 1);
          expandedRows.delete(row.id);
          if (pendingAddRow && pendingAddRow.rowId === row.id) {
            pendingAddRow = null;
          }
          renderAll();
          debouncedSave();
        }
      );
    }
  }

  // ============================================================
  // MONTH PICKER
  // ============================================================
  function buildMonthPicker() {
    const sections = document.querySelectorAll('.month-picker-section');
    if (!sections.length) return;

    const [y, m]   = currentMonth.split('-').map(Number);
    const labelText = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    sections.forEach((section, idx) => {
      section.innerHTML = '';
      const suffix  = idx === 0 ? '' : `-${idx}`;
      const prevBtn = el('button', { className: 'btn-icon', 'aria-label': 'Previous month', id: `month-prev${suffix}` }, '‹');
      const nextBtn = el('button', { className: 'btn-icon', 'aria-label': 'Next month',     id: `month-next${suffix}` }, '›');
      const label   = el('button', {
        className:       'month-label',
        id:              `month-label${suffix}`,
        'aria-label':    'Select month and year',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
      });
      label.textContent = labelText;

      prevBtn.addEventListener('click', () => navigateMonth(-1));
      nextBtn.addEventListener('click', () => navigateMonth(1));
      label.addEventListener('click', () => toggleMonthDropdown(label));

      section.append(prevBtn, label, nextBtn);
    });
  }

  async function navigateMonth(delta) {
    flushSalaryEditSession();
    const [y, m] = currentMonth.split('-').map(Number);
    currentMonth = toMonthKey(new Date(y, m - 1 + delta, 1));
    expandedRows.clear();
    ensureMonth(currentMonth);
    ensureSalaryMonth(currentMonth);
    saveState();
    if (apiCategoriesCache) applyApiCategoriesToMonth(apiCategoriesCache, currentMonth);
    showLoadingOverlay();
    const [apiSalary, apiAdjustments, apiEntries, apiTransactions] = await Promise.all([
      loadSalaryFromApi(currentMonth),
      loadAdjustmentsFromApi(currentMonth),
      loadMonthlyEntriesFromApi(currentMonth),
      loadTransactionsFromApi(currentMonth),
    ]);
    applyApiSalaryToMonth(apiSalary, currentMonth);
    await ensureSalaryRecordExists(currentMonth);
    applyApiAdjustmentsToMonth(apiAdjustments, currentMonth);
    applyApiMonthlyEntriesToMonth(apiEntries, currentMonth);
    if (monthIsFresh(apiEntries)) await seedExpectedFromPriorMonth(currentMonth);
    await ensureMonthlyEntriesExist(currentMonth);
    applyApiTransactionsToMonth(apiTransactions, currentMonth);
    buildMonthPicker();
    hideLoadingOverlay();
    renderAll();
    closeMonthDropdown();
  }

  let monthDropdownEl    = null;
  let monthDropdownLabel = null;

  function toggleMonthDropdown(label) {
    if (monthDropdownEl) { closeMonthDropdown(); return; }
    if (!label) label = document.querySelector('.month-label');
    if (!label) return;
    monthDropdownLabel = label;

    const [cy] = currentMonth.split('-').map(Number);
    let dropdownYear = cy;

    const dropdown = el('div', { className: 'month-dropdown', role: 'listbox', 'aria-label': 'Select month and year' });

    const yearRow   = el('div', { className: 'month-dropdown-year' });
    const yearPrev  = el('button', { className: 'btn-icon', 'aria-label': 'Previous year' }, '‹');
    const yearNext  = el('button', { className: 'btn-icon', 'aria-label': 'Next year'     }, '›');
    const yearLabel = el('span',  { className: 'year-label', textContent: String(cy) });

    const refreshMonthBtns = () => {
      yearLabel.textContent = String(dropdownYear);
      dropdown.querySelectorAll('.month-btn').forEach(btn => {
        const key = `${dropdownYear}-${String(btn.dataset.month).padStart(2, '0')}`;
        btn.classList.toggle('selected', key === currentMonth);
        btn.setAttribute('aria-selected', key === currentMonth ? 'true' : 'false');
      });
    };

    yearPrev.addEventListener('click', () => { dropdownYear--; refreshMonthBtns(); });
    yearNext.addEventListener('click', () => { dropdownYear++; refreshMonthBtns(); });
    yearRow.append(yearPrev, yearLabel, yearNext);
    dropdown.appendChild(yearRow);

    const grid  = el('div', { className: 'month-dropdown-grid', role: 'group' });
    ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].forEach((name, i) => {
      const m   = i + 1;
      const key = `${cy}-${String(m).padStart(2, '0')}`;
      const btn = el('button', {
        className:       'month-btn' + (key === currentMonth ? ' selected' : ''),
        role:            'option',
        'aria-selected': key === currentMonth ? 'true' : 'false',
        'data-month':    String(m),
        textContent:     name,
      });
      btn.addEventListener('click', async () => {
        flushSalaryEditSession();
        currentMonth = `${dropdownYear}-${String(m).padStart(2, '0')}`;
        expandedRows.clear();
        ensureMonth(currentMonth);
        ensureSalaryMonth(currentMonth);
        saveState();
        if (apiCategoriesCache) applyApiCategoriesToMonth(apiCategoriesCache, currentMonth);
        showLoadingOverlay();
        const [apiSalary, apiAdjustments, apiEntries, apiTransactions] = await Promise.all([
          loadSalaryFromApi(currentMonth),
          loadAdjustmentsFromApi(currentMonth),
          loadMonthlyEntriesFromApi(currentMonth),
          loadTransactionsFromApi(currentMonth),
        ]);
        applyApiSalaryToMonth(apiSalary, currentMonth);
        await ensureSalaryRecordExists(currentMonth);
        applyApiAdjustmentsToMonth(apiAdjustments, currentMonth);
        applyApiMonthlyEntriesToMonth(apiEntries, currentMonth);
        if (monthIsFresh(apiEntries)) await seedExpectedFromPriorMonth(currentMonth);
        await ensureMonthlyEntriesExist(currentMonth);
        applyApiTransactionsToMonth(apiTransactions, currentMonth);
        closeMonthDropdown();
        buildMonthPicker();
        hideLoadingOverlay();
        renderAll();
      });
      grid.appendChild(btn);
    });
    dropdown.appendChild(grid);

    const rect = label.getBoundingClientRect();
    dropdown.style.top  = `${rect.bottom + 6}px`;
    dropdown.style.left = `${rect.left}px`;
    document.body.appendChild(dropdown);
    monthDropdownEl = dropdown;
    label.setAttribute('aria-expanded', 'true');

    setTimeout(() => document.addEventListener('click', onOutsideDropdown), 0);
  }

  function onOutsideDropdown(e) {
    if (monthDropdownEl && !monthDropdownEl.contains(e.target)) closeMonthDropdown();
  }

  function closeMonthDropdown() {
    monthDropdownEl?.remove();
    monthDropdownEl = null;
    document.removeEventListener('click', onOutsideDropdown);
    monthDropdownLabel?.setAttribute('aria-expanded', 'false');
    monthDropdownLabel = null;
  }

  // ============================================================
  // INLINE CONFIRMATION
  // ============================================================
  function confirmInline(btn, message, onConfirm) {
    if (btn.dataset.confirming) return;
    btn.dataset.confirming = '1';
    const original = btn.textContent;
    btn.textContent = message;
    btn.disabled    = true;

    const yesBtn = el('button', { className: 'btn-secondary', style: 'margin-left:8px;', textContent: T('confirmYes') });
    const noBtn  = el('button', { className: 'btn-danger',    style: 'margin-left:4px;', textContent: T('confirmCancel') });

    const cleanup = () => {
      btn.textContent = original;
      btn.disabled    = false;
      delete btn.dataset.confirming;
      yesBtn.remove();
      noBtn.remove();
    };

    yesBtn.addEventListener('click', () => { cleanup(); onConfirm(); });
    noBtn.addEventListener('click',  cleanup);
    btn.insertAdjacentElement('afterend', noBtn);
    btn.insertAdjacentElement('afterend', yesBtn);
    yesBtn.focus();
  }

  // ============================================================
  // RESET / CLEAR
  // ============================================================
  function resetCurrentMonth() {
    const md = state.months[currentMonth];
    if (!md) return;
    const allRows = [
      ...(md.income || []),
      ...Object.values(md.categories || {}).flatMap(l => l || []),
    ];

    // Capture ids BEFORE local mutation for the Supabase dual-write.
    const txnIds         = allRows.flatMap(r => (r.transactions || []).map(t => t.id));
    const adjIds         = allRows.flatMap(r => (r.adjustments  || []).map(a => a.id));
    const monthlyEntryIds = allRows.map(r => r.monthly_entry_id).filter(Boolean);

    pushUndo(`reset ${currentMonth}`);

    // Local mutation — immediate UI feedback. Mirror the trigger by zeroing
    // row.actual only when it's already a number (matches bumpRowActual's
    // guard so getActual's sumTransactions fallback stays intact).
    for (const r of allRows) {
      r.transactions = [];
      r.adjustments  = [];
      r.expected     = 0;
      if (typeof r.actual === 'number' && !isNaN(r.actual)) {
        r.actual = 0;
      }
    }
    expandedRows.clear();
    saveState();
    renderAll();

    // Dual-write to Supabase: delete transactions first so the trigger settles
    // monthly_entries.actual to 0 before we update expected; then soft-delete
    // adjustments. Idempotent — failed ops can be retried by re-running Reset.
    (async () => {
      showLoadingOverlay();
      try {
        const failures = [];

        for (const id of txnIds) {
          const res = await window.puntoApi.deleteTransaction(id);
          if (!res || !res.success) failures.push(`transaction ${id}`);
        }
        for (const id of monthlyEntryIds) {
          const res = await window.puntoApi.updateMonthlyEntry({ id, expected: 0 });
          if (!res || !res.success) failures.push(`expected on entry ${id}`);
        }
        for (const id of adjIds) {
          const res = await window.puntoApi.softDeleteAdjustment(id);
          if (!res || !res.success) failures.push(`adjustment ${id}`);
        }

        if (failures.length > 0) {
          alert(
            'Reset completed with some failures:\n' +
            failures.join('\n') +
            '\n\nClick Reset again to retry the failed items.'
          );
        }
      } finally {
        hideLoadingOverlay();
      }
    })();
  }

  function clearAllData() {
    localStorage.removeItem(LS_KEY);
    state = {
      settings: { currency: 'USD', numberFormat: 'us', defaultTransactionDate: 'today' },
      months: {},
    };
    expandedRows.clear();
    undoStack.length  = 0;
    redoStack.length  = 0;
    pendingUndo       = null;
    pendingAddRow     = null;
    ensureMonth(currentMonth);
    saveState();
    renderAll();
    syncSettingsUI();
  }

  // ============================================================
  // COPY FROM PREVIOUS MONTH
  // ============================================================
  function getPrevMonthKey() {
    const [y, m] = currentMonth.split('-').map(Number);
    return toMonthKey(new Date(y, m - 2, 1));
  }

  function totalRowCount(md) {
    if (!md) return 0;
    return (md.income?.length || 0) +
      Object.values(md.categories || {}).reduce((s, l) => s + (l?.length || 0), 0);
  }

  function syncCopyBtnLabel() {
    const btn = document.getElementById('copy-prev-month-btn');
    if (!btn) return;
    const prevKey  = getPrevMonthKey();
    const [y, m]   = prevKey.split('-').map(Number);
    const prevName = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    btn.textContent = `Copy from ${prevName}`;
  }

  function copyFromPrevMonth() {
    const prevKey  = getPrevMonthKey();
    const prevMd   = state.months[prevKey];
    const [py, pm] = prevKey.split('-').map(Number);
    const prevName = new Date(py, pm - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const [cy, cm] = currentMonth.split('-').map(Number);
    const currName = new Date(cy, cm - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    if (totalRowCount(prevMd) === 0) {
      alert(`No data in ${prevName} to copy from.`);
      return;
    }

    const md = state.months[currentMonth];
    const message = totalRowCount(md) > 0
      ? `Copy expected values from ${prevName} into ${currName}? This will replace all existing rows in ${currName}.`
      : `Copy expected values from ${prevName} into ${currName}?`;

    if (!confirm(message)) return;

    pushUndo(`copy from ${prevName}`);
    const copyRows = list => (list || []).map((r, i) => {
      const nr = newRow(r.name, r.expected, r.order ?? i);
      if (r.subtype) nr.subtype = r.subtype;
      return nr;
    });
    md.income                  = copyRows(prevMd.income);
    md.categories.fixed        = copyRows(prevMd.categories?.fixed);
    md.categories.variable     = copyRows(prevMd.categories?.variable);
    md.categories.recreational = copyRows(prevMd.categories?.recreational);
    md.categories.savings      = copyRows(prevMd.categories?.savings);
    md.categories.debt         = copyRows(prevMd.categories?.debt);

    expandedRows.clear();
    saveState();
    renderAll();
  }

  // ============================================================
  // APPLY CURRENT MONTH TO FUTURE MONTHS
  // ============================================================
  function getFutureMonthKeys() {
    return Object.keys(state.months || {})
      .filter(k => k > currentMonth)
      .sort();
  }

  // Next N month keys after currentMonth (rolling, regardless of whether they
  // exist in state yet). Used by apply-to-future to write a fixed horizon.
  function getForwardMonthKeys(count) {
    const [y, m] = currentMonth.split('-').map(Number);
    const keys = [];
    for (let i = 1; i <= count; i++) {
      keys.push(toMonthKey(new Date(y, m - 1 + i, 1)));
    }
    return keys;
  }

  function syncApplyFutureBtnLabel() {
    const btn = document.getElementById('apply-future-btn');
    if (!btn) return;
    const [y, m]   = currentMonth.split('-').map(Number);
    const currName = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    btn.textContent = `Apply ${currName} to future months`;
  }

  function applyCurrentToFutureMonths() {
    const md       = state.months[currentMonth];
    const [cy, cm] = currentMonth.split('-').map(Number);
    const currName = new Date(cy, cm - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const futureKeys = getForwardMonthKeys(12);

    const message = `Apply ${currName}'s Expected values and category setup to the next 12 months? Future months will inherit category names, Expected amounts, and ordering. Actual spending values will not be touched.`;
    if (!confirm(message)) return;

    pushUndo(`apply ${currName} to future months`);

    const buildList = (currList, futList) => {
      const futByName = new Map();
      (futList || []).forEach(r => { if (!futByName.has(r.name)) futByName.set(r.name, r); });
      return (currList || []).map((cr, i) => {
        const existing = futByName.get(cr.name);
        if (existing) {
          return {
            id:           existing.id,
            name:         cr.name,
            expected:     cr.expected,
            order:        cr.order ?? i,
            transactions: existing.transactions || [],
            adjustments:  existing.adjustments  || [],
            ...(cr.subtype ? { subtype: cr.subtype } : (existing.subtype ? { subtype: existing.subtype } : {})),
          };
        }
        const nr = newRow(cr.name, cr.expected, cr.order ?? i);
        if (cr.subtype) nr.subtype = cr.subtype;
        return nr;
      });
    };

    // Materialize each of the 12 forward months locally first so buildList has
    // somewhere to write. ensureMonth is idempotent.
    futureKeys.forEach(ensureMonth);

    futureKeys.forEach(key => {
      const fmd = state.months[key];
      if (!fmd) return;
      if (!fmd.categories) fmd.categories = {};
      fmd.income                  = buildList(md?.income,                  fmd.income);
      fmd.categories.fixed        = buildList(md?.categories?.fixed,        fmd.categories.fixed);
      fmd.categories.variable     = buildList(md?.categories?.variable,     fmd.categories.variable);
      fmd.categories.recreational = buildList(md?.categories?.recreational, fmd.categories.recreational);
      fmd.categories.savings      = buildList(md?.categories?.savings,      fmd.categories.savings);
      fmd.categories.debt         = buildList(md?.categories?.debt,         fmd.categories.debt);
    });

    saveState();
    renderAll();

    // Dual-write Expected values to Supabase across the 12-month horizon.
    // Expense + Savings sections only — income/salary are out of scope here.
    // Driver sources category_id from the CURRENT month's rows (real
    // budget_categories ids); future-month local rows have fresh local UUIDs
    // and cannot be used as category_id.
    (async () => {
      showLoadingOverlay();
      try {
        const expenseSections = ['fixed', 'variable', 'recreational', 'savings', 'debt'];
        const sourcePayloads = [];
        for (const sectionKey of expenseSections) {
          const list = md?.categories?.[sectionKey] || [];
          for (const sourceRow of list) {
            if (!sourceRow.id) continue;
            sourcePayloads.push({
              category_id: sourceRow.id,
              expected:    parseAmount(sourceRow.expected || 0),
              sectionKey,
              name:        sourceRow.name,
            });
          }
        }

        const failures = [];

        for (const futureKey of futureKeys) {
          const res = await window.puntoApi.getMonthlyEntries(futureKey);
          if (!res || !res.success) {
            failures.push(`${futureKey} (load failed)`);
            continue;
          }
          const entryByCategoryId = new Map();
          for (const entry of (res.data || [])) {
            entryByCategoryId.set(entry.category_id, entry);
          }

          for (const p of sourcePayloads) {
            const existingEntry = entryByCategoryId.get(p.category_id);
            if (existingEntry) {
              const upd = await window.puntoApi.updateMonthlyEntry({
                id:       existingEntry.id,
                expected: p.expected,
              });
              if (!upd || !upd.success) {
                failures.push(`${futureKey} (${p.name})`);
              }
            } else {
              const ins = await window.puntoApi.insertMonthlyEntry({
                category_id: p.category_id,
                month:       futureKey,
                expected:    p.expected,
                actual:      0,
              });
              if (!ins || !ins.success) {
                failures.push(`${futureKey} (${p.name})`);
                continue;
              }
              // Stamp the new monthly_entry_id onto the matching future-month
              // row (by name within the same section) so a later visit's
              // ensureMonthlyEntriesExist sees it and doesn't re-create.
              const fmd = state.months[futureKey];
              const futList = fmd?.categories?.[p.sectionKey] || [];
              const target = futList.find(r => r.name === p.name);
              if (target && ins.data && ins.data.id) {
                target.monthly_entry_id = ins.data.id;
              }
            }
          }
        }

        saveState();
        if (failures.length > 0) {
          alert(
            'Apply to future months completed with some failures:\n' +
            failures.join('\n') +
            '\n\nTry clicking the button again to retry the failed writes.'
          );
        }
      } finally {
        hideLoadingOverlay();
      }
    })();
  }

  // ============================================================
  // SALARY PAGE
  // ============================================================
  let salaryEditSession = null; // { snapshot, monthKey, timer }
  const SALARY_DEBOUNCE_MS = 1000;

  function getSalaryRecord(key) {
    if (!state.salaryData) state.salaryData = {};
    if (!state.salaryData[key]) ensureSalaryMonth(key);
    return state.salaryData[key];
  }

  function sumDeductions(rec) {
    return (rec.deductions || []).reduce((acc, d) => acc + parseAmount(d.amount), 0);
  }

  function computeTakeHome(rec) {
    const monthlyGross = parseAmount(rec.annualGross) / 12;
    return monthlyGross - sumDeductions(rec) - parseAmount(rec.taxes);
  }

  function renderSalary() {
    const rec = getSalaryRecord(currentMonth);

    const annualInput = document.getElementById('salary-annual-gross');
    if (annualInput && document.activeElement !== annualInput) {
      annualInput.value = formatCurrency(parseAmount(rec.annualGross));
    }

    const taxesInput = document.getElementById('salary-taxes');
    if (taxesInput && document.activeElement !== taxesInput) {
      taxesInput.value = formatCurrency(parseAmount(rec.taxes));
    }

    renderDeductions(rec);
    renderSalaryDerived();
    syncSalaryApplyFutureBtnLabel();
  }

  function getFutureSalaryMonthKeys() {
    return Object.keys(state.salaryData || {})
      .filter(k => k > currentMonth)
      .sort();
  }

  function syncSalaryApplyFutureBtnLabel() {
    const btn = document.getElementById('salary-apply-future-btn');
    if (!btn) return;
    const [y, m]   = currentMonth.split('-').map(Number);
    const currName = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    btn.textContent = `Apply ${currName} to all future months`;
  }

  function applySalaryToFutureMonths() {
    const [cy, cm] = currentMonth.split('-').map(Number);
    const currName = new Date(cy, cm - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const futureKeys = getFutureSalaryMonthKeys();
    if (futureKeys.length === 0) {
      alert('No future months have salary data yet. New months will inherit from the most recent month when you visit them.');
      return;
    }

    const message = `Apply ${currName}'s salary setup to ${futureKeys.length} future month(s)? This will overwrite annual gross, deductions, and taxes in those months. Actuals on the Budget page will not be affected.`;
    if (!confirm(message)) return;

    flushSalaryEditSession();
    pushUndo(`apply ${currName} to future months`);

    const sourceRec = state.salaryData?.[currentMonth];
    if (!sourceRec) return;

    for (const k of futureKeys) {
      state.salaryData[k] = cloneSalaryData(sourceRec, 'inherited');
    }

    saveState();
    renderAll();

    // Stage 5F-2: dual-write each future month. Serialize per-month so the
    // salary_record upsert lands before its deduction inserts.
    (async () => {
      for (const k of futureKeys) {
        await dualWriteSalaryMonthToApi(k);
      }
    })();
  }

  function renderDeductions(rec) {
    const wrap = document.getElementById('salary-deductions');
    if (!wrap) return;
    const activeId = document.activeElement?.closest?.('[data-deduction-id]')?.dataset?.deductionId;
    const activeField = document.activeElement?.dataset?.deductionField;
    wrap.innerHTML = '';
    (rec.deductions || []).forEach(d => {
      wrap.appendChild(buildDeductionRow(d, activeId === d.id ? activeField : null));
    });
  }

  function buildDeductionRow(deduction, focusField) {
    const row = el('div', {
      className:           'salary-row salary-row--deduction',
      'data-deduction-id': deduction.id,
    });

    const nameInput = el('input', {
      type:                    'text',
      placeholder:             'Deduction name',
      value:                   deduction.name || '',
      'aria-label':            'Deduction name',
      'data-deduction-field':  'name',
    });

    const rawAmount = parseAmount(deduction.amount);
    const amountInput = el('input', {
      type:                    'text',
      inputmode:               'decimal',
      value:                   formatCurrency(rawAmount),
      'aria-label':            'Deduction amount',
      'data-deduction-field':  'amount',
    });
    amountInput.addEventListener('focus', () => {
      const raw = parseAmount(amountInput.value);
      amountInput.value = raw === 0 ? '' : String(raw);
    });
    amountInput.addEventListener('blur', () => {
      const raw = parseAmount(amountInput.value);
      amountInput.value = formatCurrency(raw);
    });
    amountInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    });

    const typeSelect = el('select', {
      className:              'salary-deduction-type',
      'aria-label':           'Deduction type',
      'data-deduction-field': 'type',
    });
    typeSelect.append(
      el('option', { value: 'investment', textContent: 'Investment' }),
      el('option', { value: 'expense',    textContent: 'Expense'    }),
    );
    typeSelect.value = normalizeDeductionType(deduction.type, deduction.name);

    const removeBtn = el('button', {
      className:    'btn-remove',
      type:         'button',
      'aria-label': 'Remove deduction',
      'data-action':'remove-deduction',
      textContent:  '×',
    });

    row.append(nameInput, amountInput, typeSelect, removeBtn);

    if (focusField === 'name')   setTimeout(() => nameInput.focus(),   0);
    if (focusField === 'amount') setTimeout(() => amountInput.focus(), 0);
    if (focusField === 'type')   setTimeout(() => typeSelect.focus(),  0);

    return row;
  }

  function renderSalaryDerived() {
    const rec = getSalaryRecord(currentMonth);
    const monthlyGross = parseAmount(rec.annualGross) / 12;
    const totalDed     = sumDeductions(rec);
    const takeHome     = monthlyGross - totalDed - parseAmount(rec.taxes);

    const monthlyEl = document.getElementById('salary-monthly-gross');
    if (monthlyEl) monthlyEl.textContent = formatCurrency(monthlyGross);

    const totalEl = document.getElementById('salary-deductions-total');
    if (totalEl) totalEl.textContent = formatCurrency(totalDed);

    const takeHomeValEl = document.getElementById('salary-take-home-value');
    if (takeHomeValEl) takeHomeValEl.textContent = formatCurrency(takeHome);

    const takeHomeBox = document.getElementById('salary-take-home');
    if (takeHomeBox) takeHomeBox.classList.toggle('salary-take-home--negative', takeHome < 0);
  }

  function beginSalaryEditSession() {
    if (salaryEditSession) {
      clearTimeout(salaryEditSession.timer);
    } else {
      salaryEditSession = {
        snapshot: JSON.parse(JSON.stringify(state)),
        monthKey: currentMonth,
        timer:    null,
      };
    }
    salaryEditSession.timer = setTimeout(endSalaryEditSession, SALARY_DEBOUNCE_MS);
  }

  // Force any pending salary debounced writes (record + per-deduction) to
  // fire NOW. Used by flushSalaryEditSession and beforeunload to close the
  // localStorage-vs-Supabase drift window when the user leaves the page
  // within the 800ms debounce window. Fire-and-forget (synchronous fire of
  // the inner fn, which schedules its own async upsert/update).
  function flushPendingSalaryApiWrites() {
    salaryRecordFlushers.forEach(f => { try { f.flush(); } catch (e) {} });
    salaryDeductionFlushers.forEach(f => { try { f.flush(); } catch (e) {} });
  }

  function flushSalaryEditSession() {
    if (!salaryEditSession) return;
    clearTimeout(salaryEditSession.timer);
    const session = salaryEditSession;
    salaryEditSession = null;
    if (JSON.stringify(state) === JSON.stringify(session.snapshot)) return;
    pushUndo('salary edit', session.snapshot);
    saveState();
    // Stage 5F-2: flush any pending salary API writes too, so the DB
    // matches localStorage after the user leaves the tab / closes the page.
    flushPendingSalaryApiWrites();
  }

  function endSalaryEditSession() {
    const session = salaryEditSession;
    if (!session) return;
    salaryEditSession = null;
    if (JSON.stringify(state) === JSON.stringify(session.snapshot)) return;

    pushUndo('salary edit', session.snapshot);
    saveState();

    const realMonth = toMonthKey(new Date());
    if (session.monthKey < realMonth) return;

    const targets = collectInheritedFutureSalaryKeys(session.monthKey);
    if (targets.length === 0) return;

    if (confirm('Apply this change to future months too?')) {
      pushUndo('apply salary forward');
      const sourceRec = state.salaryData[session.monthKey];
      if (!sourceRec) return;
      for (const k of targets) {
        state.salaryData[k] = cloneSalaryData(sourceRec, 'inherited');
      }
      saveState();
      renderSalary();

      // Stage 5F-2: dual-write each cloned future month, serialized.
      (async () => {
        for (const k of targets) {
          await dualWriteSalaryMonthToApi(k);
        }
      })();
    }
  }

  function collectInheritedFutureSalaryKeys(fromMonth) {
    const keys = Object.keys(state.salaryData || {})
      .filter(k => k > fromMonth)
      .sort();
    const out = [];
    for (const k of keys) {
      if (state.salaryData[k]?.salarySource === 'manual') break;
      out.push(k);
    }
    return out;
  }

  function handleSalaryInput(e) {
    const target = e.target;
    if (target.id === 'salary-annual-gross') {
      const rec = getSalaryRecord(currentMonth);
      rec.annualGross  = parseAmount(target.value);
      rec.salarySource = 'manual';
      beginSalaryEditSession();
      renderSalaryDerived();
      debouncedSave();
      // Stage 5F-2: debounced dual-write to salary_records.
      getSalaryRecordFlusher(currentMonth)();
      return;
    }
    if (target.id === 'salary-taxes') {
      const rec = getSalaryRecord(currentMonth);
      rec.taxes        = parseAmount(target.value);
      rec.salarySource = 'manual';
      beginSalaryEditSession();
      renderSalaryDerived();
      debouncedSave();
      // Stage 5F-2: debounced dual-write to salary_records.
      getSalaryRecordFlusher(currentMonth)();
      return;
    }
    const dedRow = target.closest('[data-deduction-id]');
    if (dedRow) {
      const rec = getSalaryRecord(currentMonth);
      const ded = (rec.deductions || []).find(d => d.id === dedRow.dataset.deductionId);
      if (!ded) return;
      const field = target.dataset.deductionField;
      if (field === 'name')   ded.name   = target.value;
      if (field === 'amount') ded.amount = parseAmount(target.value);
      if (field === 'type')   ded.type   = normalizeDeductionType(target.value, ded.name);
      rec.salarySource = 'manual';
      beginSalaryEditSession();
      if (field === 'amount') renderSalaryDerived();
      debouncedSave();
      // Stage 5F-2: debounced dual-write to salary_deductions. Skip if no
      // DB id yet (race with ensureSalaryRecordExists for fresh months —
      // localStorage stays authoritative; 5H migration catches drift).
      if (ded.id && ded.salaryRecordId) {
        const apiFields = {};
        if (field === 'name')   apiFields.name = ded.name;
        if (field === 'amount') apiFields.amount = ded.amount;
        if (field === 'type')   apiFields.deductionType = ded.type;
        if (Object.keys(apiFields).length > 0) {
          getSalaryDeductionFlusher(ded.id)(apiFields, ded, currentMonth);
        }
      } else {
        console.warn(`5F-2: deduction edit skipped — no DB id yet for "${ded.name}"`);
      }
      // Also dual-write the salary_record so updated_at reflects the edit.
      getSalaryRecordFlusher(currentMonth)();
    }
  }

  async function handleSalaryClick(e) {
    if (e.target.id === 'salary-apply-future-btn') {
      applySalaryToFutureMonths();
      return;
    }

    if (e.target.id === 'salary-add-deduction') {
      flushSalaryEditSession();
      pushUndo('add deduction');
      const rec = getSalaryRecord(currentMonth);
      rec.deductions = rec.deductions || [];
      const newDed = newDeduction('', 0);
      rec.deductions.push(newDed);
      rec.salarySource = 'manual';
      saveState();
      renderDeductions(rec);
      renderSalaryDerived();
      const wrap = document.getElementById('salary-deductions');
      const lastRow = wrap?.lastElementChild;
      lastRow?.querySelector('input[data-deduction-field="name"]')?.focus();
      // Stage 5F-2: dual-write the new deduction. Needs rec.id (the
      // salary_record's UUID). If missing, fall back to a full month
      // dual-write which will upsert the record AND insert this deduction.
      if (window.puntoApi && typeof window.puntoApi.insertSalaryDeduction === 'function') {
        if (rec.id) {
          const sortOrder = rec.deductions.length - 1;
          window.puntoApi.insertSalaryDeduction({
            id:             newDed.id,
            salaryRecordId: rec.id,
            name:           newDed.name,
            amount:         parseAmount(newDed.amount),
            deductionType:  newDed.type || 'investment',
            sortOrder,
          }).then(r => {
            if (r && r.success && r.data) {
              newDed.salaryRecordId = rec.id;
            } else {
              console.warn(`5F-2 dual-write failed at insertSalaryDeduction (add):`,
                           r && r.error);
            }
          });
        } else {
          // No salary_record id yet — kick off a full month dual-write.
          dualWriteSalaryMonthToApi(currentMonth);
        }
      }
      return;
    }

    const removeBtn = e.target.closest('[data-action="remove-deduction"]');
    if (removeBtn) {
      const dedRow = removeBtn.closest('[data-deduction-id]');
      if (!dedRow) return;
      flushSalaryEditSession();
      pushUndo('delete deduction');
      const rec = getSalaryRecord(currentMonth);
      const dedId = dedRow.dataset.deductionId;
      const removedDed = (rec.deductions || []).find(d => d.id === dedId) || null;
      rec.deductions = (rec.deductions || []).filter(d => d.id !== dedId);
      rec.salarySource = 'manual';
      saveState();
      renderDeductions(rec);
      renderSalaryDerived();
      // Stage 5F-2: soft-delete the deduction in Supabase. Stage 5F-4 Part 4
      // additionally refreshes the take-home salary_seed for the current
      // month since removing a deduction changes computeTakeHome(rec).
      // Stage 5F-4 Part 5 layers hybrid deletion on top: delete salary_seed
      // transactions for current+future months, preserve past, detach the
      // budget_categories row, drop the bridge Map entry.
      if (removedDed && removedDed.salaryRecordId
          && window.puntoApi && typeof window.puntoApi.softDeleteSalaryDeduction === 'function') {
        const r = await window.puntoApi.softDeleteSalaryDeduction(removedDed.id);
        if (!r || !r.success) {
          console.warn(`5F-2 dual-write failed at softDeleteSalaryDeduction (${removedDed.id}):`,
                       r && r.error);
        }
        // Drop the (now-stale) debouncer reference for the removed id.
        salaryDeductionFlushers.delete(removedDed.id);
      } else if (removedDed) {
        console.warn(`5F-2: skipped softDeleteSalaryDeduction — no DB id for "${removedDed.name}"`);
      }

      // Stage 5F-4 Part 5: hybrid deletion of linked deduction's shadow rows.
      // Only investment-type deductions were promoted; expense-type ones
      // skip the entire block.
      if (removedDed && (removedDed.type || 'investment') === 'investment') {
        const normName = normalizeDeductionName(removedDed.name);
        const bridgeEntry = linkedBudgetCategoryIds.get(normName);
        if (bridgeEntry) {
          // 5.4/5.5: delete salary_seed transactions for current + future
          // months. Past months are preserved (monthKey < currentMonth).
          // Failure to delete a single transaction is logged but doesn't
          // abort the rest — match the rest-of-codebase best-effort pattern.
          const toDelete = [];
          for (const [monthKey, txnId] of bridgeEntry.salarySeedTxnIdByMonth.entries()) {
            if (monthKey >= currentMonth) {
              toDelete.push({ monthKey, txnId });
            }
          }
          await Promise.all(toDelete.map(async ({ monthKey, txnId }) => {
            const dr = await window.puntoApi.deleteSalarySeedTransaction(txnId);
            if (dr && dr.success) {
              bridgeEntry.salarySeedTxnIdByMonth.delete(monthKey);
              // Reset actualByMonth to 0 — trigger will have recomputed
              // monthly_entries.actual on the DB side. Optimistic mirror.
              bridgeEntry.actualByMonth.set(monthKey, 0);
            } else {
              console.warn(`5F-4 Part 5: deleteSalarySeedTransaction failed for ${monthKey}:`,
                           dr && dr.error);
            }
          }));

          // 5.6: detach the budget_categories row globally. is_linked=false
          // means future month-loads won't filter it out via Part 1B's guard
          // — the row appears as a regular budget category.
          if (bridgeEntry.budgetCategoryId
              && window.puntoApi && typeof window.puntoApi.updateBudgetCategory === 'function') {
            const ur = await window.puntoApi.updateBudgetCategory({
              id:                  bridgeEntry.budgetCategoryId,
              is_linked:           false,
              linked_deduction_id: null,
            });
            if (!ur || !ur.success) {
              console.warn(`5F-4 Part 5: updateBudgetCategory detach failed:`, ur && ur.error);
            } else if (Array.isArray(apiCategoriesCache)) {
              // Update the in-session cache so subsequent month-loads see
              // is_linked=false (the row will appear in md.categories.* as
              // a normal row). Without this, Part 1B's filter would keep
              // hiding the row for the rest of the session.
              const cached = apiCategoriesCache.find(
                c => c && c.id === bridgeEntry.budgetCategoryId
              );
              if (cached) {
                cached.is_linked = false;
                cached.linked_deduction_id = null;
              }
            }
          }

          // Defensive: walk every loaded month's row tree and clear any
          // linkedToSalary / isLinked flag that happens to match this
          // budget_category's id. Post-Part-1B-filter, no loaded row should
          // have row.id === budgetCategoryId, but this catches legacy state
          // (rows already in memory from before 5F-4 shipped).
          for (const md of Object.values(state.months || {})) {
            if (!md) continue;
            const allLists = [md.income || [], ...Object.values(md.categories || {})];
            for (const list of allLists) {
              for (const row of list || []) {
                if (row && row.id === bridgeEntry.budgetCategoryId) {
                  row.linkedToSalary = false;
                  row.isLinked       = false;
                }
              }
            }
          }

          // 5.7: drop the bridge Map entry. Re-adding the deduction by name
          // will go through Part 3's promote path which creates a fresh entry.
          linkedBudgetCategoryIds.delete(normName);
        }
      }

      // Stage 5F-4 Part 4 hook (iii): take-home changed (deduction removed).
      await upsertTakeHomeSalarySeed(currentMonth);

      // Stage 5F-4 Part 5: re-render so the Budget tab reflects the detach.
      // Salary tab inputs preserve focus via renderDeductions' activeId logic.
      renderAll();
    }
  }

  function bindSalaryInputFormatting() {
    const annualInput = document.getElementById('salary-annual-gross');
    const taxesInput  = document.getElementById('salary-taxes');
    [annualInput, taxesInput].forEach(input => {
      if (!input || input.dataset.formattingBound === '1') return;
      input.dataset.formattingBound = '1';
      input.addEventListener('focus', () => {
        const raw = parseAmount(input.value);
        input.value = raw === 0 ? '' : String(raw);
      });
      input.addEventListener('blur', () => {
        const raw = parseAmount(input.value);
        input.value = formatCurrency(raw);
      });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
      });
    });
  }

  // ============================================================
  // EXPORT JSON
  // ============================================================
  function exportJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = el('a', { href: url, download: `puntobase-${currentMonth}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ============================================================
  // SETTINGS UI
  // ============================================================
  function syncSettingsUI() {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
    set('currency-select',  state.settings.currency               ?? 'USD');
    set('format-select',    state.settings.numberFormat           ?? 'us');
    set('txndate-select',   state.settings.defaultTransactionDate ?? 'today');
  }

  function renderAccountSection(user) {
    const settingsPage = document.querySelector('#page-settings .settings-page');
    if (!settingsPage) return;
    if (document.getElementById('account-section')) return;

    const section = document.createElement('section');
    section.id = 'account-section';
    section.className = 'settings-section';
    section.setAttribute('aria-labelledby', 'settings-account-heading');

    const heading = document.createElement('h3');
    heading.id = 'settings-account-heading';
    heading.textContent = 'Account';

    const emailEl = document.createElement('p');
    emailEl.style.cssText = 'font-family:var(--font-mono);font-size:var(--text-sm);color:var(--color-text-muted);margin:0;word-break:break-all;';
    emailEl.textContent = user?.email || '';

    const signOutBtn = document.createElement('button');
    signOutBtn.type = 'button';
    signOutBtn.id = 'sign-out-btn';
    signOutBtn.className = 'btn-secondary';
    signOutBtn.style.alignSelf = 'flex-start';
    signOutBtn.textContent = 'Sign Out';
    signOutBtn.addEventListener('click', () => {
      if (window.puntoAuth) window.puntoAuth.signOut();
    });

    section.append(heading, emailEl, signOutBtn);
    settingsPage.appendChild(section);
  }

  // ============================================================
  // NAVIGATION
  // ============================================================
  const VALID_PAGES = ['dashboard', 'salary', 'budget', 'investing', 'settings'];

  function showPage(pageName) {
    if (!VALID_PAGES.includes(pageName)) pageName = 'budget';

    if (pageName !== 'salary') flushSalaryEditSession();

    VALID_PAGES.forEach(p => {
      document.getElementById(`page-${p}`)?.classList.add('page-hidden');
    });
    document.getElementById(`page-${pageName}`)?.classList.remove('page-hidden');

    document.querySelectorAll('.sidebar-item[data-page]').forEach(item => {
      const isActive = item.dataset.page === pageName;
      item.classList.toggle('sidebar-item--active', isActive);
      item.setAttribute('aria-current', isActive ? 'page' : 'false');
    });

    // Re-render when entering Budget or Dashboard so any salary/budget edits
    // made on another page are reflected.
    if (pageName === 'budget' || pageName === 'dashboard') renderAll();
    if (pageName === 'investing') renderInvesting();

    history.replaceState(null, '', `#${pageName}`);
  }

  function initNav() {
    const hash = window.location.hash.slice(1);
    showPage(VALID_PAGES.includes(hash) ? hash : 'budget');

    document.querySelectorAll('.sidebar-item[data-page]').forEach(item => {
      item.addEventListener('click', e => {
        e.preventDefault();
        showPage(item.dataset.page);
        closeMobileSidebar();
      });
    });
  }

  // ============================================================
  // SIDEBAR (collapse on desktop, overlay on mobile)
  // ============================================================
  const SIDEBAR_LS_KEY = 'sidebarState';

  function isSidebarCollapsed() {
    return document.documentElement.classList.contains('sidebar-collapsed');
  }

  function isMobileSidebarOpen() {
    return document.documentElement.classList.contains('sidebar-mobile-open');
  }

  function syncSidebarToggleLabel() {
    const btn = document.getElementById('sidebar-toggle-btn');
    if (!btn) return;
    btn.setAttribute('aria-label', isSidebarCollapsed() ? 'Expand sidebar' : 'Collapse sidebar');
  }

  function syncHamburgerLabel() {
    const btn = document.getElementById('hamburger-btn');
    if (!btn) return;
    btn.setAttribute('aria-label', isMobileSidebarOpen() ? 'Close menu' : 'Open menu');
  }

  function setSidebarCollapsed(collapsed) {
    document.documentElement.classList.toggle('sidebar-collapsed', collapsed);
    try { localStorage.setItem(SIDEBAR_LS_KEY, collapsed ? 'collapsed' : 'expanded'); } catch {}
    syncSidebarToggleLabel();
  }

  function openMobileSidebar() {
    document.documentElement.classList.add('sidebar-mobile-open');
    syncHamburgerLabel();
  }

  function closeMobileSidebar() {
    document.documentElement.classList.remove('sidebar-mobile-open');
    syncHamburgerLabel();
  }

  function initSidebar() {
    // Initial label sync (collapsed class may already be present from inline anti-FOUC script)
    syncSidebarToggleLabel();
    syncHamburgerLabel();

    document.getElementById('sidebar-toggle-btn')
      ?.addEventListener('click', () => setSidebarCollapsed(!isSidebarCollapsed()));

    document.getElementById('hamburger-btn')
      ?.addEventListener('click', () => {
        isMobileSidebarOpen() ? closeMobileSidebar() : openMobileSidebar();
      });

    document.getElementById('mobile-backdrop')
      ?.addEventListener('click', closeMobileSidebar);

    // Resize past the 768px breakpoint → mobile-open state no longer applies
    const mql = window.matchMedia('(min-width: 768px)');
    const onMqlChange = e => { if (e.matches) closeMobileSidebar(); };
    if (mql.addEventListener) mql.addEventListener('change', onMqlChange);
    else mql.addListener(onMqlChange); // older Safari
  }

  // ============================================================
  // BIND EVENTS
  // ============================================================
  function bindEvents() {
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (monthDropdownEl) { closeMonthDropdown(); }
        return;
      }

      // Undo/redo — skip when focus is inside a text input
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;

      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && key === 'z') {
        e.preventDefault();
        applyUndo();
        return;
      }
      if (((e.metaKey || e.ctrlKey) && e.shiftKey && key === 'z') ||
          (e.ctrlKey && !e.metaKey && key === 'y')) {
        e.preventDefault();
        applyRedo();
        return;
      }
    });

    const main = document.getElementById('main-content');
    main?.addEventListener('input', handleTableInput);
    main?.addEventListener('click', handleTableClick);

    const salaryPage = document.getElementById('page-salary');
    salaryPage?.addEventListener('input', handleSalaryInput);
    salaryPage?.addEventListener('click', handleSalaryClick);

    // Track edits to name / expected inputs for undo (capture pre-edit snapshot on focus)
    main?.addEventListener('focusin', e => {
      const input = e.target.closest('[data-field]');
      if (!input) return;
      const tr = input.closest('tr[data-id]');
      if (!tr) return;
      if (pendingAddRow) {
        if (tr.dataset.id === pendingAddRow.rowId) return; // still editing the pending-add row
        flushPendingAddRow(); // focus moved to a different row — commit
      }
      const row = findRow(tr.dataset.section, tr.dataset.id);
      pendingUndo = {
        snapshot:    JSON.parse(JSON.stringify(state)),
        description: `edit to ${row?.name || 'unnamed'}`,
      };
    });

    main?.addEventListener('focusout', e => {
      const input = e.target.closest('[data-field]');
      if (!input) return;
      const tr = input.closest('tr[data-id]');
      if (!tr) return;
      // Stage 5D: flush any pending Expected write immediately on blur.
      // Runs before the pending-add / pendingUndo early returns below so
      // it fires regardless of undo state. The monthly_entry_id guard
      // catches locally-created rows (no DB row exists yet).
      if (input.dataset.field === 'expected') {
        const { id, section } = tr.dataset;
        const row = findRow(section, id);
        if (row?.monthly_entry_id) {
          flushExpectedWrite(row, section, row.expected);
          // Cancel the still-ticking debounced timer by dropping our
          // reference. The timer's closure may still fire harmlessly
          // later with the same data — v1 accepts this as a minor
          // duplicate-write risk; see STAGE_5_PLAN.md.
          expectedFlushers.delete(row.monthly_entry_id);
        }
      }
      // Stage 5E: flush any pending Name write immediately on blur.
      // Same v1 cancel-by-recreate pattern as Expected — the pending
      // debounced timer may fire harmlessly later with the same data.
      if (input.dataset.field === 'name') {
        const { id, section } = tr.dataset;
        const row = findRow(section, id);
        if (row?.id) {
          flushNameWrite(row.id, section, row.name, row.name);
          nameFlushers.delete(row.id);
        }
      }
      if (pendingAddRow && tr.dataset.id === pendingAddRow.rowId) {
        // Only flush when focus leaves the row entirely (not just tab to next field)
        const relatedTr = e.relatedTarget?.closest?.('tr[data-id]');
        if (relatedTr?.dataset.id === pendingAddRow.rowId) return;
        flushPendingAddRow();
        return;
      }
      if (!pendingUndo) return;
      if (JSON.stringify(state) !== JSON.stringify(pendingUndo.snapshot)) {
        pushUndo(pendingUndo.description, pendingUndo.snapshot);
      }
      pendingUndo = null;
    });

    document.addEventListener('change', e => {
      if (e.target.id === 'currency-select') {
        state.settings.currency = e.target.value; saveState(); renderAll();
      }
      if (e.target.id === 'format-select') {
        state.settings.numberFormat = e.target.value; saveState(); renderAll();
      }
      if (e.target.id === 'txndate-select') {
        state.settings.defaultTransactionDate = e.target.value; saveState();
      }
    });

    document.addEventListener('click', e => {
      if (e.target.id === 'copy-prev-month-btn') { copyFromPrevMonth(); return; }
      if (e.target.id === 'apply-future-btn')    { applyCurrentToFutureMonths(); return; }
      if (e.target.id === 'export-btn')          { exportJSON(); return; }
      if (e.target.id === 'reset-month-btn')     { confirmInline(e.target, T('resetMonthConfirm'), resetCurrentMonth); return; }
      if (e.target.id === 'clear-data-btn')      { confirmInline(e.target, T('clearAllConfirm'),   clearAllData);      return; }
    });
  }

  // ============================================================
  // INIT
  // ============================================================
  async function init() {
    showLoadingOverlay();
    initState();
    // Stage 5F-3: hydrate linkedBudgetCategoryIds in parallel with the rest.
    // hydrateLinkedBudgetCategoryIds writes directly to the module-scope Map,
    // so no destructuring needed — just await it alongside the others.
    const [apiCats, apiSalary, apiAdjustments, apiEntries, apiTransactions] = await Promise.all([
      loadCategoriesFromApi(),
      loadSalaryFromApi(currentMonth),
      loadAdjustmentsFromApi(currentMonth),
      loadMonthlyEntriesFromApi(currentMonth),
      loadTransactionsFromApi(currentMonth),
      hydrateLinkedBudgetCategoryIds(),
      hydrateTakeHomeSalarySeedIds(),
    ]);
    apiCategoriesCache = apiCats;
    applyApiCategoriesToMonth(apiCategoriesCache, currentMonth);
    applyApiSalaryToMonth(apiSalary, currentMonth);
    await ensureSalaryRecordExists(currentMonth);
    applyApiAdjustmentsToMonth(apiAdjustments, currentMonth);
    applyApiMonthlyEntriesToMonth(apiEntries, currentMonth);
    if (monthIsFresh(apiEntries)) await seedExpectedFromPriorMonth(currentMonth);
    await ensureMonthlyEntriesExist(currentMonth);
    applyApiTransactionsToMonth(apiTransactions, currentMonth);
    syncSettingsUI();
    buildMonthPicker();
    bindSalaryInputFormatting();
    hideLoadingOverlay();
    renderAll();
    bindEvents();
    initNav();
    initSidebar();
    initInvesting();
    initDashboardEmptyState();
    initCsvImport();

    // Re-render when crossing the mobile breakpoint so currency formatting refreshes
    const onBreakpointChange = () => renderAll();
    if (MOBILE_MQL.addEventListener) MOBILE_MQL.addEventListener('change', onBreakpointChange);
    else MOBILE_MQL.addListener(onBreakpointChange); // older Safari
  }

  async function bootstrap() {
    if (!window.puntoAuth) {
      console.error('Punto Base auth scripts did not load. Aborting.');
      return;
    }
    const user = await window.puntoAuth.requireAuth();
    if (!user) return; // requireAuth() redirected to login.html
    await init();
    renderAccountSection(user);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  // Flush any pending debounced localStorage write before the page unloads or
  // is hidden. 5F-2 extends this to also flush pending salary API writes —
  // fire-and-forget, hands the request to the browser's network stack
  // before the page tears down.
  // TODO Stage 5C-3-2 (or 5J): flush in-flight retry queue via
  // navigator.sendBeacon on beforeunload. For v1 we accept potential
  // loss of in-retry writes on tab close.
  window.addEventListener('beforeunload', () => {
    saveState();
    flushPendingSalaryApiWrites();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveState();
      flushPendingSalaryApiWrites();
    }
  });

})();
