//! SQL dump writer and external dump-tool command builder.
//!
//! The writer is independent from the Tauri command layer so a future restore
//! feature can reuse the same literal helpers and dialect rules. It streams row
//! batches to any `std::io::Write`; the command layer adds gzip and progress.

use std::io::{self, Write};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::edit::{quote_ident, quote_lit, table_ref};
use crate::core::drivers::Dialect;
use crate::core::schema_diff::{
    add_foreign_key_sql, add_index_sql, create_table_sql, SchemaData,
};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DumpMode {
    Structure,
    Data,
    Both,
}

impl DumpMode {
    pub fn includes_structure(self) -> bool {
        matches!(self, Self::Structure | Self::Both)
    }

    pub fn includes_data(self) -> bool {
        matches!(self, Self::Data | Self::Both)
    }
}

#[derive(Debug, Clone)]
pub struct DumpColumn {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Clone)]
pub struct DumpOptions {
    pub mode: DumpMode,
    pub include_drop: bool,
    pub rows_per_insert: usize,
}

impl Default for DumpOptions {
    fn default() -> Self {
        Self {
            mode: DumpMode::Both,
            include_drop: false,
            rows_per_insert: 500,
        }
    }
}

pub fn supports_structure(dialect: Dialect) -> bool {
    matches!(
        dialect,
        Dialect::Mysql | Dialect::Postgres | Dialect::Sqlite
    )
}

fn is_binary_type(data_type: &str) -> bool {
    let data_type = data_type.to_ascii_lowercase();
    data_type.contains("blob")
        || data_type.contains("binary")
        || data_type.contains("bytea")
        || data_type.contains("image")
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn binary_hex(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            let (marker, payload) = if trimmed
                .get(..2)
                .map(|prefix| prefix.eq_ignore_ascii_case("0x"))
                .unwrap_or(false)
            {
                (true, &trimmed[2..])
            } else if trimmed.starts_with("\\x") {
                (true, &trimmed[2..])
            } else {
                (false, trimmed)
            };

            if marker && !payload.is_empty() && payload.chars().all(|c| c.is_ascii_hexdigit()) {
                Some(payload.to_ascii_lowercase())
            } else {
                Some(hex_encode(text.as_bytes()))
            }
        }
        Value::Array(items) => {
            let mut bytes = Vec::with_capacity(items.len());
            for item in items {
                let number = item.as_u64()?;
                if number > u8::MAX as u64 {
                    return None;
                }
                bytes.push(number as u8);
            }
            Some(hex_encode(&bytes))
        }
        _ => None,
    }
}

fn binary_literal(dialect: Dialect, hex: &str) -> String {
    match dialect {
        Dialect::Postgres => format!("E'\\\\x{hex}'::bytea"),
        Dialect::Mysql | Dialect::Mssql => format!("0x{hex}"),
        Dialect::Sqlite => format!("X'{hex}'"),
        Dialect::Clickhouse => format!("unhex('{hex}')"),
        Dialect::Mongodb => quote_lit(dialect, Some(hex)),
    }
}

/// Convert a JSON cell into a dialect-correct SQL literal. Binary columns use
/// the dialect's hex form; ordinary strings reuse the edit/export escaping.
pub(crate) fn value_literal(dialect: Dialect, data_type: &str, value: &Value) -> String {
    if value.is_null() {
        return "NULL".to_string();
    }

    if is_binary_type(data_type) {
        if let Some(hex) = binary_hex(value) {
            return binary_literal(dialect, &hex);
        }
    }

    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(value) => match dialect {
            Dialect::Mysql | Dialect::Mssql => {
                if *value {
                    "1".to_string()
                } else {
                    "0".to_string()
                }
            }
            _ => {
                if *value {
                    "TRUE".to_string()
                } else {
                    "FALSE".to_string()
                }
            }
        },
        Value::Number(value) => value.to_string(),
        Value::String(value) => quote_lit(dialect, Some(value)),
        other => quote_lit(dialect, Some(&other.to_string())),
    }
}

