//! Scheduled backups: every N hours, dump a database into a folder and keep the
//! newest K files. Runs while the app is open; a run missed while it was closed
//! starts shortly after the next launch.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;

use crate::commands::backup::{backup_all_to, safe_stem};
use crate::core::backup::{timestamp_utc, DumpMode};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Serializes read-modify-write of the schedules file between the UI and the timer.
static FILE_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSchedule {
    #[serde(default)]
    pub id: String,
    pub conn_id: String,
    pub database: String,
    pub folder: String,
    pub every_hours: u32,
    pub keep: u32,
    pub gzip: bool,
    pub mode: DumpMode,
    #[serde(default)]
    pub last_run: Option<u64>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub last_path: Option<String>,
}

#[derive(Clone, Serialize)]
struct ScheduleRan {
    id: String,
    database: String,
    path: Option<String>,
    error: Option<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn file_path(app: &tauri::AppHandle) -> PathBuf {
    app.state::<AppState>().config_dir.join("backup-schedules.json")
}

fn load(path: &Path) -> Vec<BackupSchedule> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn store(path: &Path, schedules: &[BackupSchedule]) -> AppResult<()> {
    let data = serde_json::to_string_pretty(schedules)
        .map_err(|error| AppError::Config(format!("schedules: {error}")))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data).map_err(|error| AppError::Config(format!("schedules: {error}")))?;
    std::fs::rename(&tmp, path).map_err(|error| AppError::Config(format!("schedules: {error}")))
}

pub(crate) fn is_due(schedule: &BackupSchedule, now: u64) -> bool {
    match schedule.last_run {
        None => true,
        Some(last) => now.saturating_sub(last) >= u64::from(schedule.every_hours) * 3_600,
    }
}

/// "shop-2026-11-06_141500.sql.gz": sortable by name, recognisable when pruning.
fn backup_name(database: &str, gzip: bool) -> String {
    let stamp = timestamp_utc()
        .trim_end_matches(" UTC")
        .replace(' ', "_")
        .replace(':', "");
    format!("{}-{stamp}.{}", safe_stem(database), if gzip { "sql.gz" } else { "sql" })
}

/// Files this schedule wrote: "<stem>-YYYY-MM-DD_HHMMSS.sql[.gz]". Anything
/// else in the folder is never touched.
pub(crate) fn is_scheduled_file(name: &str, stem: &str, gzip: bool) -> bool {
    let extension = if gzip { ".sql.gz" } else { ".sql" };
    let Some(stamp) = name
        .strip_prefix(stem)
        .and_then(|rest| rest.strip_prefix('-'))
        .and_then(|rest| rest.strip_suffix(extension))
    else {
        return false;
    };
    stamp.len() == 17
        && stamp.char_indices().all(|(index, c)| match index {
            4 | 7 => c == '-',
            10 => c == '_',
            _ => c.is_ascii_digit(),
        })
}

fn prune(folder: &str, database: &str, gzip: bool, keep: u32) {
    let stem = safe_stem(database);
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| is_scheduled_file(name, &stem, gzip))
        .collect();
    names.sort_unstable_by(|a, b| b.cmp(a));
    for name in names.into_iter().skip(keep.max(1) as usize) {
        let _ = std::fs::remove_file(Path::new(folder).join(name));
    }
}

async fn run_due(app: &tauri::AppHandle) {
    let path = file_path(app);
    let due: Vec<BackupSchedule> = {
        let _guard = FILE_LOCK.lock().await;
        load(&path).into_iter().filter(|item| is_due(item, now())).collect()
    };

    for schedule in due {
        let target = Path::new(&schedule.folder).join(backup_name(&schedule.database, schedule.gzip));
        let target = target.to_string_lossy().into_owned();
        let result = backup_all_to(
            app,
            &schedule.conn_id,
            &schedule.database,
            schedule.mode,
            schedule.gzip,
            &target,
        )
        .await;
        if result.is_ok() {
            prune(&schedule.folder, &schedule.database, schedule.gzip, schedule.keep);
        }

        let error = result.err().map(|error| error.to_string());
        let _guard = FILE_LOCK.lock().await;
        let mut schedules = load(&path);
        if let Some(item) = schedules.iter_mut().find(|item| item.id == schedule.id) {
            item.last_run = Some(now());
            item.last_path = error.is_none().then(|| target.clone());
            item.last_error = error.clone();
            let _ = store(&path, &schedules);
        }
        let _ = app.emit(
            "backup-schedule:ran",
            ScheduleRan {
                id: schedule.id,
                database: schedule.database,
                path: error.is_none().then_some(target),
                error,
            },
        );
    }
}

