use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use flate2::read::GzDecoder;
use serde::Serialize;
use tauri::{Emitter, Manager, State};
use tokio::sync::mpsc;

use crate::core::drivers::{Dialect, TxError, TxInput, TxStreamOutcome};
use crate::core::restore::{
    classify_statement, is_gzip, is_transaction_control, truncate_preview, RestoreStats,
    SqlSplitter, StatementCounts,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const PREVIEW_STATEMENTS: usize = 50;
const MAX_ERRORS: usize = 100;
const PROGRESS_STATEMENTS: u64 = 200;
const SAVEPOINT: &str = "df_restore";
const CHUNK_SIZE: usize = 64 * 1024;

fn io_err(error: io::Error) -> AppError {
    AppError::Config(format!("restore: {error}"))
}

struct CountingReader<R> {
    inner: R,
    count: Arc<AtomicU64>,
}

impl<R: Read> Read for CountingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.count.fetch_add(read as u64, Ordering::Relaxed);
        Ok(read)
    }
}

struct RestoreReader {
    reader: BufReader<Box<dyn Read + Send>>,
    total_bytes: u64,
    gzip: bool,
    counted: Arc<AtomicU64>,
}

impl RestoreReader {
    fn bytes_read(&self) -> u64 {
        self.counted.load(Ordering::Relaxed).min(self.total_bytes)
    }
}

fn open_reader(path: &str) -> AppResult<RestoreReader> {
    let mut file = File::open(path).map_err(io_err)?;
    let total_bytes = file.metadata().map_err(io_err)?.len();
    let mut magic = [0u8; 2];
    let read = file.read(&mut magic).map_err(io_err)?;
    file.seek(SeekFrom::Start(0)).map_err(io_err)?;

    let gzip = is_gzip(&magic[..read]);
    let counted = Arc::new(AtomicU64::new(0));
    let counting = CountingReader {
        inner: BufReader::new(file),
        count: counted.clone(),
    };
    let reader: Box<dyn Read + Send> = if gzip {
        Box::new(GzDecoder::new(counting))
    } else {
        Box::new(counting)
    };

    Ok(RestoreReader {
        reader: BufReader::new(reader),
        total_bytes,
        gzip,
        counted,
    })
}

#[derive(Serialize)]
pub struct RestorePreviewStatement {
    pub number: u64,
    pub sql: String,
}

#[derive(Serialize)]
pub struct RestorePreview {
    pub gzip: bool,
    pub total_bytes: u64,
    pub total_statements: u64,
    pub create: u64,
    pub insert: u64,
    pub other: u64,
    pub statements: Vec<RestorePreviewStatement>,
}

