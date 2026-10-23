use std::fs::File;
use std::io::{BufWriter, Write};

use rust_xlsxwriter::{Format, Workbook, Worksheet, XlsxError};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{Emitter, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands::edit::{quote_ident, quote_lit, table_ref};
use crate::core::drivers::{Dialect, QueryResult};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Excel's hard limit on the number of characters stored in a single cell.
const MAX_CELL_CHARS: usize = 32_767;
const PAGE_SIZE: i64 = 5_000;
const SQL_BATCH_SIZE: usize = 100;
const CSV_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

fn xlsx_err(error: XlsxError) -> AppError {
    AppError::Config(format!("excel: {error}"))
}

fn io_err(error: std::io::Error) -> AppError {
    AppError::Export(error.to_string())
}

fn csv_err(error: csv::Error) -> AppError {
    AppError::Export(format!("csv: {error}"))
}

fn json_err(error: serde_json::Error) -> AppError {
    AppError::Export(format!("json: {error}"))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ExportFormat {
    Csv,
    Json,
    Sql,
    Xlsx,
}

impl ExportFormat {
    fn parse(value: &str) -> AppResult<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "csv" => Ok(Self::Csv),
            "json" => Ok(Self::Json),
            "sql" => Ok(Self::Sql),
            "xlsx" | "excel" => Ok(Self::Xlsx),
            other => Err(AppError::Config(format!("unsupported export format: {other}"))),
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Json => "json",
            Self::Sql => "sql",
            Self::Xlsx => "xlsx",
        }
    }

    fn filter_label(self) -> &'static str {
        match self {
            Self::Csv => "CSV file",
            Self::Json => "JSON file",
            Self::Sql => "SQL file",
            Self::Xlsx => "Excel workbook",
        }
    }

    fn filter_extensions(self) -> &'static [&'static str] {
        match self {
            Self::Csv => &["csv"],
            Self::Json => &["json"],
            Self::Sql => &["sql"],
            Self::Xlsx => &["xlsx"],
        }
    }
}

fn ensure_extension(path: String, extension: &str) -> String {
    let suffix = format!(".{extension}");
    if path.to_ascii_lowercase().ends_with(&suffix) {
        path
    } else {
        format!("{path}{suffix}")
    }
}

/// Native "Save As" dialog with the filter for the chosen format. Returns None
/// when the user cancels.
async fn save_file_dialog_with(
    app: &tauri::AppHandle,
    default_name: String,
    filter_label: &'static str,
    filter_extensions: &'static [&'static str],
) -> AppResult<Option<String>> {
    let app = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter(filter_label, filter_extensions)
            .set_file_name(default_name)
            .blocking_save_file()
    })
    .await
    .map_err(|error| AppError::Config(format!("save dialog: {error}")))?;

    match path {
        Some(path) => Ok(Some(
            path.into_path()
                .map_err(|error| AppError::Config(format!("save dialog: {error}")))?
                .to_string_lossy()
                .into_owned(),
        )),
        None => Ok(None),
    }
}

async fn save_file_dialog(
    app: &tauri::AppHandle,
    default_name: String,
    format: ExportFormat,
) -> AppResult<Option<String>> {
    save_file_dialog_with(
        app,
        default_name,
        format.filter_label(),
        format.filter_extensions(),
    )
    .await
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ErdFormat {
    Png,
    Svg,
}

impl ErdFormat {
    fn parse(value: &str) -> AppResult<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "png" => Ok(Self::Png),
            "svg" => Ok(Self::Svg),
            other => Err(AppError::Config(format!("unsupported ERD format: {other}"))),
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Svg => "svg",
        }
    }

    fn filter_label(self) -> &'static str {
        match self {
            Self::Png => "PNG image",
            Self::Svg => "SVG image",
        }
    }

    fn filter_extensions(self) -> &'static [&'static str] {
        match self {
            Self::Png => &["png"],
            Self::Svg => &["svg"],
        }
    }
}

