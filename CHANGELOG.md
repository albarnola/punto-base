# Changelog

All notable changes to Punto Base will be documented in this file.

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