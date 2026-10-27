use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use tokio::sync::watch;
use uuid::Uuid;

use crate::core::drivers::Driver;

/// Server-side cancellation instructions for one running query. The ids are
/// always parsed integers or a validated UUID; they are never taken from raw
/// user input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CancelTarget {
    Postgres(i32),
    Mysql(u64),
    Mssql(i32),
    Clickhouse(String),
    /// The driver cannot cancel on the server; dropping the task is enough.
    AbortOnly,
}

/// Shared cancellation state for a query run. The UI thread can signal
/// `cancel` while the driver future is executing; `target` is filled in by the
/// driver as soon as it knows the server-side query identity.
pub struct RunCancel {
    run_id: String,
    cancelled: watch::Sender<bool>,
    // Keep one receiver alive so `send` always updates the value.
    _receiver: watch::Receiver<bool>,
    target: Mutex<Option<CancelTarget>>,
}

impl RunCancel {
    pub fn new(run_id: String) -> Self {
        let (cancelled, receiver) = watch::channel(false);
        Self {
            run_id,
            cancelled,
            _receiver: receiver,
            target: Mutex::new(None),
        }
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn cancel(&self) {
        let _ = self.cancelled.send(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.cancelled.borrow()
    }

    /// Resolves when `cancel` is called. Checking the current value first also
    /// covers a cancellation that arrived before this future was created.
    pub async fn cancelled(&self) {
        let mut receiver = self.cancelled.subscribe();
        if *receiver.borrow() {
            return;
        }
        while receiver.changed().await.is_ok() {
            if *receiver.borrow() {
                return;
            }
        }
    }

    pub fn set_target(&self, target: CancelTarget) {
        if let Ok(mut slot) = self.target.lock() {
            *slot = Some(target);
        }
    }

    pub fn target(&self) -> Option<CancelTarget> {
        self.target.lock().ok().and_then(|slot| slot.clone())
    }
}

pub struct RunningQuery {
    pub cancel: Arc<RunCancel>,
    driver: Option<Arc<dyn Driver>>,
}

impl RunningQuery {
    pub fn new(cancel: Arc<RunCancel>, driver: Option<Arc<dyn Driver>>) -> Self {
        Self { cancel, driver }
    }

    /// Ask the database server to stop the statement. Best-effort: the caller
    /// still returns "cancelled" even when the server refuses (permissions,
    /// connection gone, …).
    pub async fn cancel_on_server(&self) {
        let Some(driver) = &self.driver else {
            return;
        };
        let Some(target) = self.cancel.target() else {
            return;
        };
        let _ = driver.cancel_query(target).await;
    }
}

#[derive(Default)]
pub struct RunRegistry {
    runs: RwLock<HashMap<String, Arc<RunningQuery>>>,
}

pub struct RunGuard<'a> {
    registry: &'a RunRegistry,
    run_id: String,
}

impl RunRegistry {
    pub fn register(&self, run_id: String, run: Arc<RunningQuery>) -> RunGuard<'_> {
        if let Ok(mut runs) = self.runs.write() {
            runs.insert(run_id.clone(), run);
        }
        RunGuard {
            registry: self,
            run_id,
        }
    }

    pub fn find(&self, run_id: &str) -> Option<Arc<RunningQuery>> {
        let runs = self.runs.read().ok()?;
        runs.get(run_id).cloned()
    }

    /// Signals the run. Returns false when the id is unknown.
    pub fn cancel(&self, run_id: &str) -> bool {
        match self.find(run_id) {
            Some(run) => {
                run.cancel.cancel();
                true
            }
            None => false,
        }
    }

    pub fn remove(&self, run_id: &str) -> bool {
        self.runs
            .write()
            .map(|mut runs| runs.remove(run_id).is_some())
            .unwrap_or(false)
    }
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        self.registry.remove(&self.run_id);
    }
}

pub fn postgres_cancel_sql(pid: i32) -> String {
    format!("SELECT pg_cancel_backend({pid})")
}

pub fn mysql_cancel_sql(connection_id: u64) -> String {
    format!("KILL QUERY {connection_id}")
}

pub fn mssql_cancel_sql(spid: i32) -> String {
    format!("KILL {spid}")
}

/// ClickHouse query ids come from the frontend run id. Validate it as a UUID
/// before embedding it in the KILL statement.
pub fn clickhouse_cancel_sql(query_id: &str) -> Option<String> {
    let query_id = Uuid::parse_str(query_id.trim()).ok()?;
    Some(format!("KILL QUERY WHERE query_id = '{query_id}'"))
}

#[cfg(test)]
mod tests {
    use super::{
        clickhouse_cancel_sql, mssql_cancel_sql, mysql_cancel_sql, postgres_cancel_sql,
        RunCancel, RunRegistry, RunningQuery,
    };
    use std::sync::Arc;

    fn running(run_id: &str) -> Arc<RunningQuery> {
        Arc::new(RunningQuery::new(
            Arc::new(RunCancel::new(run_id.to_string())),
            None,
        ))
    }

    #[test]
    fn guard_removes_the_run_on_drop() {
        let registry = RunRegistry::default();
        {
            let _guard = registry.register("run-1".to_string(), running("run-1"));
            assert!(registry.find("run-1").is_some());
        }
        assert!(registry.find("run-1").is_none());
    }

    #[test]
    fn cancelling_an_unknown_run_is_a_noop_and_returns_false() {
        let registry = RunRegistry::default();
        assert!(!registry.cancel("missing"));
        assert!(!registry.remove("missing"));
    }

    #[test]
    fn cancelling_a_known_run_signals_it() {
        let registry = RunRegistry::default();
        let run = running("run-2");
        let cancel = run.cancel.clone();
        let _guard = registry.register("run-2".to_string(), run);

        assert!(registry.cancel("run-2"));
        assert!(cancel.is_cancelled());
        assert!(registry.remove("run-2"));
        assert!(registry.find("run-2").is_none());
    }

    #[test]
    fn postgres_cancel_uses_only_the_backend_pid() {
        assert_eq!(
            postgres_cancel_sql(12345),
            "SELECT pg_cancel_backend(12345)"
        );
    }

    #[test]
    fn mysql_cancel_uses_only_the_connection_id() {
        assert_eq!(mysql_cancel_sql(98765), "KILL QUERY 98765");
    }

    #[test]
    fn mssql_cancel_uses_only_the_spid() {
        assert_eq!(mssql_cancel_sql(52), "KILL 52");
    }

    #[test]
    fn clickhouse_cancel_accepts_a_uuid_and_rejects_everything_else() {
        let id = "2f7c6e58-2a35-4f1a-9f6b-63a2d5db6f54";
        assert_eq!(
            clickhouse_cancel_sql(id).as_deref(),
            Some("KILL QUERY WHERE query_id = '2f7c6e58-2a35-4f1a-9f6b-63a2d5db6f54'")
        );
        assert!(clickhouse_cancel_sql("not-a-uuid").is_none());
        assert!(clickhouse_cancel_sql("x' OR 1=1 --").is_none());
    }
}
