use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::core::drivers::Dialect;
use crate::core::schema_diff::{diff_schemas, SchemaDiff};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[tauri::command(rename_all = "snake_case")]
pub async fn compare_schemas(
    state: State<'_, AppState>,
    source_conn: String,
    source_db: String,
    target_conn: String,
    target_db: String,
) -> AppResult<SchemaDiff> {
    let source = state.ensure_driver(&source_conn).await?;
    let target = state.ensure_driver(&target_conn).await?;
    let source_dialect = source.dialect();
    let target_dialect = target.dialect();

    if source_dialect != target_dialect {
        return Err(AppError::Config(format!(
            "Cannot compare schemas: source is {} but target is {}. Both connections must use the same dialect.",
            source_dialect, target_dialect
        )));
    }

    if !matches!(
        source_dialect,
        Dialect::Mysql | Dialect::Postgres | Dialect::Sqlite
    ) {
        return Err(AppError::Config(format!(
            "Schema compare is not supported for {}",
            source_dialect
        )));
    }

    let source_schema = source.get_diff_schema(Some(source_db.trim())).await?;
    let target_schema = target.get_diff_schema(Some(target_db.trim())).await?;

    Ok(diff_schemas(source_dialect, &source_schema, &target_schema))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn save_sql_script(
    app: tauri::AppHandle,
    sql: String,
    default_name: String,
) -> AppResult<Option<String>> {
    let dialog_app = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("SQL file", &["sql"])
            .set_file_name(default_name)
            .blocking_save_file()
    })
    .await
    .map_err(|error| AppError::Config(format!("save dialog: {error}")))?;

    let Some(path) = path else {
        return Ok(None);
    };
    let mut path = path
        .into_path()
        .map_err(|error| AppError::Config(format!("save dialog: {error}")))?
        .to_string_lossy()
        .into_owned();
    if !path.to_ascii_lowercase().ends_with(".sql") {
        path.push_str(".sql");
    }

    tokio::task::spawn_blocking(move || std::fs::write(&path, sql.as_bytes()).map(|_| path))
        .await
        .map_err(|error| AppError::Config(format!("save SQL: {error}")))?
        .map_err(|error| AppError::Export(error.to_string()))
        .map(Some)
}
