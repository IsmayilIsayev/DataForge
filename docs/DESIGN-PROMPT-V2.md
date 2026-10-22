# DataForge — UI/UX Design Prompt v2 (minimal, crafted, not "AI-generated")

> Paste into v0 / Lovable / Figma Make / an LLM that outputs React + CSS.
> Goal: redesign DataForge to look like a hand-crafted professional desktop tool —
> minimal, precise, calmer and cleaner than Navicat — and explicitly NOT like a
> generic AI-generated web app.

---

Design the complete UI for **DataForge**, a professional desktop database client
(Tauri 2, React + TypeScript). Deliver React components + a `tokens.css` of CSS
variables. It must feel like a native, crafted pro tool, denser and quieter than a
website. Dark mode is the hero; ship light mode too.

## The single most important rule: do NOT look AI-generated
Avoid every cliché of generated UIs. Specifically **do not use**:
- purple/violet or multi-color gradients, neon or candy accents, glassmorphism/blur;
- big soft drop shadows, glows, heavy rounded corners (no pill buttons, no 16px+ radii);
- emoji as icons; oversized padding, airy hero sections, huge headings;
- generic "cards everywhere," centered marketing layouts, bootstrap/Tailwind defaults;
- gradient text, rainbow charts, decorative illustrations, excessive animation.
Instead aim for **restraint and precision**: a near-monochrome surface, 1px hairline
borders, one quiet accent used rarely, dense but calm information, intentional
alignment. Reference the craft of **TablePlus, Linear, Raycast, iA Writer, Figma's
chrome** — tools that look deliberate and understated, never "templated."

## Principles
1. **Minimal, not empty.** High information density done cleanly — tight rows, small
   type, hairline dividers. No wasted vertical space, but nothing cramped.
2. **Monochrome + one accent.** Build almost entirely from neutral grays. The accent
   (a single desaturated blue) appears only on: the run button, focus rings, the
   active-connection marker, selected cells, sort direction. Never as a fill for large
   areas, never as a gradient.
3. **Hairlines over boxes.** Separate regions with 1px borders and spacing, not cards
   or shadows. One subtle elevation level for menus/modals only.
4. **Flat, quiet chrome.** Toolbars are thin (28–32px), compact, text-light; icons
   carry most actions. The window should read as one continuous surface.
5. **Purposeful color.** Color = meaning only: green connected/success, red
   errors/destructive, amber warnings/PK. Nothing is colored for decoration.

## Color tokens (CSS variables on :root; dark default + light)
Keep it neutral and low-contrast-elegant (tune to WCAG AA for text):
- Dark: `--bg:#0f1115; --sf:#15181d; --sf2:#1a1e24; --bd:#24282f; --bd2:#2f343c;
  --tx:#dfe3e8; --mu:#8b929c; --fa:#5c636d; --ac:#5b8def; --acd:#3f6fd1;
  --acs:rgba(91,141,239,.14); --ok:#43b581; --er:#e5534b; --wn:#caa23a` (amber).
  Zebra `rgba(255,255,255,.015)`, hover `rgba(255,255,255,.04)`.
- Light: `--bg:#ffffff; --sf:#fbfbfc; --sf2:#f4f5f7; --bd:#e6e8ec; --bd2:#d7dade;
  --tx:#1a1d21; --mu:#616770; --fa:#8a9099; --ac:#2f6fd1;` same semantic colors
  slightly darkened. Keep contrasts gentle, borders truly 1px.
- Support `prefers-color-scheme` + a manual `[data-theme]` toggle.

## Typography
- One UI typeface: **Inter** (or system-ui), used at 12–13px for almost everything,
  13–14px only for the editor. Weights: 400 body, 500 for emphasis/headers. Avoid
  bold everywhere and avoid large sizes.
- One monospace: **JetBrains Mono / ui-monospace** for SQL, all grid cells, numbers,
  identifiers. Tabular numbers for the result grid.
- Letter-spacing near 0; line-height tight (1.35). No all-caps except tiny labels.

## Shape, spacing, motion
- Spacing scale strictly 4 / 8 / 12 / 16. Row heights: tree 24px, grid 22px, toolbar
  controls 26–28px. Radius: 4px controls, 6px menus/modals. Borders always 1px `--bd`.
- Focus: 2px accent ring, 1px offset. Motion: 120ms ease-out, no bounce; disable under
  prefers-reduced-motion. One elevation shadow for overlays only, subtle.

## Icons
Use a single crafted 16px line-icon set (**Lucide** or **Phosphor**), monochrome,
inheriting `--mu`/`--tx`. Small, consistent stroke. No emoji, no filled/colored icons
except the connected/status dot.

