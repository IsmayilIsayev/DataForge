//! Running queries on the server: list them and stop one.

use tauri::State;

use crate::core::drivers::{Dialect, QueryResult};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// One row per running statement: id, user, database, state, seconds, query.
pub(crate) fn sessions_sql(dialect: Dialect) -> AppResult<&'static str> {
    Ok(match dialect {
        Dialect::Mysql => {
            "SELECT ID AS id, USER AS user, DB AS `database`, COMMAND AS state, TIME AS seconds, INFO AS query \
             FROM information_schema.PROCESSLIST \
             WHERE COMMAND <> 'Sleep' AND ID <> CONNECTION_ID() ORDER BY TIME DESC"
        }
        Dialect::Postgres => {
            "SELECT pid AS id, usename AS \"user\", datname AS \"database\", state, \
             EXTRACT(EPOCH FROM now() - query_start)::bigint AS seconds, query \
             FROM pg_stat_activity \
             WHERE state IS NOT NULL AND state <> 'idle' AND pid <> pg_backend_pid() \
             ORDER BY query_start"
        }
        Dialect::Mssql => {
            "SELECT r.session_id AS id, s.login_name AS [user], DB_NAME(r.database_id) AS [database], \
             r.status AS state, DATEDIFF(SECOND, r.start_time, GETDATE()) AS seconds, t.text AS query \
             FROM sys.dm_exec_requests r \
             JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id \
             CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t \
             WHERE s.is_user_process = 1 AND r.session_id <> @@SPID ORDER BY r.start_time"
        }
        Dialect::Clickhouse => {
            "SELECT query_id AS id, user, current_database AS database, 'running' AS state, \
             toInt64(elapsed) AS seconds, query \
             FROM system.processes WHERE query_id <> queryID() ORDER BY elapsed DESC"
        }
        other => {
            return Err(AppError::Config(format!(
                "running queries are not available for {other}"
            )))
        }
    })
}

/// SQL that stops one running statement. PostgreSQL and MySQL cancel only the
/// statement; SQL Server can only end the whole session (its transaction rolls back).
pub(crate) fn stop_sql(dialect: Dialect, id: &str) -> AppResult<String> {
    let id = id.trim();
    if dialect == Dialect::Clickhouse {
        if id.is_empty() {
            return Err(AppError::Config("invalid query id".to_string()));
        }
        return Ok(format!(
            "KILL QUERY WHERE query_id = '{}' ASYNC",
            id.replace('\\', "\\\\").replace('\'', "\\'")
        ));
    }
    let number: i64 = id
        .parse()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| AppError::Config("invalid session id".to_string()))?;
    Ok(match dialect {
        Dialect::Mysql => format!("KILL QUERY {number}"),
        Dialect::Postgres => format!("SELECT pg_cancel_backend({number})"),
        Dialect::Mssql => format!("KILL {number}"),
        other => {
            return Err(AppError::Config(format!(
                "stopping queries is not available for {other}"
            )))
        }
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_running_queries(state: State<'_, AppState>, conn_id: String) -> AppResult<QueryResult> {
    let driver = state.pool.get(&conn_id).await?;
    let sql = sessions_sql(driver.dialect())?.to_string();
    driver.run_statements(&[sql], 500, None).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn stop_running_query(state: State<'_, AppState>, conn_id: String, id: String) -> AppResult<()> {
    let meta = state
        .connections
        .read()
        .await
        .find(&conn_id)
        .ok_or(AppError::NoConnection)?;
    if meta.read_only.unwrap_or(false) {
        return Err(AppError::Config(format!(
            "“{}” is read-only — stopping queries is blocked.",
            meta.name
        )));
    }
    let driver = state.pool.get(&conn_id).await?;
    let sql = stop_sql(driver.dialect(), &id)?;
    let result = driver.run_statements(&[sql], 1, None).await?;
    if driver.dialect() == Dialect::Postgres
        && result.rows.first().and_then(|row| row.first()) == Some(&serde_json::Value::Bool(false))
    {
        return Err(AppError::Config(
            "PostgreSQL did not cancel it: the query already ended or you lack permission".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{sessions_sql, stop_sql};
    use crate::core::drivers::Dialect;

    #[test]
    fn builds_stop_statements_from_validated_ids() {
        assert_eq!(stop_sql(Dialect::Mysql, " 42 ").unwrap(), "KILL QUERY 42");
        assert_eq!(stop_sql(Dialect::Postgres, "7").unwrap(), "SELECT pg_cancel_backend(7)");
        assert_eq!(stop_sql(Dialect::Mssql, "55").unwrap(), "KILL 55");
        assert!(stop_sql(Dialect::Mysql, "1; DROP TABLE x").is_err());
        assert!(stop_sql(Dialect::Postgres, "-1").is_err());
        assert_eq!(
            stop_sql(Dialect::Clickhouse, "a'b").unwrap(),
            "KILL QUERY WHERE query_id = 'a\\'b' ASYNC"
        );
        assert!(stop_sql(Dialect::Sqlite, "1").is_err());
        assert!(sessions_sql(Dialect::Redis).is_err());
    }
}
