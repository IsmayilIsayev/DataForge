# Changelog

All notable changes to DataForge are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Long values open in a side or bottom panel on double-click (resizable, with Edit, Copy and pretty JSON).
- "Update available" and one-time "What's new" windows that show the release notes.

### Changed

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
