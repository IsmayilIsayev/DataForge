# Changelog

All notable changes to DataForge are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Export and backup of large tables: constant speed per page (keyset pagination) and no skipped or duplicated rows on tables without a primary key (single streamed read).

## [0.4.8] - 2026-10-27

### Added

- Backup: dump a database (structure, data or both) to .sql or .sql.gz from the database context menu, with progress and cancel; optionally uses pg_dump/mysqldump when installed.

## [0.4.7] - 2026-10-27

### Fixed

- The SQL editor cursor no longer drifts into the middle of characters after the editor font finishes loading.

### Changed

- Removed unused code and an unused dependency for a slightly smaller app.

## [0.4.6] - 2026-10-23

### Added

- Go to… (Ctrl/Cmd+P or the search icon in the sidebar): find any connection, database, table or view across all connected databases — including ones never expanded — with fuzzy, Azerbaijani-aware matching. The sidebar Filter now also matches database names and opens databases that contain matching tables.

## [0.4.5] - 2026-10-23

### Added

- ClickHouse connections over HTTP(S): browse databases and tables, run queries, search, export; tables are read-only in the grid (ClickHouse has no transactional row edits).

- Test data generator (table right-click → Generate test data…): realistic EN/AZ names, emails, phones, cities and more, valid foreign keys, preview with a seed, inserted in one transaction; disabled on production and read-only connections.

- Saved queries in folders (sidebar "Saved", Ctrl/Cmd+Shift+S), stored in a file in the app config folder.
- Export and import connections between computers (.dataforge.json, never includes passwords or SSH secrets; import shows conflicts and validates the file).

- Charts from query results (Chart button on the result grid): bar, horizontal bar, line, area, pie/donut and scatter, picked automatically from the columns; grouping and aggregation, top N, stacking, tooltips, PNG/SVG export and copy as image.

### Fixed

- PostgreSQL functions, triggers and DO blocks run correctly: $$ … $$ and $tag$ … $tag$ bodies are no longer split at the ";" inside them (was "unterminated dollar-quoted string"). Also "--comment" without a space is a comment on PostgreSQL/SQLite/SQL Server, and "#" is only a comment on MySQL.

## [0.4.4] - 2026-10-23

### Added

- ER diagram (database right-click → ER diagram): tables with keys and foreign-key relations, automatic layout, pan/zoom/fit, drag tables (positions remembered), search, keys-only mode, PNG/SVG export.
- Compare schemas (e.g. dev ↔ prod): differences per table and a migration script to make the target match the source; destructive steps are flagged and unticked by default, nothing runs automatically. PostgreSQL, MySQL and SQLite.
- Live AI model list from your provider (OpenAI, Groq, OpenRouter, Gemini, Ollama, LM Studio); speech, TTS and guard models are filtered out. Click "Model" in the AI panel footer to switch models from a searchable dropdown.

## [0.4.3] - 2026-10-23

### Added

- AI Chat: a conversation about the active database in the AI panel; suggested SQL can be inserted or run (prod connections still ask first), and "Explain this result" summarizes a result grid (sends up to 50 rows; asks first on prod).
- Visual query plan (Plan button, Ctrl/Cmd+Shift+P): EXPLAIN as a tree with cost bars, the costliest step highlighted, warnings (full scans, filesort, bad estimates), optional ANALYZE (asks first on prod), and "Ask AI for indexes" that only suggests CREATE INDEX statements.
- SSL/TLS settings for MySQL and PostgreSQL: disable, prefer, require, verify CA or verify full, with an optional CA certificate. `sslmode` / `ssl-mode` from a connection URL is applied to the dialog.

### Fixed

- Ctrl/Cmd+I opens the AI panel (and Ctrl/Cmd+K the command palette) even while typing in the SQL editor.

## [0.4.2] - 2026-10-23

### Added

- Export results or whole tables to CSV, JSON and SQL INSERT (large tables stream page by page, with progress and cancel), next to Excel.
- Faster Find in database / Search in table: results stream in as each table finishes (with progress and Cancel), small tables first, a 5-second limit per table (slow ones can be searched on their own), index-friendly column handling, and Contains / Starts with / Exact modes.
- SSH tunnel for MySQL and PostgreSQL: password or private key, secrets in the OS keychain, server key trusted on first use and checked afterwards.
- Import CSV into a table: preview, delimiter detection, column mapping, empty-as-NULL, one transaction with progress, cancel and an error summary.

## [0.4.1] - 2026-10-23

### Added

- Protected connections: dev/test/prod labels (PROD always spelled out), confirmation before any write on prod (type the database name for DROP/TRUNCATE and DELETE/UPDATE without WHERE), optional read-only mode.
- Batch editing: cell edits, deleted and new rows are queued (highlighted) and saved together in one transaction with Save (Ctrl/Cmd+S) or dropped with Discard; Preview SQL, undo (Ctrl/Cmd+Z), and an "Auto-commit edits" switch for the old behaviour.

