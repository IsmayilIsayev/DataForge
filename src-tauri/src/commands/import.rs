use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager, State};
use tokio::sync::mpsc;

use crate::commands::export::insert_batch_sql;
use crate::core::drivers::{Dialect, TxInput};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const IMPORT_BATCH: usize = 500;
const PREVIEW_ROWS: usize = 21;
const SAVE_POINT: &str = "df_import_row";
const DELIMITERS: [u8; 4] = [b',', b';', b'\t', b'|'];

fn io_err(error: std::io::Error) -> AppError {
    AppError::Export(error.to_string())
}

fn csv_err(error: csv::Error) -> AppError {
    AppError::Export(format!("csv: {error}"))
}

#[derive(Deserialize, Clone)]
pub struct ColumnMapping {
    pub csv_index: usize,
    #[serde(default)]
    pub column: Option<String>,
}

#[derive(Serialize)]
pub struct CsvPreview {
    /// The delimiter as a one-character string (tab is "\t").
    pub delimiter: String,
    pub rows: Vec<Vec<String>>,
}

#[derive(Serialize)]
pub struct ImportSummary {
    pub inserted: u64,
    pub skipped: u64,
    pub errors: Vec<String>,
    pub cancelled: bool,
}

#[derive(Clone, Serialize)]
struct ImportProgress {
    id: String,
    processed: u64,
    inserted: u64,
    skipped: u64,
    done: bool,
    cancelled: bool,
}

/// Open the file and skip a UTF-8 BOM, returning the file plus the byte offset
/// where the CSV data starts so a sample read can seek back correctly.
fn open_without_bom(path: &str) -> AppResult<(File, u64)> {
    let mut file = File::open(path).map_err(io_err)?;
    let mut bom = [0u8; 3];
    let read = file.read(&mut bom).map_err(io_err)?;
    let offset = if read == 3 && bom == [0xEF, 0xBB, 0xBF] {
        3
    } else {
        0
    };
    file.seek(SeekFrom::Start(offset)).map_err(io_err)?;
    Ok((file, offset))
}

fn parse_delimiter(value: &Option<String>) -> AppResult<Option<u8>> {
    match value.as_deref() {
        None | Some("") => Ok(None),
        Some("\\t") | Some("\t") => Ok(Some(b'\t')),
        Some(text) => {
            let bytes = text.as_bytes();
            if bytes.len() == 1 {
                Ok(Some(bytes[0]))
            } else {
                Err(AppError::Config(format!("invalid delimiter: {text}")))
            }
        }
    }
}

fn count_unquoted(line: &str, delimiter: char) -> usize {
    let mut count = 0;
    let mut quoted = false;
    let mut chars = line.chars().peekable();

    while let Some(current) = chars.next() {
        if current == '"' {
            if quoted && chars.peek() == Some(&'"') {
                chars.next();
            } else {
                quoted = !quoted;
            }
        } else if current == delimiter && !quoted {
            count += 1;
        }
    }

    count
}

/// Pick the delimiter that appears on the most sample lines, breaking ties by
/// total occurrences. Falls back to a comma.
pub(crate) fn detect_delimiter_text(text: &str) -> u8 {
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(10)
        .collect();
    if lines.is_empty() {
        return b',';
    }

    let mut best = (b',', 0usize, 0usize);
    for &delimiter in DELIMITERS.iter() {
        let delimiter = delimiter as char;
        let mut lines_with = 0;
        let mut total = 0;
        for line in &lines {
            let count = count_unquoted(line, delimiter);
            if count > 0 {
                lines_with += 1;
                total += count;
            }
        }
        if lines_with > best.1 || (lines_with == best.1 && total > best.2) {
            best = (delimiter as u8, lines_with, total);
        }
    }

    if best.1 == 0 {
        b','
    } else {
        best.0
    }
}

fn resolve_delimiter(
    file: &mut File,
    offset: u64,
    requested: &Option<String>,
) -> AppResult<u8> {
    if let Some(delimiter) = parse_delimiter(requested)? {
        return Ok(delimiter);
    }

    let mut sample = vec![0u8; 65_536];
    let read = file.read(&mut sample).map_err(io_err)?;
    file.seek(SeekFrom::Start(offset)).map_err(io_err)?;
    Ok(detect_delimiter_text(&String::from_utf8_lossy(
        &sample[..read],
    )))
}