## Layout (one window, resizable panes, minimal chrome)
```
┌─────────────────────────────────────────────────────────────────────┐
│ thin top bar:  ◇ connection ▾   database ▾   ⟶Run   ⌘K   ☾            │
├───────────────┬───────────────────────────────────────┬──────────────┤
│ Sidebar       │ Tab strip (quiet, underline-active)     │ AI (hidden   │
│ connections → │ ───────────────────────────────────────│  by default, │
│ databases →   │ Query: Monaco editor                    │  slides in)  │
│ tables →      │ ───── 1px divider, draggable ───────────│              │
│ columns       │ Result grid (dense, hairline)           │              │
│ (filter top)  │ 26px status footer: 1,240 · 12ms        │              │
├───────────────┴───────────────────────────────────────┴──────────────┤
│ footer: connection state (dot)                                        │
└─────────────────────────────────────────────────────────────────────┘
```
Sidebar and AI panel resizable via 1px drag handles. Tabs are flat text with a 2px
accent underline on the active tab — no closable "chips," no box tabs.

## Components (match these names; minimal styling + all states)

- **Top bar**: 32px, flat. Connection + database as quiet text dropdowns (caret only).
  Run is the one accent button (small, square-ish, 4px radius). ⌘K and theme as icon
  buttons. No logo lockup, no title text clutter.
- **Sidebar tree**: 24px rows, 16px icons, hairline indent guides. Connection row:
  status dot + name; active connection marked by a 2px accent left-border (not a fill).
  Database/table/column nested; a small monospace row-count aligned right in `--fa`.
  A thin filter input pinned at top. Right-click menu = flat list, 1px border, no
  shadow beyond the single overlay elevation.
- **Tab strip**: flat, underline-active, small close affordance on hover only. Two tab
  kinds: Query (editor+grid) and Table Data (grid only). A quiet "+" for New Query.
- **SQL editor (Monaco)**: themed to the tokens (comment `--fa`, keyword a muted
  lavender-gray not neon, string muted teal, number muted blue). Thin toolbar: Run,
  Format — text buttons, icon-led. No chunky toolbar.
- **Result grid / Table Data view**: the centerpiece. Dense 22px rows, 1px column
  separators, sticky header in `--sf2` with 500-weight labels and subtle sort carets.
  Zebra extremely subtle. Selected cell: 1px accent outline + `--acs` fill. NULL =
  `--fa` italic "NULL". Numbers right-aligned, tabular. Resizable columns, reorderable
  by dragging headers, horizontal scroll. Click a cell → full value in a 1-line
  preview strip below; double-click → a minimal value viewer (plain panel, mono,
  wrap toggle, copy, JSON pretty-print) — no modal chrome beyond a hairline border.
- **Connection dialog**: compact, Navicat-style tabs (General | Advanced | Databases |
  SSL | SSH | HTTP) but far cleaner — left-aligned label column, 1px fields, no card,
  no shadow stacking. Fields: Connection Name, Host, Port, Initial Database, User,
  Password (+show), Save password. Buttons bottom-right: Test · Cancel · OK. SQLite =
  a file-path row with a Browse button instead of host/port/user.
- **AI panel**: quiet right panel, not a chatbot. A single input ("Describe the query")
  and an answer block: the SQL in a mono box with Copy + "Use this SQL" (text buttons),
  a one-line explanation, warnings as small amber-dot items. A tiny Settings row
  (provider, model). No avatars, no bubbles, no sparkles iconography.
- **Command palette (⌘K)**: a single centered panel, 1px border, one elevation,
  mono-ish list of actions with a fuzzy filter. Raycast-like restraint.

## States
Empty ("No results — run a query"), loading (a thin top progress line or a quiet
shimmer, not spinners everywhere), error (a 1-line red strip, not a toast circus),
destructive confirm (plain dialog stating rows affected). All quiet, all fast.

## Deliverables
1. `tokens.css` — all variables, dark + light, with the spacing/radius/motion scale
   documented in a short comment.
2. Minimal styled React components matching the names above (drop into `src/` and
   `src/components/`), using the tokens; no external UI kit; plain CSS or utility
   classes only.
3. A 10-line style guide stating the restraint rules (monochrome + one accent,
   hairlines, 4px grid, 16px line icons, no gradients/shadows/emoji).

Make the dark theme look effortless and precise first. If anything looks like a
generic template or an AI demo, it's wrong — pull it back toward quieter, denser,
more deliberate.