### Fixed

- SQL autocomplete now shows suggestions (the editor's suggest widget was missing from the slimmed-down editor build).
- The "What's new" window also appears when updating from versions before 0.4.0.

## [0.4.0] - 2026-10-23

### Added

- SQL autocomplete: keywords ("sel" → SELECT, "fr" → FROM), "SELECT " → "* FROM", table and column names (with aliases), and 30+ templates (sf, ins, upd, cte, upsert, ct, idx, tx, thismonth, dup...).
- AI actions: "Fix with AI" on query errors (preview + Apply), Explain, and Optimize with the real EXPLAIN plan (Ctrl/Cmd+Shift+E / O).
- Filter and sort from the grid column headers (=, contains, starts with, is NULL, in list…); table tabs filter in the database, query results in memory.
- Connection presets for MariaDB, TiDB, CockroachDB, Supabase, Neon, Amazon RDS and PlanetScale, and a new SQL Server driver.
- Long values open in a side or bottom panel on double-click (resizable, with Edit, Copy and pretty JSON).
- "Update available" and one-time "What's new" windows that show the release notes.

### Changed

- Lighter app: SQL-only editor, dialogs load on demand, a much smaller icon font.
- Simpler AI settings: provider presets, a model list, and a base URL only for custom providers.
- Stronger AI prompts: per-database syntax, LIMIT 100 by default, no write statements unless asked.

### Fixed

- SQLite file picker and Excel export now work on macOS and Linux.

## [0.3.3] - 2026-10-22

### Fixed

- AI settings now remember whether an API key is saved before provider settings change.
- The Monaco editor worker loads correctly in packaged builds.
- Row editing is safer: default values are handled correctly, large 64-bit IDs target the right row, and multi-row deletes are atomic.
- Search results and query history stay tied to the connection and database they came from, and stale query runs no longer overwrite newer results.
- SQL statement splitting handles backslash escapes only for MySQL.
- Changing a MySQL column type keeps its default value and auto-increment setting.
- SQLite booleans are stored as 1/0, and SQLite LIKE searches escape wildcards correctly.
- An unreadable connections.json is no longer overwritten.
- The AI SQL parser handles a trailing code fence without crashing.
- Copy as INSERT uses the executed SQL, the sidebar New query uses the table's connection, and MySQL URLs keep the database name.
- The data grid keeps its sort order and selection after edits.

### Security

- Saved database passwords are reused only for the same dialect, host, port and user (or the same SQLite file).
- PostgreSQL string literals are escaped safely regardless of server settings.
- AI API keys are bound to the provider and base URL they were saved for; plain HTTP is allowed only for loopback addresses.
- Query history skips statements that look like they contain secrets.
- Unsafe or unimplemented connection options are disabled, and SQLite read-only mode no longer creates the database file.
- Copy as CSV protects spreadsheet apps from formula injection in text cells.
- Monaco is bundled locally, the CSP no longer allows the jsDelivr CDN, and developer tools are available only in debug builds.

## [0.3.2] - 2026-10-22

### Fixed

- Find in Database works on URL-based and serverless connections, including Neon and PlanetScale.
- Postgres uuid and json/jsonb columns are searched as text instead of failing the whole scan.
- Search terms with non-ASCII letters (ə, ı, ş, ç, ğ, ö, ü and others) match in any language.
- Accent-insensitive collations and other database edge cases no longer hide matching rows.
- Data-scan failures show the real database error instead of an empty result.
- Postgres and MySQL connections recover from suspended or stale connections by validating and replacing pooled connections.

## [0.3.1] - 2026-10-22

### Added

- Insert row dialog with per-column value, NULL and DEFAULT handling.
- Delete selected rows from the grid with a confirmation step.
- Table designer: add, rename, change type or drop columns, with a SQL preview.
- Create table form with primary keys, defaults and validation.
- Drop table from the sidebar.
- Search in a single table, with parallel data scanning and highlighted matches.
- Export the current result grid to Excel (.xlsx).
- Query history: browse, filter and reload recent queries.
- Automatic update checks on launch and daily, with an in-app download and restart.

### Fixed

- Row edits and deletes target rows by primary key.
- Opening a search hit filters the table to the matching rows.

## [0.3.0] - 2026-10-22

### Added

- Connection colors, starring, hiding and restore for connections.
- Favorite tables pinned at the top, custom groups with drag-and-drop, and collapsible group headers.
- Find in Database searches table and column names plus row data, case-insensitively.
- Focus mode hides the sidebar and AI panel and goes fullscreen.
- Navigation filters for starred connections and locating the active tab.