/// Start the timer. Checks once a minute; the first check waits a little so
/// launching the app stays fast.
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        loop {
            run_due(&app).await;
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_backup_schedules(app: tauri::AppHandle) -> AppResult<Vec<BackupSchedule>> {
    let _guard = FILE_LOCK.lock().await;
    Ok(load(&file_path(&app)))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn save_backup_schedule(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    schedule: BackupSchedule,
) -> AppResult<Vec<BackupSchedule>> {
    let mut schedule = schedule;
    if !(1..=720).contains(&schedule.every_hours) {
        return Err(AppError::Config("repeat every 1 to 720 hours".to_string()));
    }
    if !(1..=365).contains(&schedule.keep) {
        return Err(AppError::Config("keep 1 to 365 backups".to_string()));
    }
    if schedule.database.trim().is_empty() {
        return Err(AppError::Config("choose a database".to_string()));
    }
    if !Path::new(&schedule.folder).is_dir() {
        return Err(AppError::Config("choose an existing folder".to_string()));
    }
    if state.connections.read().await.find(&schedule.conn_id).is_none() {
        return Err(AppError::NoConnection);
    }

    let path = file_path(&app);
    let _guard = FILE_LOCK.lock().await;
    let mut schedules = load(&path);
    match schedules.iter_mut().find(|item| !schedule.id.is_empty() && item.id == schedule.id) {
        Some(existing) => {
            schedule.last_run = existing.last_run;
            schedule.last_error = existing.last_error.clone();
            schedule.last_path = existing.last_path.clone();
            *existing = schedule;
        }
        None => {
            schedule.id = uuid::Uuid::new_v4().to_string();
            schedule.last_run = None;
            schedule.last_error = None;
            schedule.last_path = None;
            schedules.push(schedule);
        }
    }
    store(&path, &schedules)?;
    Ok(schedules)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn delete_backup_schedule(app: tauri::AppHandle, id: String) -> AppResult<Vec<BackupSchedule>> {
    let path = file_path(&app);
    let _guard = FILE_LOCK.lock().await;
    let mut schedules = load(&path);
    schedules.retain(|item| item.id != id);
    store(&path, &schedules)?;
    Ok(schedules)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn pick_backup_folder(app: tauri::AppHandle) -> AppResult<Option<String>> {
    let folder = tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .map_err(|error| AppError::Config(format!("folder picker: {error}")))?;
    match folder {
        Some(folder) => Ok(Some(
            folder
                .into_path()
                .map_err(|error| AppError::Config(format!("folder picker: {error}")))?
                .to_string_lossy()
                .into_owned(),
        )),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_due, is_scheduled_file, BackupSchedule};
    use crate::core::backup::DumpMode;

    #[test]
    fn prunes_only_files_it_wrote() {
        assert!(is_scheduled_file("shop-2026-11-06_141500.sql.gz", "shop", true));
        assert!(!is_scheduled_file("shop-2026-11-06_141500.sql", "shop", true));
        assert!(!is_scheduled_file("shop-notes.sql.gz", "shop", true));
        assert!(!is_scheduled_file("shopping-2026-11-06_141500.sql.gz", "shop", true));
        assert!(!is_scheduled_file("shop-2026-11-06_141500.sql.gz.bak", "shop", true));
    }

    #[test]
    fn runs_when_the_interval_has_passed() {
        let mut schedule = BackupSchedule {
            id: "a".into(),
            conn_id: "c".into(),
            database: "shop".into(),
            folder: "/tmp".into(),
            every_hours: 24,
            keep: 7,
            gzip: true,
            mode: DumpMode::Both,
            last_run: None,
            last_error: None,
            last_path: None,
        };
        assert!(is_due(&schedule, 1_000));
        schedule.last_run = Some(1_000);
        assert!(!is_due(&schedule, 1_000 + 23 * 3_600));
        assert!(is_due(&schedule, 1_000 + 24 * 3_600));
    }
}