fn read_preview(path: &str, delimiter: Option<String>) -> AppResult<CsvPreview> {
    let (mut file, offset) = open_without_bom(path)?;
    let delimiter = resolve_delimiter(&mut file, offset, &delimiter)?;
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(file);

    let mut rows = Vec::new();
    for record in reader.records().take(PREVIEW_ROWS) {
        let record = record.map_err(csv_err)?;
        rows.push(record.iter().map(str::to_string).collect());
    }

    Ok(CsvPreview {
        delimiter: (delimiter as char).to_string(),
        rows,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn preview_csv(path: String, delimiter: Option<String>) -> AppResult<CsvPreview> {
    tauri::async_runtime::spawn_blocking(move || read_preview(&path, delimiter))
        .await
        .map_err(|error| AppError::Export(format!("preview: {error}")))?
}

/// Match CSV headers to table columns by name, case-insensitively.
pub(crate) fn auto_map(headers: &[String], table_columns: &[String]) -> Vec<Option<String>> {
    headers
        .iter()
        .map(|header| {
            let header = header.trim();
            if header.is_empty() {
                return None;
            }
            table_columns
                .iter()
                .find(|column| column.eq_ignore_ascii_case(header))
                .cloned()
        })
        .collect()
}

fn csv_value(text: Option<&str>, empty_as_null: bool) -> Value {
    match text {
        Some(text) if !(empty_as_null && text.is_empty()) => Value::String(text.to_string()),
        _ => Value::Null,
    }
}

struct ImportContext {
    path: String,
    delimiter: Option<String>,
    has_header: bool,
    pairs: Vec<(usize, String)>,
    columns: Vec<String>,
    empty_as_null: bool,
    skip_bad_rows: bool,
    dialect: Dialect,
    database: String,
    table: String,
}

fn emit_progress(
    app: &tauri::AppHandle,
    id: &str,
    processed: u64,
    inserted: u64,
    skipped: u64,
    done: bool,
    cancelled: bool,
) {
    let _ = app.emit(
        "import:progress",
        ImportProgress {
            id: id.to_string(),
            processed,
            inserted,
            skipped,
            done,
            cancelled,
        },
    );
}

fn is_cancelled(app: &tauri::AppHandle, id: &str) -> bool {
    app.state::<AppState>()
        .cancelled
        .blocking_read()
        .contains(id)
}

fn send(tx: &mpsc::Sender<TxInput>, item: TxInput) -> bool {
    tx.blocking_send(item).is_ok()
}

fn stream_import(
    app: tauri::AppHandle,
    id: String,
    context: ImportContext,
    tx: mpsc::Sender<TxInput>,
) -> AppResult<()> {
    let (mut file, offset) = open_without_bom(&context.path)?;
    let delimiter = resolve_delimiter(&mut file, offset, &context.delimiter)?;
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(file);

    let mut records = reader.records();
    if context.has_header {
        let _ = records.next();
    }

    let mut batch: Vec<Vec<Value>> = Vec::with_capacity(IMPORT_BATCH);
    let mut processed = 0u64;

    for record in records {
        if is_cancelled(&app, &id) {
            let _ = send(&tx, TxInput::Rollback);
            return Ok(());
        }

        let record = match record {
            Ok(record) => record,
            Err(error) => {
                let _ = send(&tx, TxInput::Rollback);
                return Err(csv_err(error));
            }
        };

        let row: Vec<Value> = context
            .pairs
            .iter()
            .map(|(index, _)| {
                csv_value(record.get(*index), context.empty_as_null)
            })
            .collect();
        processed += 1;

        if context.skip_bad_rows {
            // A savepoint per row keeps only the failing row out of the
            // transaction; the normal path below uses 500-row batches.
            let sql = insert_batch_sql(
                context.dialect,
                context.database.as_str(),
                context.table.as_str(),
                context.columns.as_slice(),
                std::slice::from_ref(&row),
            );
            if !send(&tx, TxInput::Savepoint(SAVE_POINT.to_string()))
                || !send(
                    &tx,
                    TxInput::Sql {
                        sql,
                        row: Some(processed),
                    },
                )
                || !send(&tx, TxInput::ReleaseSavepoint(SAVE_POINT.to_string()))
            {
                return Ok(());
            }
        } else {
            batch.push(row);
            if batch.len() >= IMPORT_BATCH {
                let sql = insert_batch_sql(
                    context.dialect,
                    context.database.as_str(),
                    context.table.as_str(),
                    context.columns.as_slice(),
                    batch.as_slice(),
                );
                if !send(
                    &tx,
                    TxInput::Sql {
                        sql,
                        row: None,
                    },
                ) {
                    return Ok(());
                }
                batch.clear();
                emit_progress(&app, &id, processed, processed, 0, false, false);
            }
        }

        if processed % 200 == 0 {
            emit_progress(&app, &id, processed, processed, 0, false, false);
        }
    }

    if !context.skip_bad_rows && !batch.is_empty() {
        let sql = insert_batch_sql(
            context.dialect,
            context.database.as_str(),
            context.table.as_str(),
            context.columns.as_slice(),
            batch.as_slice(),
        );
        let _ = send(
            &tx,
            TxInput::Sql {
                sql,
                row: None,
            },
        );
    }

    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn import_csv(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    path: String,
    delimiter: Option<String>,
    has_header: bool,
    mapping: Vec<ColumnMapping>,
    empty_as_null: bool,
    skip_bad_rows: bool,
    import_id: Option<String>,
) -> AppResult<ImportSummary> {
    let driver = state.pool.get(&conn_id).await?;
    let dialect = driver.dialect();
    let table_columns: Vec<String> = driver
        .list_columns(&database, &table)
        .await?
        .into_iter()
        .map(|column| column.name)
        .collect();
    if table_columns.is_empty() {
        return Err(AppError::Config("table has no columns".to_string()));
    }

    let mut pairs: Vec<(usize, String)> = mapping
        .iter()
        .filter_map(|item| {
            item.column
                .as_ref()
                .map(|column| (item.csv_index, column.clone()))
        })
        .collect();

    if pairs.is_empty() {
        if !has_header {
            return Err(AppError::Config(
                "map at least one CSV column to a table column".to_string(),
            ));
        }
        let preview = tauri::async_runtime::spawn_blocking({
            let path = path.clone();
            let delimiter = delimiter.clone();
            move || read_preview(&path, delimiter)
        })
        .await
        .map_err(|error| AppError::Export(format!("preview: {error}")))??;
        let headers = preview.rows.first().cloned().unwrap_or_default();
        pairs = auto_map(&headers, &table_columns)
            .into_iter()
            .enumerate()
            .filter_map(|(index, column)| column.map(|column| (index, column)))
            .collect();
    }

    if pairs.is_empty() {
        return Err(AppError::Config(
            "no CSV column matches a table column".to_string(),
        ));
    }

    for (_, column) in &pairs {
        if !table_columns.iter().any(|item| item == column) {
            return Err(AppError::Config(format!("unknown column: {column}")));
        }
    }

    let columns: Vec<String> = pairs.iter().map(|(_, column)| column.clone()).collect();
    let id = import_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    state.cancelled.write().await.remove(&id);

    let context = ImportContext {
        path,
        delimiter,
        has_header,
        pairs,
        columns,
        empty_as_null,
        skip_bad_rows,
        dialect,
        database: database.clone(),
        table,
    };

    let (tx, rx) = mpsc::channel(64);
    let task_app = app.clone();
    let task_id = id.clone();
    let reader = tokio::task::spawn_blocking(move || {
        stream_import(task_app, task_id, context, tx)
    });

    let outcome = driver
        .stream_transaction(rx, Some(database))
        .await
        .map_err(|failure| failure.error)?;
    let read_result = reader
        .await
        .map_err(|error| AppError::Export(format!("import: {error}")))?;
    state.cancelled.write().await.remove(&id);

    if let Err(error) = read_result {
        return Err(error);
    }

    if outcome.cancelled {
        emit_progress(&app, &id, 0, 0, 0, true, true);
        return Ok(ImportSummary {
            inserted: 0,
            skipped: 0,
            errors: Vec::new(),
            cancelled: true,
        });
    }

    let inserted = outcome.rows_affected;
    let skipped = outcome.errors.len() as u64;
    let errors: Vec<String> = outcome
        .errors
        .iter()
        .take(10)
        .map(|error| format!("Row {}: {}", error.row, error.error))
        .collect();

    emit_progress(
        &app,
        &id,
        inserted + skipped,
        inserted,
        skipped,
        true,
        false,
    );

    Ok(ImportSummary {
        inserted,
        skipped,
        errors,
        cancelled: false,
    })
}

#[cfg(test)]
mod tests {
    use super::{auto_map, csv_value, detect_delimiter_text};
    use serde_json::Value;

    #[test]
    fn detects_common_delimiters() {
        assert_eq!(detect_delimiter_text("a,b,c\n1,2,3\n"), b',');
        assert_eq!(detect_delimiter_text("a;b;c\n1;2;3\n"), b';');
        assert_eq!(detect_delimiter_text("a\tb\tc\n1\t2\t3\n"), b'\t');
        assert_eq!(detect_delimiter_text("a|b|c\n1|2|3\n"), b'|');
        assert_eq!(detect_delimiter_text("single\ncolumn\n"), b',');
    }

    #[test]
    fn ignores_delimiters_inside_quotes_when_detecting() {
        assert_eq!(
            detect_delimiter_text("\"a,b\";c\n\"1,2\";3\n"),
            b';'
        );
    }

    #[test]
    fn maps_headers_case_insensitively_and_skips_unknown_ones() {
        let headers = vec![
            "ID".to_string(),
            " Full_Name ".to_string(),
            "missing".to_string(),
        ];
        let table = vec!["id".to_string(), "full_name".to_string()];
        assert_eq!(
            auto_map(&headers, &table),
            vec![
                Some("id".to_string()),
                Some("full_name".to_string()),
                None
            ]
        );
    }

    #[test]
    fn empty_fields_become_null_only_when_enabled() {
        assert_eq!(csv_value(Some(""), true), Value::Null);
        assert_eq!(csv_value(Some(""), false), Value::String(String::new()));
        assert_eq!(
            csv_value(Some("Ada"), true),
            Value::String("Ada".to_string())
        );
        assert_eq!(csv_value(None, true), Value::Null);
    }
}