fn decode_base64(input: &str) -> AppResult<Vec<u8>> {
    let payload = input
        .split_once(',')
        .filter(|(head, _)| head.contains(";base64"))
        .map(|(_, tail)| tail)
        .unwrap_or(input);
    let mut out = Vec::with_capacity(payload.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;

    for byte in payload.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' | b' ' | b'\t' => continue,
            _ => return Err(AppError::Config("invalid base64 image data".into())),
        };
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }

    Ok(out)
}

/// Truncate to Excel's per-cell character limit.
fn clamp(text: &str) -> String {
    if text.chars().count() > MAX_CELL_CHARS {
        text.chars().take(MAX_CELL_CHARS).collect()
    } else {
        text.to_string()
    }
}

/// Spreadsheet apps treat these leading characters as the start of a formula.
fn guard_formula(text: &str) -> String {
    match text.chars().next() {
        Some('=' | '+' | '-' | '@' | '\t' | '\r') => format!("'{text}"),
        _ => text.to_string(),
    }
}

fn csv_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        // Only text can carry a formula; numeric -5 stays numeric.
        Value::String(value) => guard_formula(value),
        other => other.to_string(),
    }
}

fn json_object(columns: &[String], row: &[Value]) -> Value {
    let mut object = Map::with_capacity(columns.len());
    for (index, column) in columns.iter().enumerate() {
        object.insert(
            column.clone(),
            row.get(index).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(object)
}

fn sql_literal(dialect: Dialect, value: &Value) -> String {
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

/// Build one multi-row INSERT for up to `SQL_BATCH_SIZE` rows.
pub(crate) fn insert_batch_sql(
    dialect: Dialect,
    database: &str,
    table: &str,
    columns: &[String],
    rows: &[Vec<Value>],
) -> String {
    let target = table_ref(dialect, database, table);
    let column_list = columns
        .iter()
        .map(|column| quote_ident(dialect, column))
        .collect::<Vec<_>>()
        .join(", ");
    let values = rows
        .iter()
        .map(|row| {
            let literals = row
                .iter()
                .map(|value| sql_literal(dialect, value))
                .collect::<Vec<_>>()
                .join(", ");
            format!("({literals})")
        })
        .collect::<Vec<_>>()
        .join(",\n  ");

    format!("INSERT INTO {target} ({column_list}) VALUES\n  {values};")
}

#[cfg(test)]
fn insert_statements(
    dialect: Dialect,
    database: &str,
    table: &str,
    columns: &[String],
    rows: &[Vec<Value>],
) -> Vec<String> {
    rows.chunks(SQL_BATCH_SIZE)
        .map(|chunk| insert_batch_sql(dialect, database, table, columns, chunk))
        .collect()
}

fn write_xlsx_cell(
    sheet: &mut Worksheet,
    row: u32,
    column: u16,
    value: &Value,
) -> Result<(), XlsxError> {
    match value {
        Value::Null => Ok(()),
        Value::Bool(value) => sheet
            .write_boolean(row, column, *value)
            .map(|_| ()),
        Value::Number(value) => {
            if let Some(number) = value.as_f64() {
                sheet.write_number(row, column, number).map(|_| ())
            } else {
                sheet
                    .write_string(row, column, value.to_string().as_str())
                    .map(|_| ())
            }
        }
        Value::String(value) => sheet
            .write_string(row, column, clamp(value).as_str())
            .map(|_| ()),
        other => sheet
            .write_string(row, column, clamp(&other.to_string()).as_str())
            .map(|_| ()),
    }
}

/// Streaming writer shared by the loaded-rows export and whole-table export.
enum TableSink {
    Csv {
        writer: csv::Writer<BufWriter<File>>,
        columns: Vec<String>,
    },
    Json {
        out: BufWriter<File>,
        columns: Vec<String>,
        first: bool,
    },
    Sql {
        out: BufWriter<File>,
        dialect: Dialect,
        database: String,
        table: String,
        columns: Vec<String>,
        pending: Vec<Vec<Value>>,
    },
    Xlsx {
        workbook: Workbook,
        columns: Vec<String>,
        next_row: u32,
    },
}

impl TableSink {
    fn new(
        format: ExportFormat,
        path: &str,
        columns: &[String],
        bom: bool,
        dialect: Dialect,
        database: &str,
        table: &str,
    ) -> AppResult<Self> {
        match format {
            ExportFormat::Csv => {
                let mut out = BufWriter::new(File::create(path).map_err(io_err)?);
                if bom {
                    out.write_all(&CSV_BOM).map_err(io_err)?;
                }
                let mut writer = csv::WriterBuilder::new()
                    .terminator(csv::Terminator::CRLF)
                    .from_writer(out);
                let header: Vec<String> =
                    columns.iter().map(|column| guard_formula(column)).collect();
                writer.write_record(&header).map_err(csv_err)?;
                Ok(Self::Csv {
                    writer,
                    columns: columns.to_vec(),
                })
            }
            ExportFormat::Json => {
                let mut out = BufWriter::new(File::create(path).map_err(io_err)?);
                out.write_all(b"[\n").map_err(io_err)?;
                Ok(Self::Json {
                    out,
                    columns: columns.to_vec(),
                    first: true,
                })
            }
            ExportFormat::Sql => Ok(Self::Sql {
                out: BufWriter::new(File::create(path).map_err(io_err)?),
                dialect,
                database: database.to_string(),
                table: table.to_string(),
                columns: columns.to_vec(),
                pending: Vec::with_capacity(SQL_BATCH_SIZE),
            }),
            ExportFormat::Xlsx => {
                let mut workbook = Workbook::new();
                let header = Format::new().set_bold();
                {
                    let sheet = workbook.add_worksheet();
                    for (column, name) in columns.iter().enumerate() {
                        sheet
                            .write_with_format(0, column as u16, name.as_str(), &header)
                            .map_err(xlsx_err)?;
                    }
                }
                Ok(Self::Xlsx {
                    workbook,
                    columns: columns.to_vec(),
                    next_row: 1,
                })
            }
        }
    }

    fn write_rows(&mut self, rows: &[Vec<Value>]) -> AppResult<()> {
        match self {
            Self::Csv { writer, columns } => {
                for row in rows {
                    let record: Vec<String> = columns
                        .iter()
                        .enumerate()
                        .map(|(index, _)| {
                            csv_text(row.get(index).unwrap_or(&Value::Null))
                        })
                        .collect();
                    writer.write_record(&record).map_err(csv_err)?;
                }
            }
            Self::Json {
                out,
                columns,
                first,
            } => {
                for row in rows {
                    if !*first {
                        out.write_all(b",\n").map_err(io_err)?;
                    }
                    *first = false;
                    let object = json_object(columns, row);
                    serde_json::to_writer_pretty(&mut *out, &object).map_err(json_err)?;
                }
            }
            Self::Sql {
                out,
                dialect,
                database,
                table,
                columns,
                pending,
            } => {
                for row in rows {
                    pending.push(row.clone());
                    if pending.len() >= SQL_BATCH_SIZE {
                        let statement = insert_batch_sql(
                            *dialect,
                            database.as_str(),
                            table.as_str(),
                            columns.as_slice(),
                            pending.as_slice(),
                        );
                        out.write_all(statement.as_bytes()).map_err(io_err)?;
                        out.write_all(b"\n").map_err(io_err)?;
                        pending.clear();
                    }
                }
            }
            Self::Xlsx {
                workbook,
                columns,
                next_row,
            } => {
                let start = *next_row;
                let sheet = workbook.worksheet_from_index(0).map_err(xlsx_err)?;
                for (offset, row) in rows.iter().enumerate() {
                    let row_index = start + offset as u32;
                    for (column, value) in row.iter().enumerate() {
                        if column < columns.len() {
                            write_xlsx_cell(sheet, row_index, column as u16, value)
                                .map_err(xlsx_err)?;
                        }
                    }
                }
                *next_row = start + rows.len() as u32;
            }
        }
        Ok(())
    }

    fn flush_sql(&mut self) -> AppResult<()> {
        if let Self::Sql {
            out,
            dialect,
            database,
            table,
            columns,
            pending,
        } = self
        {
            if pending.is_empty() {
                return Ok(());
            }
            let statement = insert_batch_sql(
                *dialect,
                database.as_str(),
                table.as_str(),
                columns.as_slice(),
                pending.as_slice(),
            );
            out.write_all(statement.as_bytes()).map_err(io_err)?;
            out.write_all(b"\n").map_err(io_err)?;
            pending.clear();
        }
        Ok(())
    }

    fn finish(mut self, path: &str) -> AppResult<()> {
        self.flush_sql()?;
        match self {
            Self::Csv { mut writer, .. } => writer.flush().map_err(io_err)?,
            Self::Json { mut out, .. } => {
                out.write_all(b"\n]\n").map_err(io_err)?;
                out.flush().map_err(io_err)?;
            }
            Self::Sql { mut out, .. } => out.flush().map_err(io_err)?,
            Self::Xlsx {
                mut workbook, ..
            } => workbook.save(path).map_err(xlsx_err)?,
        }
        Ok(())
    }
}

fn write_loaded(
    format: ExportFormat,
    path: &str,
    columns: &[String],
    rows: &[Vec<Value>],
    bom: bool,
    dialect: Dialect,
    database: &str,
    table: &str,
) -> AppResult<()> {
    let mut sink = TableSink::new(format, path, columns, bom, dialect, database, table)?;
    sink.write_rows(rows)?;
    sink.finish(path)
}

fn page_sql(
    dialect: Dialect,
    database: &str,
    table: &str,
    columns: &[String],
    pk: &[String],
    limit: i64,
    offset: i64,
) -> String {
    let target = table_ref(dialect, database, table);
    let column_list = columns
        .iter()
        .map(|column| quote_ident(dialect, column))
        .collect::<Vec<_>>()
        .join(", ");
    let order = if pk.is_empty() {
        String::new()
    } else {
        format!(
            " ORDER BY {}",
            pk.iter()
                .map(|column| quote_ident(dialect, column))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };

    match dialect {
        Dialect::Mssql => {
            let order = if order.is_empty() {
                " ORDER BY (SELECT NULL)".to_string()
            } else {
                order
            };
            format!(
                "SELECT {column_list} FROM {target}{order} OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"
            )
        }
        _ => format!(
            "SELECT {column_list} FROM {target}{order} LIMIT {limit} OFFSET {offset}"
        ),
    }
}

#[derive(Clone, Serialize)]
struct ExportProgress {
    id: String,
    rows: u64,
    done: bool,
    cancelled: bool,
}

async fn is_cancelled(state: &AppState, id: &str) -> bool {
    state.cancelled.read().await.contains(id)
}

async fn clear_cancelled(state: &AppState, id: &str) {
    state.cancelled.write().await.remove(id);
}

/// Export an already-fetched result set. Returns the saved path, or None when
/// the save dialog was cancelled.
#[tauri::command(rename_all = "snake_case")]
pub async fn export_result(
    app: tauri::AppHandle,
    format: String,
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    default_name: String,
    bom: Option<bool>,
    dialect: Option<Dialect>,
    database: Option<String>,
    table: Option<String>,
) -> AppResult<Option<String>> {
    if columns.is_empty() {
        return Err(AppError::Config("nothing to export".into()));
    }

    let format = ExportFormat::parse(&format)?;
    let path = match save_file_dialog(&app, default_name, format).await? {
        Some(path) => path,
        None => return Ok(None),
    };
    let path = ensure_extension(path, format.extension());

    let database = database.unwrap_or_default();
    let table = table
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "result".to_string());
    let dialect = dialect.unwrap_or(Dialect::Postgres);
    let bom = bom.unwrap_or(true);

    tokio::task::spawn_blocking(move || {
        write_loaded(
            format, &path, &columns, &rows, bom, dialect, &database, &table,
        )
        .map(|_| path)
    })
    .await
    .map_err(|error| AppError::Config(format!("export: {error}")))?
    .map(Some)
}

/// Backwards-compatible Excel-only command used by the command palette.
#[tauri::command(rename_all = "snake_case")]
pub async fn export_result_xlsx(
    app: tauri::AppHandle,
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    default_name: String,
) -> AppResult<Option<String>> {
    export_result(
        app,
        "xlsx".to_string(),
        columns,
        rows,
        default_name,
        None,
        None,
        None,
        None,
    )
    .await
}

/// Save an ER diagram rendered by the frontend. `data` is SVG text or a
/// base64-encoded PNG (a data URL prefix is accepted as well).
#[tauri::command(rename_all = "snake_case")]
pub async fn save_erd(
    app: tauri::AppHandle,
    format: String,
    data: String,
    default_name: String,
) -> AppResult<Option<String>> {
    let format = ErdFormat::parse(&format)?;
    let path = match save_file_dialog_with(
        &app,
        default_name,
        format.filter_label(),
        format.filter_extensions(),
    )
    .await?
    {
        Some(path) => path,
        None => return Ok(None),
    };
    let path = ensure_extension(path, format.extension());
    let bytes = match format {
        ErdFormat::Svg => data.into_bytes(),
        ErdFormat::Png => decode_base64(&data)?,
    };

    tokio::task::spawn_blocking(move || std::fs::write(&path, bytes).map(|_| path))
        .await
        .map_err(|error| AppError::Config(format!("save ERD: {error}")))?
        .map_err(io_err)
        .map(Some)
}

/// Export every row of a table in 5000-row pages, writing straight to disk.
/// Returns the saved path, or None when the save dialog was cancelled or the
/// operation was cancelled from the UI.
#[tauri::command(rename_all = "snake_case")]
pub async fn export_table(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    format: String,
    export_id: Option<String>,
    bom: Option<bool>,
) -> AppResult<Option<String>> {
    let format = ExportFormat::parse(&format)?;
    let driver = state.pool.get(&conn_id).await?;
    let dialect = driver.dialect();

    let column_info = driver.list_columns(&database, &table).await?;
    if column_info.is_empty() {
        return Err(AppError::Config("nothing to export".into()));
    }
    let columns: Vec<String> = column_info.iter().map(|column| column.name.clone()).collect();
    let pk: Vec<String> = column_info
        .iter()
        .filter(|column| column.key.as_deref() == Some("PRI"))
        .map(|column| column.name.clone())
        .collect();

    let default_name = format!("{table}.{}", format.extension());
    let path = match save_file_dialog(&app, default_name, format).await? {
        Some(path) => path,
        None => return Ok(None),
    };
    let path = ensure_extension(path, format.extension());

    let id = export_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut sink = TableSink::new(
        format,
        &path,
        &columns,
        bom.unwrap_or(true),
        dialect,
        &database,
        &table,
    )?;

    let mut offset = 0i64;
    let mut total = 0u64;
    let mut cancelled = false;

    loop {
        if is_cancelled(&state, &id).await {
            cancelled = true;
            break;
        }

        let sql = page_sql(
            dialect,
            &database,
            &table,
            &columns,
            &pk,
            PAGE_SIZE,
            offset,
        );
        let page: QueryResult = driver
            .run_statements(&[sql], PAGE_SIZE, Some(database.clone()))
            .await?;

        if page.rows.is_empty() {
            break;
        }

        sink.write_rows(&page.rows)?;
        let fetched = page.rows.len() as i64;
        total += fetched as u64;
        offset += fetched;

        let _ = app.emit(
            "export:progress",
            ExportProgress {
                id: id.clone(),
                rows: total,
                done: false,
                cancelled: false,
            },
        );

        if fetched < PAGE_SIZE {
            break;
        }
    }

    clear_cancelled(&state, &id).await;

    if cancelled {
        drop(sink);
        let _ = std::fs::remove_file(&path);
        let _ = app.emit(
            "export:progress",
            ExportProgress {
                id,
                rows: total,
                done: true,
                cancelled: true,
            },
        );
        return Ok(None);
    }

    sink.finish(&path)?;
    let _ = app.emit(
        "export:progress",
        ExportProgress {
            id,
            rows: total,
            done: true,
            cancelled: false,
        },
    );
    Ok(Some(path))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn cancel_operation(
    state: State<'_, AppState>,
    operation_id: String,
) -> AppResult<()> {
    state.cancelled.write().await.insert(operation_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        csv_text, guard_formula, insert_statements, json_object, sql_literal, ExportFormat,
    };
    use crate::core::drivers::Dialect;
    use serde_json::Value;

    fn header() -> Vec<String> {
        vec!["id".to_string(), "name".to_string()]
    }

    #[test]
    fn parses_the_supported_formats() {
        assert!(ExportFormat::parse("csv").is_ok());
        assert!(ExportFormat::parse("JSON").is_ok());
        assert!(ExportFormat::parse("sql").is_ok());
        assert!(ExportFormat::parse("xlsx").is_ok());
        assert!(ExportFormat::parse("yaml").is_err());
    }

    #[test]
    fn csv_writer_escapes_quotes_commas_and_newlines() {
        let mut out = Vec::new();
        {
            let mut writer = csv::WriterBuilder::new()
                .terminator(csv::Terminator::CRLF)
                .from_writer(&mut out);
            writer
                .write_record(&["a", "b"])
                .expect("header should write");
            writer
                .write_record(["x,\"y\"", "line1\nline2"])
                .expect("row should write");
            writer.flush().expect("flush should succeed");
        }

        assert_eq!(
            String::from_utf8(out).unwrap(),
            "a,b\r\n\"x,\"\"y\"\"\",\"line1\nline2\"\r\n"
        );
    }

    #[test]
    fn csv_formula_cells_are_prefixed() {
        assert_eq!(guard_formula("=SUM(A1)"), "'=SUM(A1)");
        assert_eq!(guard_formula("+1"), "'+1");
        assert_eq!(guard_formula("-1"), "'-1");
        assert_eq!(guard_formula("@cmd"), "'@cmd");
        assert_eq!(guard_formula("plain"), "plain");
        assert_eq!(csv_text(&Value::from("=1+1")), "'=1+1");
        assert_eq!(csv_text(&Value::from(-5)), "-5");
        assert_eq!(csv_text(&Value::Null), "");
    }

    #[test]
    fn json_keeps_big_integers_as_strings() {
        let columns = vec!["id".to_string(), "name".to_string()];
        let row = vec![Value::String("9007199254740993".to_string()), Value::from("Ada")];
        let object = json_object(&columns, &row);
        let text = serde_json::to_string(&object).unwrap();
        assert_eq!(text, r#"{"id":"9007199254740993","name":"Ada"}"#);
    }

    #[test]
    fn sql_uses_the_dialect_quoting_and_batches_rows() {
        let columns = header();
        let many: Vec<Vec<Value>> = (0..205)
            .map(|index| vec![Value::from(index), Value::from("O'Brien")])
            .collect();

        let pg = insert_statements(Dialect::Postgres, "", "users", &columns, &many);
        assert_eq!(pg.len(), 3);
        assert!(pg[0].starts_with("INSERT INTO \"users\" (\"id\", \"name\") VALUES"));
        assert!(pg[0].contains("E'O''Brien'"));
        assert_eq!(pg[0].matches("),\n  (").count(), 99);

        let mysql = insert_statements(Dialect::Mysql, "shop", "users", &columns, &many);
        assert!(mysql[0].starts_with("INSERT INTO `shop`.`users` (`id`, `name`) VALUES"));

        let mssql = insert_statements(Dialect::Mssql, "shop", "users", &columns, &many);
        assert!(mssql[0].starts_with("INSERT INTO [shop].[dbo].[users] ([id], [name]) VALUES"));
        assert!(mssql[0].contains("N'O''Brien'"));
    }

    #[test]
    fn sql_literals_keep_null_numbers_and_booleans() {
        assert_eq!(sql_literal(Dialect::Postgres, &Value::Null), "NULL");
        assert_eq!(sql_literal(Dialect::Postgres, &Value::from(42)), "42");
        assert_eq!(sql_literal(Dialect::Postgres, &Value::from(true)), "TRUE");
        assert_eq!(sql_literal(Dialect::Mysql, &Value::from(true)), "1");
        assert_eq!(sql_literal(Dialect::Sqlite, &Value::from("x")), "'x'");
    }
}
