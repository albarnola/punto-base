# Changelog

All notable changes to Punto Base will be documented in this file.

## v0.4 — 2026-07-08

### Added
- Recurring rows: opening a month with no data auto-fills expected values from the nearest prior month with a budget (actuals start at zero); a toast confirms "Budget carried over from …"
- Dashboard "Safe to spend" card: remaining flexible budget (Variable + Recreational) divided by days left in the month; shows over-budget state in red; only appears when viewing the current calendar month

### Changed
- Summary bar redesigned around one headline number: "Left to budget" with contextual message, plus a quiet right-aligned detail row (Income, Expenses, Savings, Investments, Net, Cash Flow)
- Insight message no longer repeats the warning color — the headline value carries the state

## v0.3 — 2026-07-08

### Changed — Apple-style visual language
- System font stack (SF Pro on Apple devices), tighter letter-spacing on headings
- Softer palette: #F5F5F7 background, hairline borders, layered soft shadows on all cards
- Frosted-glass header and summary bar (backdrop blur + saturate)
- Pill-shaped buttons and month picker with press-down scale feedback
- Sidebar nav as rounded pill items with tinted active state
- Card headings no longer uppercase; larger page/dashboard headings

### Changed — visual redesign
- Fixed, Variable, and Recreational expenses unified into a single "Expenses" card with color-coded sub-groups, per-group subtotals, and a card-level spent-vs-planned total
- Dashboard tiles redesigned with icons, accent colors, and hover lift
- New dashboard "Spending breakdown" card: proportional bar of Fixed / Variable / Recreational spending with legend
- Bottom summary bar redesigned: gradient accent line, dividers between items, emphasized Unallocated and Net values, frosted-glass background
- Page headers added to Budget and Salary pages
- Softer app background, active sidebar item accent bar, month picker polish

### Notes
- No functional changes — all row editing, transactions, linked rows, and sync behavior untouched

## v0.2 — 2026-04-30

### Added
- Sidebar navigation with four pages: Dashboard, Budget, Investing, Settings
- Sidebar collapse to icon-only state on desktop with toggle button
- Persistent sidebar state across sessions (remembers expanded vs collapsed)
- Mobile-responsive layout with hamburger menu and overlay sidebar
- Tooltip on collapsed sidebar icons showing page name on hover
- URL hash routing — refreshing on a page keeps you there

### Changed
- Settings moved from a slide-out drawer to a dedicated sidebar page
- Settings drawer and gear icon in header removed entirely
- Currency values display without decimal places on mobile screens (under 768px wide)
- Insight message and summary bar values round to whole dollars on mobile
- Budget table layout adapts on mobile: tighter padding, smaller font, hidden row action buttons by default
- Row action buttons (up arrow, down arrow, delete) hidden on mobile by default, accessible via row expand
- Name column on mobile allows long category names to wrap to two lines

### Removed
- Settings slide-out drawer (replaced by Settings page)
- Gear icon from the page header

### Fixed
- Mobile view no longer cuts off category names mid-word
- Tables remain readable at narrow viewport widths down to 375px

### Known limitations
- Dashboard page is a placeholder; full Dashboard view planned for v0.3
- Investing page is a placeholder; full Investing tracker planned for v0.3
- Net Worth tracking not yet available
- No charts or visualizations yet
- Mobile layout tested down to 375px width; very narrow viewports may need additional tuning
- No data sync between devices — data is per-browser, per-device

## v0.1 — 2026-04-29

First working MVP shipped to GitHub Pages.

### Features
- Monthly budget tracking with five sections: Income, Savings & Investments, Fixed Expenses, Variable Expenses, Recreational Expenses
- Expected vs Actual tracking per row with automatic variance calculation
- Smart variance coloring based on category type
- Variance formatting with parentheses for "less than expected" values
- Unallocated tracker (zero-based budgeting): shows how much of your income hasn't been assigned to a category
- Contextual insight message based on allocation state
- Per-month data with manual carry-forward via Settings
- Row reordering with up/down arrows
- Undo/redo with Cmd+Z and Cmd+Shift+Z, 20-step history, toast notifications
- Press Enter to save and format input values
- Currency formatting on all monetary fields
- localStorage persistence
- Currency setting (USD, EUR, MXN) in Settings
- Export to JSON and Clear All Data in Settings

### Deployment
- Live at https://albarnola.github.io/punto-base/
- Deployed via GitHub Pages from main branch