pub(crate) fn insert_batch_sql(
    dialect: Dialect,
    database: &str,
    table: &str,
    columns: &[DumpColumn],
    rows: &[Vec<Value>],
) -> String {
    let target = table_ref(dialect, database, table);
    let column_list = columns
        .iter()
        .map(|column| quote_ident(dialect, &column.name))
        .collect::<Vec<_>>()
        .join(", ");
    let values = rows
        .iter()
        .map(|row| {
            let literals = columns
                .iter()
                .enumerate()
                .map(|(index, column)| {
                    value_literal(
                        dialect,
                        &column.data_type,
                        row.get(index).unwrap_or(&Value::Null),
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("({literals})")
        })
        .collect::<Vec<_>>()
        .join(",\n  ");

    format!("INSERT INTO {target} ({column_list}) VALUES\n  {values};")
}

fn drop_table_sql(dialect: Dialect, database: &str, table: &str) -> String {
    format!(
        "DROP TABLE IF EXISTS {};",
        table_ref(dialect, database, table)
    )
}

fn sanitize_comment(value: &str) -> String {
    value.replace(['\r', '\n'], " ")
}

pub fn dump_header(
    app_version: &str,
    dialect: Dialect,
    database: &str,
    date: &str,
    tables: &[String],
) -> String {
    let table_list = if tables.is_empty() {
        "(none)".to_string()
    } else {
        tables
            .iter()
            .map(|table| sanitize_comment(table))
            .collect::<Vec<_>>()
            .join(", ")
    };

    format!(
        "-- DataForge {app_version} database dump\n\
         -- Dialect: {dialect}\n\
         -- Database: {}\n\
         -- Date: {}\n\
         -- Tables: {}\n\n",
        sanitize_comment(database),
        sanitize_comment(date),
        table_list,
    )
}

/// Create the selected tables and their indexes. Foreign keys are written
/// separately (after the data) except on SQLite, where they must stay inside
/// the CREATE TABLE body because ALTER TABLE cannot add constraints.
pub(crate) fn structure_statements(
    dialect: Dialect,
    database: &str,
    schema: &SchemaData,
    selected: &[String],
    include_drop: bool,
) -> Vec<String> {
    if !supports_structure(dialect) {
        return Vec::new();
    }

    let selected_set: std::collections::HashSet<&str> =
        selected.iter().map(String::as_str).collect();
    let foreign_keys: Vec<_> = schema
        .foreign_keys
        .iter()
        .filter(|foreign_key| {
            selected_set.contains(foreign_key.from_table.as_str())
                && selected_set.contains(foreign_key.to_table.as_str())
        })
        .cloned()
        .collect();
    let mut statements = Vec::new();

    for name in selected {
        let Some(table) = schema.table(name) else {
            continue;
        };
        if include_drop {
            statements.push(drop_table_sql(dialect, database, &table.name));
        }
        statements.push(create_table_sql(dialect, table, &foreign_keys));
    }

    for name in selected {
        let Some(table) = schema.table(name) else {
            continue;
        };
        for index in &table.indexes {
            statements.push(add_index_sql(dialect, &table.name, index));
        }
    }

    statements
}

/// Foreign keys are emitted after all data so INSERT order cannot matter.
/// SQLite has no ALTER TABLE ADD CONSTRAINT; its keys are already in the body
/// of CREATE TABLE.
pub(crate) fn foreign_key_statements(
    dialect: Dialect,
    schema: &SchemaData,
    selected: &[String],
) -> Vec<String> {
    if dialect == Dialect::Sqlite || !supports_structure(dialect) {
        return Vec::new();
    }

    let selected_set: std::collections::HashSet<&str> =
        selected.iter().map(String::as_str).collect();
    schema
        .foreign_keys
        .iter()
        .filter(|foreign_key| {
            selected_set.contains(foreign_key.from_table.as_str())
                && selected_set.contains(foreign_key.to_table.as_str())
        })
        .map(|foreign_key| add_foreign_key_sql(dialect, foreign_key))
        .collect()
}

fn sequence_statements(
    database: &str,
    schema: &SchemaData,
    selected: &[String],
) -> Vec<String> {
    let mut statements = Vec::new();
    for name in selected {
        let Some(table) = schema.table(name) else {
            continue;
        };
        let target = table_ref(Dialect::Postgres, database, &table.name);
        for column in table.columns.iter().filter(|column| column.auto_increment) {
            let column_name = quote_ident(Dialect::Postgres, &column.name);
            statements.push(format!(
                "SELECT setval(pg_get_serial_sequence({}, {}), \
                 COALESCE(MAX({column_name}), 1), MAX({column_name}) IS NOT NULL) FROM {target};",
                quote_lit(Dialect::Postgres, Some(target.as_str())),
                quote_lit(Dialect::Postgres, Some(column.name.as_str())),
            ));
        }
    }
    statements
}

/// Streaming dump writer. Row batches are accumulated only up to
/// `rows_per_insert`, so a table is never held in memory as a whole.
pub struct SqlDumpWriter<W: Write> {
    out: W,
    dialect: Dialect,
    database: String,
    include_drop: bool,
    rows_per_insert: usize,
    pending: Vec<Vec<Value>>,
    columns: Vec<DumpColumn>,
    table: Option<String>,
}

impl<W: Write> SqlDumpWriter<W> {
    pub fn new(
        out: W,
        dialect: Dialect,
        database: &str,
        include_drop: bool,
        rows_per_insert: usize,
    ) -> Self {
        Self {
            out,
            dialect,
            database: database.to_string(),
            include_drop,
            rows_per_insert: rows_per_insert.max(1),
            pending: Vec::new(),
            columns: Vec::new(),
            table: None,
        }
    }

    fn write_str(&mut self, text: &str) -> io::Result<()> {
        self.out.write_all(text.as_bytes())
    }

    pub fn write_header(
        &mut self,
        app_version: &str,
        date: &str,
        selected: &[String],
    ) -> io::Result<()> {
        let header = dump_header(
            app_version,
            self.dialect,
            &self.database,
            date,
            selected,
        );
        self.write_str(&header)?;
        match self.dialect {
            Dialect::Mysql => {
                if !self.database.trim().is_empty() {
                    self.write_str(&format!(
                        "USE {};\n\n",
                        quote_ident(Dialect::Mysql, &self.database)
                    ))?;
                }
                self.write_str("SET FOREIGN_KEY_CHECKS=0;\n\n")?;
            }
            Dialect::Sqlite => self.write_str("PRAGMA foreign_keys=OFF;\n\n")?,
            _ => {}
        }
        Ok(())
    }

    pub fn write_structure(
        &mut self,
        schema: &SchemaData,
        selected: &[String],
    ) -> io::Result<()> {
        for statement in structure_statements(
            self.dialect,
            &self.database,
            schema,
            selected,
            self.include_drop,
        ) {
            self.write_str(&statement)?;
            self.write_str("\n")?;
        }
        self.write_str("\n")
    }

    pub fn begin_data(&mut self) -> io::Result<()> {
        if self.dialect == Dialect::Sqlite {
            self.write_str("BEGIN;\n\n")?;
        }
        Ok(())
    }

    pub fn begin_table(&mut self, table: &str, columns: &[DumpColumn]) -> io::Result<()> {
        self.flush_pending()?;
        self.table = Some(table.to_string());
        self.columns = columns.to_vec();
        Ok(())
    }

    pub fn write_rows(&mut self, rows: &[Vec<Value>]) -> io::Result<()> {
        for row in rows {
            self.pending.push(row.clone());
            if self.pending.len() >= self.rows_per_insert {
                self.flush_pending()?;
            }
        }
        Ok(())
    }

    pub fn end_table(&mut self) -> io::Result<()> {
        self.flush_pending()?;
        self.table = None;
        self.columns.clear();
        Ok(())
    }

    fn flush_pending(&mut self) -> io::Result<()> {
        let Some(table) = self.table.clone() else {
            self.pending.clear();
            return Ok(());
        };
        if self.pending.is_empty() {
            return Ok(());
        }

        let rows = std::mem::take(&mut self.pending);
        let statement =
            insert_batch_sql(self.dialect, &self.database, &table, &self.columns, &rows);
        self.write_str(&statement)?;
        self.write_str("\n")?;
        Ok(())
    }

    pub fn end_data(
        &mut self,
        schema: Option<&SchemaData>,
        selected: &[String],
    ) -> io::Result<()> {
        self.flush_pending()?;
        if self.dialect == Dialect::Sqlite {
            self.write_str("COMMIT;\n\n")?;
        }
        if self.dialect == Dialect::Postgres {
            if let Some(schema) = schema {
                for statement in sequence_statements(&self.database, schema, selected) {
                    self.write_str(&statement)?;
                    self.write_str("\n")?;
                }
                self.write_str("\n")?;
            }
        }
        Ok(())
    }

    pub fn write_foreign_keys(
        &mut self,
        schema: &SchemaData,
        selected: &[String],
    ) -> io::Result<()> {
        for statement in foreign_key_statements(self.dialect, schema, selected) {
            self.write_str(&statement)?;
            self.write_str("\n")?;
        }
        self.write_str("\n")
    }

    pub fn finish(&mut self) -> io::Result<()> {
        self.flush_pending()?;
        match self.dialect {
            Dialect::Mysql => self.write_str("SET FOREIGN_KEY_CHECKS=1;\n")?,
            Dialect::Sqlite => self.write_str("PRAGMA foreign_keys=ON;\n")?,
            _ => {}
        }
        self.out.flush()
    }

    pub fn into_inner(mut self) -> io::Result<W> {
        self.flush_pending()?;
        self.out.flush()?;
        Ok(self.out)
    }
}

/// UTC timestamp formatted without pulling in a date/time crate. The dump
/// header only needs a human-readable, unambiguous date.
pub fn timestamp_utc() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let remainder = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = remainder / 3_600;
    let minute = (remainder % 3_600) / 60;
    let second = remainder % 60;
    format!(
        "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02} UTC"
    )
}

fn civil_from_days(mut days: i64) -> (i64, u32, u32) {
    days += 719_468;
    let era = (if days >= 0 { days } else { days - 146_096 }) / 146_097;
    let day_of_era = (days - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = if month_part < 10 {
        month_part + 3
    } else {
        month_part - 9
    };
    if month <= 2 {
        year += 1;
    }
    (year, month as u32, day as u32)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalDumpCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

pub fn external_tool_name(dialect: Dialect) -> Option<&'static str> {
    match dialect {
        Dialect::Postgres => Some("pg_dump"),
        Dialect::Mysql => Some("mysqldump"),
        Dialect::Sqlite => Some("sqlite3"),
        _ => None,
    }
}

fn executable_on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };

    let mut candidates = vec![name.to_string()];
    if cfg!(windows) {
        candidates.extend([
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
        ]);
    }

    std::env::split_paths(&path).any(|directory| {
        candidates
            .iter()
            .any(|candidate| directory.join(candidate).is_file())
    })
}

/// Return the external tool only when it is actually installed. Callers also
/// hide the option for SSH connections, where the tool cannot reach the host.
pub fn external_tool(dialect: Dialect) -> Option<&'static str> {
    external_tool_name(dialect).filter(|name| executable_on_path(name))
}

