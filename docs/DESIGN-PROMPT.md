# DataForge — UI/UX Design Prompt (for an AI design tool)

> Paste this into v0.dev, Lovable, Figma Make, or an LLM that generates React + CSS.
> Goal: a complete visual design for DataForge that drops into the existing
> React + TypeScript (Tauri 2) app.

---

Design the complete UI for **DataForge**, a modern, AI-native desktop database
manager (a free, better-looking alternative to Navicat). It is a Tauri 2 desktop app;
the frontend is React 18 + TypeScript + Vite. Deliver React components + a CSS
variables token file (no heavy UI kit; plain CSS or Tailwind is fine). It must look
native-grade on desktop, dense but calm, and work in **both dark and light mode**
(dark is the default).

## Product & users
A developer tool for connecting to databases (MySQL first; PostgreSQL, SQLite,
SQL Server, MongoDB later), writing SQL, viewing results, and generating SQL from
natural language with AI. Users are developers and DBAs who live in it all day — so
prioritize information density, speed, keyboard use, and low eye strain.

## Aesthetic direction
Modern developer-tool look — in the spirit of **TablePlus, Beekeeper Studio, Linear,
and Raycast**. Clean, flat, subtle borders, no skeuomorphism, no heavy shadows.
Precise 1px dividers, restrained color, one accent color used sparingly. Feels fast
and professional, not flashy.

## Layout (single window, resizable panes)
```
┌───────────────────────────────────────────────────────────────────────┐
│ Top bar: app name · active connection ▾ · database ▾ · [Run ▷] · ⌘K · 🌙 │
├──────────────┬────────────────────────────────────────┬─────────────────┤
│ Sidebar      │ SQL Editor (Monaco)                     │ AI Panel        │
│ (connections │  ─────────────────────────────────────  │ (toggleable,    │
│  & schema    │ Result Grid                              │  right side)    │
│  tree)       │  (virtualized table)                     │                 │
│              │  status bar: N rows · 12 ms · truncated  │                 │
├──────────────┴────────────────────────────────────────┴─────────────────┤
│ Status/footer: connection state · errors as inline toast                 │
└───────────────────────────────────────────────────────────────────────┘
```
- Left sidebar: resizable (drag handle), collapsible.
- Center: vertical split — SQL editor on top, result grid below (drag to resize).
- Right AI panel: slides in/out; hidden by default, toggled from top bar.

## Design tokens (define as CSS variables on :root, with dark + light)
Provide a neutral, accessible palette. Suggested (tune for WCAG AA):
- Dark:  bg `#16181d`, surface `#1e2127`, border `#2a2e37`, text `#e6e8eb`,
  muted `#9aa1ab`, accent `#4c8bf5` (blue), success `#3fb950`, danger `#f85149`,
  warning `#d29922`.
- Light: bg `#ffffff`, surface `#f6f7f9`, border `#e3e6ea`, text `#1c2024`,
  muted `#5b636d`, same accent/success/danger/warning (slightly darkened).
- Dark is default; honor `prefers-color-scheme` and a manual toggle (`data-theme`).

## Typography
- UI font: **Inter** (system-ui fallback).
- SQL editor + all data cells + numbers: **monospace** (JetBrains Mono / ui-monospace).
- Sizes: 13px base UI, 12px dense tables, 13–14px editor. Tight but legible line heights.

## Components to design (match these existing component names)

### 1. Sidebar.tsx — connection & schema tree
- A tree: **Connection → Database → Tables/Views**.
- Each connection row: small DB-type icon (MySQL/Postgres/SQLite/etc.), name,
  connected/disconnected dot. Active connection highlighted with accent left-border.
- "+ Add connection" button at the top. Right-click context menu (edit, delete,
  refresh). Hover reveals a refresh icon.
- Tables show a table/view glyph; expandable to columns (col name + type, muted).
- Search/filter box at top to filter the tree.

### 2. ConnectionDialog.tsx — modal form
- Centered modal, dimmed backdrop. Fields: Name, Dialect (dropdown), Host, Port,
  User, Password (masked, show/hide toggle), Database (optional), SSH toggle (future).
- Buttons: **Test connection** (shows inline green/red result with message), **Save**,
  Cancel. Disabled/validation states. Loading spinner on Test/Save.

### 3. SqlEditor.tsx — Monaco wrapper + toolbar
- Thin toolbar above editor: connection selector, database selector, **Run ▷**
  (primary accent button, shows "Ctrl+Enter"), Format, and a tab bar for multiple
  open queries (closable tabs, "+" to add).
- Monaco with SQL syntax highlighting, matching the theme tokens.

### 4. ResultGrid.tsx — virtualized results table
- Dense spreadsheet-like grid, zebra striping (very subtle), sticky header row.
- Sortable column headers (click to sort, show ▲▼). Resizable columns.
- **NULL** rendered as muted italic "NULL"; numbers right-aligned, monospace.
- Cell selection (click a cell, copy value); row hover highlight.
- Bottom status bar: row count, elapsed_ms, a "truncated — showing first N" chip.
- States: empty ("Run a query to see results"), loading (shimmer), error (red inline).

### 5. AiPanel.tsx — AI assistant (the differentiator)
- Right panel, chat-like. Header: "AI" + model name chip.
- If no API key: a clean key-entry card ("Connect your Anthropic key") with a masked
  input and Save.
- Main: a textarea ("Ask in plain language, e.g. 'top 10 customers by revenue'")
  with an **Ask** button.
- Answer rendered as a card: the generated **SQL** in a monospace block with a copy
  button and a prominent **"Use this SQL"** button (inserts into the editor — never
  auto-runs). Below it: a short explanation, and any **warnings** as amber chips
  (e.g. "full table scan", "no WHERE on UPDATE").
- A small, clear note when schema will be sent to the AI (privacy).

### 6. CommandPalette.tsx — ⌘K overlay
- Centered floating command palette (Raycast-style): fuzzy search over actions
  (new query, switch connection, run, toggle theme, open AI).

## Interaction & states
- Keyboard: **Ctrl+Enter** run, **⌘/Ctrl+K** palette, Ctrl+T new tab, Esc closes modals.
- Focus rings (accent, 2px) on all interactive elements — keyboard accessible.
- Errors appear as a non-blocking toast at bottom; destructive actions (DROP/DELETE)
  get a confirm dialog with "N rows affected" warning.
- Smooth but fast transitions (120–160ms), no bouncy animation.
- Respect reduced-motion.

## Deliverables
1. `tokens.css` — all CSS variables for dark + light.
2. Styled versions of the components above (React + TS), matching the names so they
   drop into `src/components/`.
3. A short style guide (color usage, spacing scale: 4/8/12/16/24, radius 6px, border
   1px) as comments or a README.

Keep it cohesive, accessible (WCAG AA contrast), and desktop-first. Dark mode is the
hero — make that look great first.
