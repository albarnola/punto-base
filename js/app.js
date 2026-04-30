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
      { name: '401k Contribution' },
      { name: 'Roth IRA Contribution' },
      { name: 'Taxable Brokerage' },
      { name: 'Emergency Fund' },
    ],
  };

  const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', MXN: '$', GBP: '£' };

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
    return { id: crypto.randomUUID(), name, expected, order, transactions: [] };
  }

  function newTransaction(amount, date, note = '') {
    return { id: crypto.randomUUID(), date, amount, note };
  }

  function defaultMonthData(priorMonth = null) {
    if (priorMonth) {
      const copyRows = list => list.map((r, i) => newRow(r.name, r.expected, r.order ?? i));
      return {
        income: copyRows(priorMonth.income),
        categories: {
          fixed:        copyRows(priorMonth.categories.fixed),
          variable:     copyRows(priorMonth.categories.variable),
          recreational: copyRows(priorMonth.categories.recreational),
          savings:      copyRows(priorMonth.categories.savings || []),
        },
      };
    }
    return {
      income: DEFAULTS.income.map((d, i) => newRow(d.name, 0, i)),
      categories: {
        fixed:        DEFAULTS.fixed.map((d, i) => newRow(d.name, 0, i)),
        variable:     DEFAULTS.variable.map((d, i) => newRow(d.name, 0, i)),
        recreational: DEFAULTS.recreational.map((d, i) => newRow(d.name, 0, i)),
        savings:      DEFAULTS.savings.map((d, i) => newRow(d.name, 0, i)),
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
    for (const [monthKey, md] of Object.entries(s.months || {})) {
      if (!md) continue;
      (md.income || []).forEach(r => migrateRow(r, monthKey));
      if (md.categories && !md.categories.savings) {
        md.categories.savings = DEFAULTS.savings.map((d, i) => newRow(d.name, 0, i));
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
      };
    }
    migrateState(state);
    ensureMonth(currentMonth);
    saveState();
  }

  // ============================================================
  // FORMATTING
  // ============================================================
  function formatCurrency(amount) {
    const { currency, numberFormat } = state.settings;
    const sym    = CURRENCY_SYMBOLS[currency] ?? '$';
    const locale = numberFormat === 'eu' ? 'de-DE' : 'en-US';
    const formatted = Math.abs(amount).toLocaleString(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
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

  function sumListExpected(list) {
    return list.reduce((acc, r) => acc + parseAmount(r.expected), 0);
  }

  function sumListActual(list) {
    return list.reduce((acc, r) => acc + sumTransactions(r), 0);
  }

  function computeSummary(monthData) {
    const incomeExp   = sumListExpected(monthData.income);
    const incomeAct   = sumListActual(monthData.income);
    const cats        = monthData.categories;
    const expRows     = [...cats.fixed, ...cats.variable, ...cats.recreational];
    const savRows     = cats.savings || [];
    const expExp      = sumListExpected(expRows);
    const expAct      = sumListActual(expRows);
    const savExp      = sumListExpected(savRows);
    const savAct      = sumListActual(savRows);
    const allocatedExp = expExp + savExp;
    return {
      incomeExpected:    incomeExp,
      incomeActual:      incomeAct,
      expensesExpected:  expExp,
      expensesActual:    expAct,
      savingsExpected:   savExp,
      savingsActual:     savAct,
      allocatedExpected: allocatedExp,
      unallocated:       incomeExp - allocatedExp,
      netExpected:       incomeExp - expExp - savExp,
      netActual:         incomeAct - expAct - savAct,
    };
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
    if (undoStack.length === 0) { showToast('Nothing to undo'); return; }
    const { description, snapshot } = undoStack.pop();
    redoStack.push({ description, snapshot: JSON.parse(JSON.stringify(state)) });
    state = snapshot;
    if (!state.months[currentMonth]) ensureMonth(currentMonth);
    renderAll();
    debouncedSave();
    showToast(`Undid: ${description}`);
  }

  function applyRedo() {
    flushPendingAddRow();
    if (redoStack.length === 0) { showToast('Nothing to redo'); return; }
    const { description, snapshot } = redoStack.pop();
    undoStack.push({ description, snapshot: JSON.parse(JSON.stringify(state)) });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    state = snapshot;
    if (!state.months[currentMonth]) ensureMonth(currentMonth);
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
    const actual     = sumTransactions(row);
    const { text: varianceText, className: varianceClass } = formatVariance(parseAmount(row.expected), actual, section);
    const isExpanded = expandedRows.has(row.id);

    const tr = el('tr', {
      'data-id':      row.id,
      'data-section': section,
      className:      isExpanded ? 'row-expanded' : '',
    });

    const chevron = el('button', {
      className:       'btn-chevron',
      'aria-expanded': isExpanded ? 'true' : 'false',
      'aria-label':    T('toggleTxn'),
      textContent:     isExpanded ? '▾' : '▸',
    });

    const nameInput = el('input', {
      type:         'text',
      value:         row.name,
      placeholder:   T('namePlaceholder'),
      'aria-label':  `Name for ${row.name || 'new row'}`,
      'data-field':  'name',
    });

    const nameCell = el('div', { className: 'name-cell' });
    nameCell.appendChild(chevron);
    nameCell.appendChild(nameInput);

    const rawExpected = parseAmount(row.expected);
    const expectedInput = el('input', {
      type:         'text',
      inputmode:    'decimal',
      value:         formatCurrency(rawExpected),
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

    const actionsWrapper = el('div', { className: 'row-actions' });
    actionsWrapper.appendChild(upBtn);
    actionsWrapper.appendChild(downBtn);
    actionsWrapper.appendChild(removeBtn);

    tr.appendChild(el('td', {}, nameCell));
    tr.appendChild(el('td', {}, expectedInput));
    tr.appendChild(el('td', { textContent: formatCurrency(actual) }));
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
  // RENDER — TABLES & SUMMARY
  // ============================================================
  function renderTable(tbodyId, rows, section) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    tbody.innerHTML = '';
    const sorted = [...rows].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i];
      tbody.appendChild(renderRow(row, section, i === 0, i === sorted.length - 1));
      if (expandedRows.has(row.id)) {
        tbody.appendChild(renderTransactionPanel(row, section));
      }
    }
  }

  function renderAllTables() {
    const md = state.months[currentMonth];
    renderTable('income-body',       md.income,                  'income');
    renderTable('fixed-body',        md.categories.fixed,        'fixed');
    renderTable('variable-body',     md.categories.variable,     'variable');
    renderTable('recreational-body', md.categories.recreational,    'recreational');
    renderTable('savings-body',      md.categories.savings || [],   'savings');
  }

  function renderSummary() {
    const sum = computeSummary(state.months[currentMonth]);

    const incomeEl      = document.getElementById('summary-income');
    const unallocatedEl = document.getElementById('summary-unallocated');
    const savingsEl     = document.getElementById('summary-savings');
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

    if (savingsEl) savingsEl.textContent = formatCurrency(sum.savingsExpected);

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
    renderAllTables();
    renderSummary();
    syncCopyBtnLabel();
  }

  // ============================================================
  // SURGICAL CELL UPDATE (after transaction change)
  // ============================================================
  function updateRowCells(rowId, section) {
    const row = findRow(section, rowId);
    if (!row) return;
    const tr = document.querySelector(`tr[data-id="${rowId}"]`);
    if (!tr) return;

    const actual = sumTransactions(row);
    const { text: varianceText, className: varianceClass } = formatVariance(parseAmount(row.expected), actual, section);

    const actualTd   = tr.children[2];
    const varianceTd = tr.children[3];
    if (actualTd)   actualTd.textContent   = formatCurrency(actual);
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
      const panelTr = renderTransactionPanel(row, section);
      mainTr.insertAdjacentElement('afterend', panelTr);
      mainTr.classList.add('row-expanded');
      if (chevron) { chevron.textContent = '▾'; chevron.setAttribute('aria-expanded', 'true'); }
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
      const actual  = sumTransactions(row);
      const { text: varianceText, className: varianceClass } = formatVariance(row.expected, actual, section);
      const varTd = tr.children[3];
      if (varTd) {
        varTd.textContent = varianceText;
        varTd.className   = varianceClass;
      }
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

    // Add row
    const addRowBtn = e.target.closest('.btn-add');
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
    const section = document.querySelector('.month-picker-section');
    if (!section) return;
    section.innerHTML = '';

    const [y, m]  = currentMonth.split('-').map(Number);
    const prevBtn = el('button', { className: 'btn-icon', 'aria-label': 'Previous month', id: 'month-prev' }, '‹');
    const nextBtn = el('button', { className: 'btn-icon', 'aria-label': 'Next month',     id: 'month-next' }, '›');
    const label   = el('button', {
      className:       'month-label',
      id:              'month-label',
      'aria-label':    'Select month and year',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
    });
    label.textContent = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    prevBtn.addEventListener('click', () => navigateMonth(-1));
    nextBtn.addEventListener('click', () => navigateMonth(1));
    label.addEventListener('click', toggleMonthDropdown);

    section.append(prevBtn, label, nextBtn);
  }

  function navigateMonth(delta) {
    const [y, m] = currentMonth.split('-').map(Number);
    currentMonth = toMonthKey(new Date(y, m - 1 + delta, 1));
    expandedRows.clear();
    ensureMonth(currentMonth);
    saveState();
    buildMonthPicker();
    renderAll();
    closeMonthDropdown();
  }

  let monthDropdownEl = null;

  function toggleMonthDropdown() {
    if (monthDropdownEl) { closeMonthDropdown(); return; }

    const label = document.getElementById('month-label');
    if (!label) return;

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
        currentMonth = `${dropdownYear}-${String(m).padStart(2, '0')}`;
        expandedRows.clear();
        ensureMonth(currentMonth);
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
    document.getElementById('month-label')?.setAttribute('aria-expanded', 'false');
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
    const copyRows = list => (list || []).map((r, i) => newRow(r.name, r.expected, r.order ?? i));
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

  // ============================================================
  // NAVIGATION
  // ============================================================
  const VALID_PAGES = ['dashboard', 'budget', 'investing', 'settings'];

  function showPage(pageName) {
    if (!VALID_PAGES.includes(pageName)) pageName = 'budget';

    VALID_PAGES.forEach(p => {
      document.getElementById(`page-${p}`)?.classList.add('page-hidden');
    });
    document.getElementById(`page-${pageName}`)?.classList.remove('page-hidden');

    document.querySelectorAll('.sidebar-item[data-page]').forEach(item => {
      const isActive = item.dataset.page === pageName;
      item.classList.toggle('sidebar-item--active', isActive);
      item.setAttribute('aria-current', isActive ? 'page' : 'false');
    });

    history.replaceState(null, '', `#${pageName}`);
  }

  function initNav() {
    const hash = window.location.hash.slice(1);
    showPage(VALID_PAGES.includes(hash) ? hash : 'budget');

    document.querySelectorAll('.sidebar-item[data-page]').forEach(item => {
      item.addEventListener('click', e => {
        e.preventDefault();
        showPage(item.dataset.page);
      });
    });
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

    // Track edits to name / expected inputs for undo (capture pre-edit snapshot on focus)
    main?.addEventListener('focusin', e => {
      const input = e.target.closest('input[data-field]');
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
      const input = e.target.closest('input[data-field]');
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
    renderAll();
    bindEvents();
    initNav();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