fn quote_sqlite_dot_table(table: &str) -> String {
    format!("\"{}\"", table.replace('"', "\"\""))
}

pub fn external_dump_command(
    dialect: Dialect,
    host: &str,
    port: u16,
    username: &str,
    database: &str,
    tables: &[String],
    mode: DumpMode,
    include_drop: bool,
    password: Option<&str>,
) -> AppResult<ExternalDumpCommand> {
    let program = external_tool_name(dialect)
        .ok_or_else(|| {
            AppError::Config(format!(
                "External dump tool is not supported for {dialect}"
            ))
        })?
        .to_string();
    // mysqldump/sqlite3 take these positionally; a leading '-' would be parsed as an option.
    if let Some(name) = std::iter::once(database)
        .chain(tables.iter().map(String::as_str))
        .find(|name| name.starts_with('-'))
    {
        return Err(AppError::Config(format!(
            "{name} starts with '-'; use the built-in writer for this database"
        )));
    }
    let mut args = Vec::new();
    let mut env = Vec::new();

    match dialect {
        Dialect::Postgres => {
            if database.trim().is_empty() {
                return Err(AppError::Config(
                    "Choose a database before running pg_dump".to_string(),
                ));
            }
            if !host.trim().is_empty() {
                args.push(format!("--host={host}"));
            }
            if port != 0 {
                args.push(format!("--port={port}"));
            }
            if !username.trim().is_empty() {
                args.push(format!("--username={username}"));
            }
            args.push(format!("--dbname={database}"));
            args.push("--no-password".to_string());
            match mode {
                DumpMode::Structure => args.push("--schema-only".to_string()),
                DumpMode::Data => args.push("--data-only".to_string()),
                DumpMode::Both => {}
            }
            if include_drop && mode.includes_structure() {
                args.push("--clean".to_string());
                args.push("--if-exists".to_string());
            }
            for table in tables {
                args.push(format!("--table={table}"));
            }
            if let Some(password) = password.filter(|value| !value.is_empty()) {
                env.push(("PGPASSWORD".to_string(), password.to_string()));
            }
        }
        Dialect::Mysql => {
            if database.trim().is_empty() {
                return Err(AppError::Config(
                    "Choose a database before running mysqldump".to_string(),
                ));
            }
            if !host.trim().is_empty() {
                args.push(format!("--host={host}"));
            }
            if port != 0 {
                args.push(format!("--port={port}"));
            }
            if !username.trim().is_empty() {
                args.push(format!("--user={username}"));
            }
            match mode {
                DumpMode::Structure => args.push("--no-data".to_string()),
                DumpMode::Data => args.push("--no-create-info".to_string()),
                DumpMode::Both => {}
            }
            if mode.includes_structure() {
                args.push(if include_drop {
                    "--add-drop-table".to_string()
                } else {
                    "--skip-add-drop-table".to_string()
                });
            }
            args.push(database.to_string());
            args.extend(tables.iter().cloned());
            if let Some(password) = password.filter(|value| !value.is_empty()) {
                env.push(("MYSQL_PWD".to_string(), password.to_string()));
            }
        }
        Dialect::Sqlite => {
            if database.trim().is_empty() {
                return Err(AppError::Config(
                    "Choose a SQLite database file before running sqlite3".to_string(),
                ));
            }
            args.push(database.to_string());
            let mut dump = ".dump".to_string();
            for table in tables {
                dump.push(' ');
                dump.push_str(&quote_sqlite_dot_table(table));
            }
            args.push(dump);
        }
        _ => {
            return Err(AppError::Config(format!(
                "External dump tool is not supported for {dialect}"
            )));
        }
    }

    Ok(ExternalDumpCommand {
        program,
        args,
        env,
    })
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use flate2::read::GzDecoder;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use serde_json::Value;

    use super::{
        external_dump_command, insert_batch_sql, structure_statements, value_literal,
        DumpColumn, DumpMode, SqlDumpWriter,
    };
    use crate::core::drivers::Dialect;
    use crate::core::schema_diff::{
        ColumnSchema, ForeignKeySchema, IndexSchema, SchemaData, TableSchema,
    };

    const SELECTED: [&str; 2] = ["users", "orders"];

    fn selected() -> Vec<String> {
        SELECTED.iter().map(|name| name.to_string()).collect()
    }

    fn column(
        name: &str,
        data_type: &str,
        nullable: bool,
        primary_key: bool,
    ) -> ColumnSchema {
        ColumnSchema {
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable,
            primary_key,
            default: None,
            auto_increment: false,
        }
    }

    fn fixture() -> SchemaData {
        let mut users = TableSchema {
            name: "users".to_string(),
            columns: vec![
                ColumnSchema {
                    auto_increment: true,
                    ..column("id", "integer", false, true)
                },
                column("name", "text", false, false),
                column("avatar", "bytea", true, false),
            ],
            indexes: vec![IndexSchema {
                name: "idx_users_name".to_string(),
                columns: vec!["name".to_string()],
                unique: true,
            }],
            pk_constraint: Some("users_pkey".to_string()),
        };
        users.columns[2].data_type = "bytea".to_string();

        let orders = TableSchema {
            name: "orders".to_string(),
            columns: vec![
                column("id", "integer", false, true),
                column("user_id", "integer", false, false),
                column("note", "text", true, false),
            ],
            indexes: Vec::new(),
            pk_constraint: None,
        };

        SchemaData {
            database: "shop".to_string(),
            tables: vec![users, orders],
            foreign_keys: vec![ForeignKeySchema {
                name: "fk_orders_user".to_string(),
                from_table: "orders".to_string(),
                from_columns: vec!["user_id".to_string()],
                to_table: "users".to_string(),
                to_columns: vec!["id".to_string()],
            }],
            views: Vec::new(),
            truncated: false,
        }
    }

    fn users_columns() -> Vec<DumpColumn> {
        vec![
            DumpColumn {
                name: "id".to_string(),
                data_type: "integer".to_string(),
            },
            DumpColumn {
                name: "name".to_string(),
                data_type: "text".to_string(),
            },
            DumpColumn {
                name: "avatar".to_string(),
                data_type: "bytea".to_string(),
            },
        ]
    }

    fn orders_columns() -> Vec<DumpColumn> {
        vec![
            DumpColumn {
                name: "id".to_string(),
                data_type: "integer".to_string(),
            },
            DumpColumn {
                name: "user_id".to_string(),
                data_type: "integer".to_string(),
            },
            DumpColumn {
                name: "note".to_string(),
                data_type: "text".to_string(),
            },
        ]
    }

    fn users_rows() -> Vec<Vec<Value>> {
        (1..=5)
            .map(|id| {
                vec![
                    Value::from(id),
                    Value::from(format!("user {id}")),
                    if id == 1 {
                        Value::String("0xdead".to_string())
                    } else {
                        Value::Null
                    },
                ]
            })
            .collect()
    }

    fn orders_rows() -> Vec<Vec<Value>> {
        vec![
            vec![Value::from(1), Value::from(1), Value::from("O'Brien")],
            vec![Value::from(2), Value::from(2), Value::Null],
            vec![Value::from(3), Value::from(3), Value::from("plain")],
        ]
    }

    fn write_dump<W: Write>(out: W, dialect: Dialect, rows_per_insert: usize) -> W {
        let schema = fixture();
        let selected = selected();
        let mut writer =
            SqlDumpWriter::new(out, dialect, "shop", true, rows_per_insert);
        writer
            .write_header("test", "2026-01-02 03:04:05 UTC", &selected)
            .unwrap();
        writer.write_structure(&schema, &selected).unwrap();
        writer.begin_data().unwrap();
        writer.begin_table("users", &users_columns()).unwrap();
        for page in users_rows().chunks(2) {
            writer.write_rows(page).unwrap();
        }
        writer.end_table().unwrap();
        writer.begin_table("orders", &orders_columns()).unwrap();
        writer.write_rows(&orders_rows()).unwrap();
        writer.end_table().unwrap();
        writer.end_data(Some(&schema), &selected).unwrap();
        writer.write_foreign_keys(&schema, &selected).unwrap();
        writer.finish().unwrap();
        writer.into_inner().unwrap()
    }

    fn dump_text(dialect: Dialect) -> String {
        String::from_utf8(write_dump(Vec::<u8>::new(), dialect, 2)).unwrap()
    }

    fn assert_before(text: &str, first: &str, second: &str) {
        let first = text.find(first).unwrap_or_else(|| panic!("missing {first}"));
        let second = text
            .find(second)
            .unwrap_or_else(|| panic!("missing {second}"));
        assert!(first < second, "{first} should come before {second}");
    }

    #[test]
    fn postgres_dump_has_structure_batches_foreign_key_and_setval() {
        let text = dump_text(Dialect::Postgres);

        assert!(text.contains("-- DataForge test database dump"));
        assert!(text.contains("-- Dialect: postgres"));
        assert!(text.contains("-- Tables: users, orders"));
        assert!(text.contains("DROP TABLE IF EXISTS \"users\";"));
        assert!(text.contains("CREATE TABLE \"users\""));
        assert!(text.contains("GENERATED BY DEFAULT AS IDENTITY"));
        assert!(text.contains("CREATE UNIQUE INDEX \"idx_users_name\""));
        assert!(text.contains("E'\\\\xdead'::bytea"));
        assert_eq!(
            text.matches("INSERT INTO \"users\"").count(),
            3,
            "5 rows at 2 per INSERT should produce 3 batches"
        );
        assert!(text.contains("ALTER TABLE \"orders\" ADD CONSTRAINT \"fk_orders_user\""));
        assert_before(&text, "INSERT INTO \"orders\"", "ALTER TABLE \"orders\"");
        assert!(text.contains("pg_get_serial_sequence"));
        assert_before(&text, "INSERT INTO \"orders\"", "SELECT setval(");
    }

    #[test]
    fn mysql_dump_has_use_statement_checks_and_foreign_key_at_the_end() {
        let text = dump_text(Dialect::Mysql);

        assert!(text.contains("USE `shop`;"));
        assert!(text.contains("SET FOREIGN_KEY_CHECKS=0;"));
        assert!(text.contains("CREATE TABLE `users`"));
        assert!(text.contains("AUTO_INCREMENT"));
        assert!(text.contains("0xdead"));
        assert_eq!(text.matches("INSERT INTO `shop`.`users`").count(), 3);
        assert_before(&text, "INSERT INTO `shop`.`orders`", "ALTER TABLE `orders`");
        assert_before(&text, "ALTER TABLE `orders`", "SET FOREIGN_KEY_CHECKS=1;");
    }

    #[test]
    fn sqlite_dump_declares_foreign_keys_and_wraps_data_in_a_transaction() {
        let text = dump_text(Dialect::Sqlite);

        assert!(text.contains("PRAGMA foreign_keys=OFF;"));
        assert!(text.contains("CREATE TABLE \"users\""));
        assert!(text.contains("FOREIGN KEY (\"user_id\") REFERENCES \"users\" (\"id\")"));
        assert!(!text.contains("ALTER TABLE"));
        assert!(text.contains("X'dead'"));
        assert_before(&text, "PRAGMA foreign_keys=OFF;", "BEGIN;");
        assert_before(&text, "BEGIN;", "INSERT INTO \"users\"");
        assert_before(&text, "INSERT INTO \"orders\"", "COMMIT;");
        assert_before(&text, "COMMIT;", "PRAGMA foreign_keys=ON;");
    }

    #[test]
    fn sql_server_and_clickhouse_get_data_only_insert_dumps() {
        let schema = fixture();
        let columns = users_columns();

        let mssql = insert_batch_sql(
            Dialect::Mssql,
            "shop",
            "users",
            &columns,
            &users_rows(),
        );
        assert!(mssql.starts_with("INSERT INTO [shop].[dbo].[users]"));
        assert!(mssql.contains("0xdead"));

        let clickhouse = insert_batch_sql(
            Dialect::Clickhouse,
            "shop",
            "users",
            &columns,
            &users_rows(),
        );
        assert!(clickhouse.starts_with("INSERT INTO `shop`.`users`"));
        assert!(clickhouse.contains("unhex('dead')"));

        assert!(!structure_statements(
            Dialect::Mssql,
            "shop",
            &schema,
            &selected(),
            false,
        )
        .iter()
        .any(|statement| statement.starts_with("CREATE TABLE")));
    }

    #[test]
    fn value_literals_escape_quotes_backslashes_null_and_binary() {
        let escaped = Value::String("O'Brien\\path".to_string());

        assert_eq!(value_literal(Dialect::Postgres, "text", &Value::Null), "NULL");
        assert_eq!(
            value_literal(Dialect::Postgres, "text", &escaped),
            r"E'O''Brien\\path'"
        );
        assert_eq!(
            value_literal(Dialect::Mysql, "text", &escaped),
            r"'O''Brien\\path'"
        );
        assert_eq!(
            value_literal(Dialect::Sqlite, "text", &escaped),
            r"'O''Brien\path'"
        );
        assert_eq!(
            value_literal(Dialect::Mssql, "text", &escaped),
            r"N'O''Brien\path'"
        );

        let binary = Value::String("0xdead".to_string());
        assert_eq!(
            value_literal(Dialect::Postgres, "bytea", &binary),
            r"E'\\xdead'::bytea"
        );
        assert_eq!(value_literal(Dialect::Mysql, "blob", &binary), "0xdead");
        assert_eq!(value_literal(Dialect::Sqlite, "blob", &binary), "X'dead'");
        assert_eq!(
            value_literal(Dialect::Mssql, "varbinary", &binary),
            "0xdead"
        );
        assert_eq!(
            value_literal(Dialect::Clickhouse, "binary", &binary),
            "unhex('dead')"
        );
        assert_eq!(
            value_literal(
                Dialect::Sqlite,
                "blob",
                &Value::String("abc".to_string()),
            ),
            "X'616263'"
        );
    }

    #[test]
    fn gzip_round_trip_matches_the_plain_dump() {
        let schema = fixture();
        let selected = selected();
        let plain = write_dump(Vec::<u8>::new(), Dialect::Postgres, 2);
        let encoder = write_dump(
            GzEncoder::new(Vec::<u8>::new(), Compression::default()),
            Dialect::Postgres,
            2,
        );
        let compressed = encoder.finish().unwrap();

        let mut decoder = GzDecoder::new(&compressed[..]);
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded).unwrap();

        assert_eq!(decoded, plain);
        assert!(String::from_utf8(decoded)
            .unwrap()
            .contains("CREATE TABLE \"users\""));
        assert!(!structure_statements(
            Dialect::Postgres,
            "shop",
            &schema,
            &selected,
            false,
        )
        .is_empty());
    }

    #[test]
    fn external_command_rejects_option_like_names() {
        let evil = vec!["--result-file=/tmp/x".to_string()];
        for dialect in [Dialect::Mysql, Dialect::Sqlite, Dialect::Postgres] {
            assert!(external_dump_command(
                dialect, "h", 1, "u", "shop.db", &evil, DumpMode::Both, false, None
            )
            .is_err());
            assert!(external_dump_command(
                dialect, "h", 1, "u", "-x", &selected(), DumpMode::Both, false, None
            )
            .is_err());
        }
    }

    #[test]
    fn external_command_keeps_the_password_out_of_argv() {
        let tables = selected();

        let pg = external_dump_command(
            Dialect::Postgres,
            "db.example",
            5432,
            "app",
            "shop",
            &tables,
            DumpMode::Both,
            true,
            Some("s3cr3t"),
        )
        .unwrap();
        assert_eq!(pg.program, "pg_dump");
        assert!(pg.args.contains(&"--host=db.example".to_string()));
        assert!(pg.args.contains(&"--clean".to_string()));
        assert!(pg.args.contains(&"--table=users".to_string()));
        assert!(!pg.args.iter().any(|arg| arg.contains("s3cr3t")));
        assert_eq!(
            pg.env,
            vec![("PGPASSWORD".to_string(), "s3cr3t".to_string())]
        );

        let mysql = external_dump_command(
            Dialect::Mysql,
            "db.example",
            3306,
            "app",
            "shop",
            &tables,
            DumpMode::Structure,
            false,
            Some("s3cr3t"),
        )
        .unwrap();
        assert_eq!(mysql.program, "mysqldump");
        assert!(mysql.args.contains(&"--no-data".to_string()));
        assert!(mysql.args.contains(&"--skip-add-drop-table".to_string()));
        assert!(!mysql.args.iter().any(|arg| arg.contains("s3cr3t")));
        assert_eq!(
            mysql.env,
            vec![("MYSQL_PWD".to_string(), "s3cr3t".to_string())]
        );

        let sqlite = external_dump_command(
            Dialect::Sqlite,
            "",
            0,
            "",
            "/tmp/shop.db",
            &tables,
            DumpMode::Data,
            false,
            None,
        )
        .unwrap();
        assert_eq!(sqlite.program, "sqlite3");
        assert_eq!(sqlite.args[0], "/tmp/shop.db");
        assert!(sqlite.args[1].starts_with(".dump"));
        assert!(sqlite.env.is_empty());
    }
}
