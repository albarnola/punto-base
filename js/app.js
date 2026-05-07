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
      resetMonthConfirm: 'Clear all transactions for this month?',
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
  let saveTimer    = null;
  const expandedRows = new Set();

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

  function newTransaction(amount, date, note = '') {
    return { id: crypto.randomUUID(), date, amount, note };
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

  function debouncedSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 250);
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

  // Linked savings/fixed rows: Actual = linked Expected (from Salary) + sum of adjustments.
  // All other rows (including the linked income row): Actual = sum of transactions.
  function getActual(row, section, monthKey = currentMonth) {
    if (isLinkedAdjustableRow(row, section, monthKey)) {
      return getLinkedExpected(row, section, monthKey) + sumAdjustments(row);
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
    return list.reduce((acc, r) => acc + sumTransactions(r), 0);
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
    const pretaxRows       = cats.pretaxInvestments || [];

    // Savings & Investments and the expense sections are post-tax only now —
    // every row's expected/actual comes from user input, no linked deductions.
    const fixedExp        = sumListExpected(fixedRows);
    const variableExp     = sumListExpected(variableRows);
    const recreationalExp = sumListExpected(recreationalRows);
    const savExp          = sumListExpected(savRows);

    const fixedAct        = sumListActual(fixedRows);
    const variableAct     = sumListActual(variableRows);
    const recreationalAct = sumListActual(recreationalRows);
    const savAct          = sumListActual(savRows);

    // SAVINGS / INVESTMENTS subtype-based actual sums (Savings & Investments).
    const savingsBySubtype = (subtype) => savRows.reduce((acc, r) =>
      acc + (getRowSubtype(r, 'savings', monthKey) === subtype ? sumTransactions(r) : 0), 0);
    const savingsActSubtype     = savingsBySubtype('savings');
    const investmentsActSubtype = savingsBySubtype('investment');

    // Pre-Tax Investments: actual = linked Expected + adjustments. Display-only
    // section — completely excluded from UNALLOCATED and NET subtractions.
    const pretaxAct = pretaxRows.reduce((acc, r) =>
      acc + getActual(r, 'pretaxInvestments', monthKey), 0);

    const expensesExp = fixedExp + variableExp + recreationalExp;
    const expensesAct = fixedAct + variableAct + recreationalAct;
    const allocatedExp = expensesExp + savExp;

    // UNALLOCATED — Take-Home (or manual income fallback) minus all post-tax
    // expected. Pre-Tax Investments are NOT subtracted: that money is already
    // deducted from gross before take-home is computed.
    const incomeBasis = salaryActive ? takeHome : incomeExp;
    const unallocated = incomeBasis - allocatedExp;

    // NET — Take-Home (or manual income fallback) minus post-tax actuals.
    // Pre-Tax Investments are NOT subtracted (already in take-home).
    const netActual = incomeBasis - expensesAct - savAct;

    return {
      incomeExpected:     incomeExp,
      incomeActual:       incomeAct,
      expensesExpected:   expensesExp,
      expensesActual:     expensesAct,
      savingsExpected:    savExp,
      savingsExpectedAll: savExp,
      savingsActual:      savingsActSubtype,                  // SAVINGS tile
      investmentsActual:  investmentsActSubtype + pretaxAct,  // INVESTMENTS tile (post-tax + pre-tax)
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

    syncSectionWithDeductions(md.categories.pretaxInvestments, investmentDeductions);
  }

  function syncSectionWithDeductions(list, deductions) {
    const dedNames = new Set(deductions.map(d => (d.name || '').trim()));

    // Remove orphaned linked rows (flag set, no matching deduction in this section).
    for (let i = list.length - 1; i >= 0; i--) {
      const row = list[i];
      if (row.linkedToSalary && !dedNames.has((row.name || '').trim())) {
        list.splice(i, 1);
      }
    }

    // Ensure every deduction has a matching row in this section; flag matches as linked.
    for (const ded of deductions) {
      const dedName = (ded.name || '').trim();
      const existing = list.find(r => (r.name || '').trim() === dedName);
      if (!existing) {
        const nextOrder = list.reduce((m, r) => Math.max(m, r.order ?? 0), -1) + 1;
        const newR = newRow(ded.name, parseAmount(ded.amount), nextOrder);
        newR.linkedToSalary = true;
        list.push(newR);
      } else if (!existing.linkedToSalary) {
        existing.linkedToSalary = true;
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
    const overIsGood = section === 'income' || section === 'savings';
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
    tr.appendChild(el('td', {}, expectedCell));
    tr.appendChild(adjustable ? el('td', {}, actualCell) : el('td', { textContent: formatCurrency(actual) }));
    tr.appendChild(el('td', { className: varianceClass, textContent: varianceText }));
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
    const amountInput = el('input', { type: 'number', className: 'txn-input-amount', placeholder: T('amountPlaceholder'), min: '0', step: '0.01' });
    const noteInput   = el('input', { type: 'text',   className: 'txn-input-note',   placeholder: T('notePlaceholder') });
    const addBtn      = el('button', { className: 'btn-add-txn', 'data-action': 'add-txn', textContent: T('addTransaction') });

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

  function renderAllTables() {
    const md = state.months[currentMonth];
    const pretaxRows = md.categories.pretaxInvestments || [];
    renderTable('income-body',             md.income,                     'income');
    renderTable('pretax-investments-body', pretaxRows,                    'pretaxInvestments');
    renderTable('fixed-body',              md.categories.fixed,           'fixed');
    renderTable('variable-body',           md.categories.variable,        'variable');
    renderTable('recreational-body',       md.categories.recreational,    'recreational');
    renderTable('savings-body',            md.categories.savings || [],   'savings');

    const pretaxSection = document.getElementById('pretax-investments-section');
    if (pretaxSection) pretaxSection.style.display = pretaxRows.length > 0 ? '' : 'none';
  }

  function renderSummary() {
    const sum = computeSummary(state.months[currentMonth]);

    const incomeEl      = document.getElementById('summary-income');
    const unallocatedEl = document.getElementById('summary-unallocated');
    const savingsEl     = document.getElementById('summary-savings');
    const investmentsEl = document.getElementById('summary-investments');
    const netEl         = document.getElementById('summary-net');
    const insightEl     = document.getElementById('summary-insight');

    if (incomeEl) incomeEl.textContent = formatCurrency(sum.incomeExpected);

    if (unallocatedEl) {
      const u = Math.round(sum.unallocated * 100) / 100;
      unallocatedEl.textContent = formatCurrency(u);
      unallocatedEl.className   = u === 0 ? 'unallocated-success'
                                : u > 0   ? 'unallocated-warning'
                                          : 'unallocated-danger';
    }

    if (savingsEl)     savingsEl.textContent     = formatCurrency(sum.savingsActual);
    if (investmentsEl) investmentsEl.textContent = formatCurrency(sum.investmentsActual);

    if (netEl) {
      netEl.textContent = formatCurrency(sum.netActual);
      netEl.className   = sum.netActual >= 0 ? 'positive' : 'negative';
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

    // TOTAL SAVED combines post-tax + pre-tax (the existing summary's
    // savings + investments tiles already split this the same way).
    const totalIncome = sum.incomeExpected;
    const totalSpent  = sum.expensesActual;
    const totalSaved  = sum.savingsActual + sum.investmentsActual;

    // NET CASH LEFT subtracts only post-tax savings — pre-tax was never
    // in the take-home pool to begin with.
    const postTaxSavingsAct = sumListActual(md.categories.savings || []);
    const netCash = totalIncome - totalSpent - postTaxSavingsAct;
    const netRounded = Math.round(netCash * 100) / 100;

    headingEl.textContent = `${monthName} at a glance`;
    incomeEl.textContent  = formatCurrency(totalIncome);
    spentEl.textContent   = formatCurrency(totalSpent);
    savedEl.textContent   = formatCurrency(totalSaved);
    netEl.textContent     = formatCurrency(netRounded);
    netEl.className = 'dashboard-tile-value ' +
      (netRounded > 0 ? 'positive' : netRounded < 0 ? 'negative' : 'neutral');

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
  }

  // ============================================================
  // ADD / REMOVE TRANSACTION
  // ============================================================
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
    row.transactions.splice(idx, 1);
    itemEl.remove();

    const list = document.getElementById(`txn-list-${rowId}`);
    if (list && row.transactions.length === 0) {
      list.appendChild(el('p', { className: 'txn-empty', textContent: T('noTransactions') }));
    }

    updateRowCells(rowId, section);
    renderSummary();
    debouncedSave();
  }

  function addAdjustment(rowId, section, form) {
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
  }

  function removeAdjustment(rowId, section, adjId, itemEl) {
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
      row.name = e.target.value;
    } else if (field === 'expected') {
      row.expected = parseAmount(e.target.value);
      const actual  = getActual(row, section);
      const { text: varianceText, className: varianceClass } = formatVariance(getEffectiveExpected(row, section), actual, section);
      const varTd = tr.children[3];
      if (varTd) {
        varTd.textContent = varianceText;
        varTd.className   = varianceClass;
      }
      renderSummary();
    } else if (field === 'subtype') {
      row.subtype = normalizeSubtype(e.target.value, row.name);
      renderSummary();
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
      const rowName = list[idx]?.name || 'unnamed';
      pushUndo(`delete row '${rowName}'`);
      if (idx !== -1) list.splice(idx, 1);
      expandedRows.delete(id);
      renderAll();
      debouncedSave();
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

  function navigateMonth(delta) {
    flushSalaryEditSession();
    const [y, m] = currentMonth.split('-').map(Number);
    currentMonth = toMonthKey(new Date(y, m - 1 + delta, 1));
    expandedRows.clear();
    ensureMonth(currentMonth);
    ensureSalaryMonth(currentMonth);
    saveState();
    buildMonthPicker();
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
      btn.addEventListener('click', () => {
        flushSalaryEditSession();
        currentMonth = `${dropdownYear}-${String(m).padStart(2, '0')}`;
        expandedRows.clear();
        ensureMonth(currentMonth);
        ensureSalaryMonth(currentMonth);
        saveState();
        closeMonthDropdown();
        buildMonthPicker();
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
    md.income.forEach(r => (r.transactions = []));
    Object.values(md.categories).forEach(list => list.forEach(r => (r.transactions = [])));
    expandedRows.clear();
    saveState();
    renderAll();
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

    const futureKeys = getFutureMonthKeys();
    if (futureKeys.length === 0) {
      alert('No future months have data yet. New months will inherit from the most recent month when you visit them.');
      return;
    }

    const message = `Apply ${currName}'s setup to ${futureKeys.length} future month(s)? This will overwrite category names, expected values, and ordering in those months. Actual spending values will not be touched.`;
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

    futureKeys.forEach(key => {
      const fmd = state.months[key];
      if (!fmd) return;
      if (!fmd.categories) fmd.categories = {};
      fmd.income                  = buildList(md?.income,                  fmd.income);
      fmd.categories.fixed        = buildList(md?.categories?.fixed,        fmd.categories.fixed);
      fmd.categories.variable     = buildList(md?.categories?.variable,     fmd.categories.variable);
      fmd.categories.recreational = buildList(md?.categories?.recreational, fmd.categories.recreational);
      fmd.categories.savings      = buildList(md?.categories?.savings,      fmd.categories.savings);
    });

    saveState();
    renderAll();
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

  function flushSalaryEditSession() {
    if (!salaryEditSession) return;
    clearTimeout(salaryEditSession.timer);
    const session = salaryEditSession;
    salaryEditSession = null;
    if (JSON.stringify(state) === JSON.stringify(session.snapshot)) return;
    pushUndo('salary edit', session.snapshot);
    saveState();
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
      return;
    }
    if (target.id === 'salary-taxes') {
      const rec = getSalaryRecord(currentMonth);
      rec.taxes        = parseAmount(target.value);
      rec.salarySource = 'manual';
      beginSalaryEditSession();
      renderSalaryDerived();
      debouncedSave();
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
    }
  }

  function handleSalaryClick(e) {
    if (e.target.id === 'salary-apply-future-btn') {
      applySalaryToFutureMonths();
      return;
    }

    if (e.target.id === 'salary-add-deduction') {
      flushSalaryEditSession();
      pushUndo('add deduction');
      const rec = getSalaryRecord(currentMonth);
      rec.deductions = rec.deductions || [];
      rec.deductions.push(newDeduction('', 0));
      rec.salarySource = 'manual';
      saveState();
      renderDeductions(rec);
      renderSalaryDerived();
      const wrap = document.getElementById('salary-deductions');
      const lastRow = wrap?.lastElementChild;
      lastRow?.querySelector('input[data-deduction-field="name"]')?.focus();
      return;
    }

    const removeBtn = e.target.closest('[data-action="remove-deduction"]');
    if (removeBtn) {
      const dedRow = removeBtn.closest('[data-deduction-id]');
      if (!dedRow) return;
      flushSalaryEditSession();
      pushUndo('delete deduction');
      const rec = getSalaryRecord(currentMonth);
      rec.deductions = (rec.deductions || []).filter(d => d.id !== dedRow.dataset.deductionId);
      rec.salarySource = 'manual';
      saveState();
      renderDeductions(rec);
      renderSalaryDerived();
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
  function init() {
    initState();
    syncSettingsUI();
    buildMonthPicker();
    bindSalaryInputFormatting();
    renderAll();
    bindEvents();
    initNav();
    initSidebar();

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
    init();
    renderAccountSection(user);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

})();