fn read_preview(path: &str, dialect: Dialect) -> AppResult<RestorePreview> {
    let mut source = open_reader(path)?;
    let mut splitter = SqlSplitter::new(dialect);
    let mut chunk = vec![0u8; CHUNK_SIZE];
    let mut output = Vec::new();
    let mut counts = StatementCounts::default();
    let mut preview = Vec::new();
    let mut total = 0u64;

    loop {
        let read = source.reader.read(&mut chunk).map_err(io_err)?;
        if read == 0 {
            splitter.finish(&mut output);
        } else {
            splitter.feed(&chunk[..read], &mut output);
        }

        for statement in output.drain(..) {
            total += 1;
            counts.add(classify_statement(&statement));
            if preview.len() < PREVIEW_STATEMENTS {
                preview.push(RestorePreviewStatement {
                    number: total,
                    sql: truncate_preview(&statement, 200),
                });
            }
        }

        if read == 0 {
            break;
        }
    }

    Ok(RestorePreview {
        gzip: source.gzip,
        total_bytes: source.total_bytes,
        total_statements: total,
        create: counts.create,
        insert: counts.insert,
        other: counts.other,
        statements: preview,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn restore_preview(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
) -> AppResult<RestorePreview> {
    let dialect = state
        .connections
        .read()
        .await
        .find(&conn_id)
        .ok_or(AppError::NoConnection)?
        .dialect;
    tauri::async_runtime::spawn_blocking(move || read_preview(&path, dialect))
        .await
        .map_err(|error| AppError::Config(format!("restore preview: {error}")))?
}

#[derive(Clone, Serialize)]
struct RestoreProgress {
    id: String,
    statements: u64,
    bytes_read: u64,
    total_bytes: u64,
    done: bool,
    cancelled: bool,
}

#[derive(Serialize)]
pub struct RestoreErrorInfo {
    pub statement: u64,
    pub sql: String,
    pub message: String,
}

#[derive(Serialize)]
pub struct RestoreSummary {
    pub statements: u64,
    pub failed: u64,
    pub errors: Vec<RestoreErrorInfo>,
    pub cancelled: bool,
    pub stopped_on_error: bool,
    pub rolled_back: bool,
    pub duration_ms: u64,
}

fn emit_progress(
    app: &tauri::AppHandle,
    id: &str,
    statements: u64,
    bytes_read: u64,
    total_bytes: u64,
    done: bool,
    cancelled: bool,
) {
    let _ = app.emit(
        "restore:progress",
        RestoreProgress {
            id: id.to_string(),
            statements,
            bytes_read,
            total_bytes,
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

struct FeedResult {
    sent: u64,
    skipped: u64,
    cancelled: bool,
    bytes_read: u64,
    total_bytes: u64,
}

fn stream_file(
    app: tauri::AppHandle,
    id: String,
    path: String,
    dialect: Dialect,
    transactional: bool,
    stop_on_error: bool,
    tx: mpsc::Sender<TxInput>,
) -> AppResult<FeedResult> {
    let mut source = open_reader(&path)?;
    let total_bytes = source.total_bytes;
    let mut splitter = SqlSplitter::new(dialect);
    let mut chunk = vec![0u8; CHUNK_SIZE];
    let mut output = Vec::new();
    let mut ordinal = 0u64;
    let mut sent = 0u64;
    let mut skipped = 0u64;
    let mut cancelled = false;
    let mut last_report = Instant::now();
    let mut last_count = 0u64;

    'read: loop {
        if is_cancelled(&app, &id) {
            cancelled = true;
            break;
        }

        let read = match source.reader.read(&mut chunk) {
            Ok(read) => read,
            Err(error) => {
                let _ = tx.blocking_send(TxInput::Rollback);
                return Err(io_err(error));
            }
        };
        if read == 0 {
            splitter.finish(&mut output);
        } else {
            splitter.feed(&chunk[..read], &mut output);
        }

        for statement in output.drain(..) {
            ordinal += 1;
            if is_cancelled(&app, &id) {
                cancelled = true;
                break 'read;
            }

            if transactional && is_transaction_control(&statement) {
                skipped += 1;
                continue;
            }

            if !stop_on_error
                && tx
                    .blocking_send(TxInput::Savepoint(SAVEPOINT.to_string()))
                    .is_err()
            {
                return Ok(FeedResult {
                    sent,
                    skipped,
                    cancelled: false,
                    bytes_read: source.bytes_read(),
                    total_bytes,
                });
            }

            if tx
                .blocking_send(TxInput::Sql {
                    sql: statement,
                    row: Some(ordinal),
                })
                .is_err()
            {
                return Ok(FeedResult {
                    sent,
                    skipped,
                    cancelled: false,
                    bytes_read: source.bytes_read(),
                    total_bytes,
                });
            }

            if !stop_on_error
                && tx
                    .blocking_send(TxInput::ReleaseSavepoint(SAVEPOINT.to_string()))
                    .is_err()
            {
                return Ok(FeedResult {
                    sent,
                    skipped,
                    cancelled: false,
                    bytes_read: source.bytes_read(),
                    total_bytes,
                });
            }

            sent += 1;
            let now = Instant::now();
            if sent - last_count >= PROGRESS_STATEMENTS
                || now.duration_since(last_report) >= Duration::from_secs(1)
            {
                emit_progress(
                    &app,
                    &id,
                    sent,
                    source.bytes_read(),
                    total_bytes,
                    false,
                    false,
                );
                last_count = sent;
                last_report = now;
            }
        }

        let now = Instant::now();
        if sent == last_count && now.duration_since(last_report) >= Duration::from_secs(1) {
            emit_progress(
                &app,
                &id,
                sent,
                source.bytes_read(),
                total_bytes,
                false,
                false,
            );
            last_report = now;
        }

        if read == 0 {
            break;
        }
    }

    if cancelled {
        let _ = tx.blocking_send(TxInput::Rollback);
    }

    Ok(FeedResult {
        sent,
        skipped,
        cancelled,
        bytes_read: source.bytes_read(),
        total_bytes,
    })
}

fn summary_from_outcome(
    outcome: &TxStreamOutcome,
    feed: &FeedResult,
    duration_ms: u64,
) -> RestoreSummary {
    let mut stats = RestoreStats::new(false, MAX_ERRORS);
    for error in &outcome.errors {
        stats.record_error(
            error.row,
            error.statement.as_deref().unwrap_or(""),
            &error.error,
        );
    }

    RestoreSummary {
        statements: feed.sent.saturating_sub(outcome.errors.len() as u64),
        failed: outcome.errors.len() as u64,
        errors: stats
            .errors
            .into_iter()
            .map(|error| RestoreErrorInfo {
                statement: error.statement,
                sql: error.sql,
                message: error.message,
            })
            .collect(),
        cancelled: outcome.cancelled || feed.cancelled,
        stopped_on_error: false,
        rolled_back: false,
        duration_ms,
    }
}

fn summary_from_error(
    error: &TxError,
    feed: &FeedResult,
    transactional: bool,
    duration_ms: u64,
) -> RestoreSummary {
    let statement = error.statement.map(|value| value as u64).unwrap_or(0);
    let executed = if statement > 0 {
        statement.saturating_sub(1).saturating_sub(feed.skipped)
    } else {
        feed.sent
    };
    let sql = error.statement_sql.clone().unwrap_or_default();
    let mut stats = RestoreStats::new(true, MAX_ERRORS);
    stats.record_error(statement, &sql, &error.error.to_string());

    RestoreSummary {
        statements: executed,
        failed: 1,
        errors: stats
            .errors
            .into_iter()
            .map(|error| RestoreErrorInfo {
                statement: error.statement,
                sql: error.sql,
                message: error.message,
            })
            .collect(),
        cancelled: false,
        stopped_on_error: true,
        rolled_back: transactional,
        duration_ms,
    }
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn restore_database(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    path: String,
    stop_on_error: Option<bool>,
    restore_id: Option<String>,
) -> AppResult<RestoreSummary> {
    let started = Instant::now();
    let stop_on_error = stop_on_error.unwrap_or(true);

    let meta = state
        .connections
        .read()
        .await
        .find(&conn_id)
        .ok_or(AppError::NoConnection)?;
    let dialect = meta.dialect;
    if meta.read_only.unwrap_or(false) {
        return Err(AppError::Config(format!(
            "“{}” is read-only — restore is blocked.",
            meta.name
        )));
    }
    if dialect == Dialect::Mongodb {
        return Err(AppError::Config(
            "Restore is not supported for MongoDB".to_string(),
        ));
    }

    let target = {
        let requested = database.trim();
        if requested.is_empty() {
            meta.database
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    if dialect == Dialect::Sqlite {
                        "main".to_string()
                    } else {
                        String::new()
                    }
                })
        } else {
            requested.to_string()
        }
    };
    if target.is_empty() && dialect != Dialect::Sqlite {
        return Err(AppError::Config(
            "Choose a target database before restoring".to_string(),
        ));
    }

    let transactional =
        stop_on_error && matches!(dialect, Dialect::Postgres | Dialect::Sqlite);
    let id = restore_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let driver = state.ensure_driver(&conn_id).await?;

    let (tx, rx) = mpsc::channel::<TxInput>(8);
    let app_for_feed = app.clone();
    let feed_id = id.clone();
    let feed_path = path.clone();
    let feed_database = target.clone();

    emit_progress(&app, &id, 0, 0, 0, false, false);

    let producer = tauri::async_runtime::spawn_blocking(move || {
        stream_file(
            app_for_feed,
            feed_id,
            feed_path,
            dialect,
            transactional,
            stop_on_error,
            tx,
        )
    });
    let driver_future = driver.stream_restore(rx, Some(feed_database), transactional);
    let (driver_result, producer_result) = tokio::join!(driver_future, producer);

    state.cancelled.write().await.remove(&id);

    let feed = match producer_result {
        Ok(result) => result?,
        Err(error) => {
            return Err(AppError::Config(format!("restore: {error}")));
        }
    };

    let duration_ms = started.elapsed().as_millis() as u64;
    let summary = match driver_result {
        Ok(outcome) => summary_from_outcome(&outcome, &feed, duration_ms),
        Err(error) => summary_from_error(&error, &feed, transactional, duration_ms),
    };

    emit_progress(
        &app,
        &id,
        feed.sent,
        feed.bytes_read,
        feed.total_bytes,
        true,
        summary.cancelled || summary.stopped_on_error,
    );

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use crate::core::drivers::Dialect;
    use crate::core::restore::split_statements;

    #[test]
    fn preview_and_restore_use_the_same_splitter() {
        let statements = split_statements("SELECT 1; SELECT 2;", Dialect::Postgres);
        assert_eq!(statements.len(), 2);
    }
}
