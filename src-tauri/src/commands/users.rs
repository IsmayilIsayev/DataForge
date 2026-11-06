//! Database users: list them, see what a user may do in a database, create,
//! drop, grant and revoke. All SQL is built here from validated parts; the UI
//! never sends SQL. Passwords are only placed into the statement sent to the
//! server and are never stored or returned.

use serde::Deserialize;
use tauri::State;

use crate::commands::edit::{quote_ident, quote_lit};
use crate::core::drivers::{Dialect, QueryResult};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    Read,
    Write,
    All,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum UserAction {
    Create { name: String, host: Option<String>, password: String },
    Drop { name: String, host: Option<String> },
    Grant { name: String, host: Option<String>, database: String, access: Access },
    Revoke { name: String, host: Option<String>, database: String },
}

fn supported(dialect: Dialect) -> AppResult<()> {
    match dialect {
        Dialect::Mysql | Dialect::Postgres | Dialect::Mssql => Ok(()),
        other => Err(AppError::Config(format!("user management is not available for {other}"))),
    }
}

fn check_name(value: &str, what: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(AppError::Config(format!("invalid {what}")));
    }
    Ok(value.to_string())
}

/// MySQL account: 'name'@'host' (host defaults to any host).
fn mysql_account(name: &str, host: Option<&str>) -> AppResult<String> {
    let host = host.map(str::trim).filter(|value| !value.is_empty()).unwrap_or("%");
    Ok(format!(
        "{}@{}",
        quote_lit(Dialect::Mysql, Some(&check_name(name, "user name")?)),
        quote_lit(Dialect::Mysql, Some(&check_name(host, "host")?))
    ))
}

pub(crate) fn users_sql(dialect: Dialect) -> AppResult<&'static str> {
    supported(dialect)?;
    Ok(match dialect {
        Dialect::Mysql => "SELECT User AS name, Host AS host FROM mysql.user ORDER BY User, Host",
        Dialect::Postgres => {
            "SELECT rolname AS name, rolcanlogin AS can_login, rolsuper AS superuser, rolcreatedb AS create_db \
             FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname"
        }
        _ => {
            "SELECT name, type_desc AS kind, is_disabled AS disabled FROM sys.server_principals \
             WHERE type IN ('S', 'U', 'G') AND name NOT LIKE '##%' ORDER BY name"
        }
    })
}

/// What the user may do in `database`, as (database to run in, SQL).
pub(crate) fn grants_sql(dialect: Dialect, name: &str, host: Option<&str>, database: &str) -> AppResult<(Option<String>, String)> {
    supported(dialect)?;
    let name = check_name(name, "user name")?;
    Ok(match dialect {
        Dialect::Mysql => (None, format!("SHOW GRANTS FOR {}", mysql_account(&name, host)?)),
        Dialect::Postgres => (
            Some(database.to_string()),
            format!(
                "SELECT table_schema AS schema, table_name AS \"table\", string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges \
                 FROM information_schema.role_table_grants WHERE grantee = {} \
                 GROUP BY table_schema, table_name ORDER BY table_schema, table_name",
                quote_lit(Dialect::Postgres, Some(&name))
            ),
        ),
        _ => (
            Some(database.to_string()),
            format!(
                "SELECT r.name AS role FROM sys.database_role_members m \
                 JOIN sys.database_principals r ON r.principal_id = m.role_principal_id \
                 JOIN sys.database_principals u ON u.principal_id = m.member_principal_id \
                 WHERE u.name = {} ORDER BY r.name",
                quote_lit(Dialect::Mssql, Some(&name))
            ),
        ),
    })
}

/// Statements for one action, each with the database it must run in.
pub(crate) fn action_sql(dialect: Dialect, action: &UserAction) -> AppResult<Vec<(Option<String>, String)>> {
    supported(dialect)?;
    let pg = |name: &str| quote_ident(Dialect::Postgres, name);
    let ms = |name: &str| quote_ident(Dialect::Mssql, name);
    let in_db = |database: &str| -> AppResult<Option<String>> { Ok(Some(check_name(database, "database")?)) };
    let none = |sql: String| (None::<String>, sql);

    Ok(match action {
        UserAction::Create { name, host, password } => {
            let name = check_name(name, "user name")?;
            if password.is_empty() {
                return Err(AppError::Config("enter a password".to_string()));
            }
            match dialect {
                Dialect::Mysql => vec![none(format!(
                    "CREATE USER {} IDENTIFIED BY {}",
                    mysql_account(&name, host.as_deref())?,
                    quote_lit(Dialect::Mysql, Some(password))
                ))],
                Dialect::Postgres => vec![none(format!(
                    "CREATE ROLE {} LOGIN PASSWORD {}",
                    pg(&name),
                    quote_lit(Dialect::Postgres, Some(password))
                ))],
                _ => vec![none(format!(
                    "CREATE LOGIN {} WITH PASSWORD = {}",
                    ms(&name),
                    quote_lit(Dialect::Mssql, Some(password))
                ))],
            }
        }
        UserAction::Drop { name, host } => {
            let name = check_name(name, "user name")?;
            match dialect {
                Dialect::Mysql => vec![none(format!("DROP USER {}", mysql_account(&name, host.as_deref())?))],
                Dialect::Postgres => vec![none(format!("DROP ROLE {}", pg(&name)))],
                _ => vec![none(format!("DROP LOGIN {}", ms(&name)))],
            }
        }
        UserAction::Grant { name, host, database, access } => {
            let name = check_name(name, "user name")?;
            let db = in_db(database)?;
            let database = db.clone().unwrap_or_default();
            match dialect {
                Dialect::Mysql => {
                    let privileges = match access {
                        Access::Read => "SELECT",
                        Access::Write => "SELECT, INSERT, UPDATE, DELETE",
                        Access::All => "ALL PRIVILEGES",
                    };
                    vec![none(format!(
                        "GRANT {privileges} ON {}.* TO {}",
                        quote_ident(Dialect::Mysql, &database),
                        mysql_account(&name, host.as_deref())?
                    ))]
                }
                Dialect::Postgres => {
                    let tables = match access {
                        Access::Read => "SELECT",
                        Access::Write => "SELECT, INSERT, UPDATE, DELETE",
                        Access::All => "ALL PRIVILEGES",
                    };
                    let user = pg(&name);
                    let mut statements = vec![
                        none(format!("GRANT CONNECT ON DATABASE {} TO {user}", pg(&database))),
                        (db.clone(), format!("GRANT USAGE ON SCHEMA public TO {user}")),
                        (db.clone(), format!("GRANT {tables} ON ALL TABLES IN SCHEMA public TO {user}")),
                        (db.clone(), format!("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT {tables} ON TABLES TO {user}")),
                    ];
                    if *access != Access::Read {
                        statements.push((db.clone(), format!("GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO {user}")));
                    }
                    statements
                }
                _ => {
                    let user = ms(&name);
                    let mut statements = vec![(
                        db.clone(),
                        format!(
                            "IF USER_ID({}) IS NULL CREATE USER {user} FOR LOGIN {user}",
                            quote_lit(Dialect::Mssql, Some(&name))
                        ),
                    )];
                    let roles: &[&str] = match access {
                        Access::Read => &["db_datareader"],
                        Access::Write => &["db_datareader", "db_datawriter"],
                        Access::All => &["db_owner"],
                    };
                    for role in roles {
                        statements.push((db.clone(), format!("ALTER ROLE {role} ADD MEMBER {user}")));
                    }
                    statements
                }
            }
        }
        UserAction::Revoke { name, host, database } => {
            let name = check_name(name, "user name")?;
            let db = in_db(database)?;
            let database = db.clone().unwrap_or_default();
            match dialect {
                Dialect::Mysql => vec![none(format!(
                    "REVOKE ALL PRIVILEGES ON {}.* FROM {}",
                    quote_ident(Dialect::Mysql, &database),
                    mysql_account(&name, host.as_deref())?
                ))],
                Dialect::Postgres => {
                    let user = pg(&name);
                    vec![
                        (db.clone(), format!("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM {user}")),
                        (db.clone(), format!("REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM {user}")),
                        (db.clone(), format!("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {user}")),
                        (db.clone(), format!("REVOKE ALL ON SCHEMA public FROM {user}")),
                        none(format!("REVOKE ALL ON DATABASE {} FROM {user}", pg(&database))),
                    ]
                }
                _ => {
                    let user = ms(&name);
                    ["db_owner", "db_datawriter", "db_datareader"]
                        .iter()
                        .map(|role| {
                            (
                                db.clone(),
                                format!(
                                    "IF IS_ROLEMEMBER('{role}', {}) = 1 ALTER ROLE {role} DROP MEMBER {user}",
                                    quote_lit(Dialect::Mssql, Some(&name))
                                ),
                            )
                        })
                        .collect()
                }
            }
        }
    })
}

async fn writable(state: &State<'_, AppState>, conn_id: &str) -> AppResult<()> {
    let meta = state
        .connections
        .read()
        .await
        .find(conn_id)
        .ok_or(AppError::NoConnection)?;
    if meta.read_only.unwrap_or(false) {
        return Err(AppError::Config(format!(
            "“{}” is read-only — user changes are blocked.",
            meta.name
        )));
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_db_users(state: State<'_, AppState>, conn_id: String) -> AppResult<QueryResult> {
    let driver = state.pool.get(&conn_id).await?;
    let sql = users_sql(driver.dialect())?.to_string();
    driver.run_statements(&[sql], 5_000, None).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_user_grants(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
    host: Option<String>,
    database: String,
) -> AppResult<QueryResult> {
    let driver = state.pool.get(&conn_id).await?;
    let (database, sql) = grants_sql(driver.dialect(), &name, host.as_deref(), &database)?;
    driver.run_statements(&[sql], 5_000, database).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn manage_db_user(state: State<'_, AppState>, conn_id: String, action: UserAction) -> AppResult<()> {
    writable(&state, &conn_id).await?;
    let driver = state.pool.get(&conn_id).await?;
    for (database, sql) in action_sql(driver.dialect(), &action)? {
        // One statement at a time: CREATE/GRANT run in different databases on PostgreSQL and SQL Server.
        driver.run_statements(&[sql], 1, database).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{action_sql, grants_sql, Access, UserAction};
    use crate::core::drivers::Dialect;

    fn sql(dialect: Dialect, action: UserAction) -> Vec<String> {
        action_sql(dialect, &action).unwrap().into_iter().map(|(_, sql)| sql).collect()
    }

    #[test]
    fn quotes_names_and_passwords() {
        let create = sql(
            Dialect::Mysql,
            UserAction::Create { name: "o'neil".into(), host: None, password: "p'w\\".into() },
        );
        assert_eq!(create, vec!["CREATE USER 'o''neil'@'%' IDENTIFIED BY 'p''w\\\\'"]);

        let create = sql(
            Dialect::Postgres,
            UserAction::Create { name: "app\"x".into(), host: None, password: "s3cret".into() },
        );
        assert_eq!(create, vec!["CREATE ROLE \"app\"\"x\" LOGIN PASSWORD E's3cret'"]);

        let create = sql(
            Dialect::Mssql,
            UserAction::Create { name: "a]b".into(), host: None, password: "x'y".into() },
        );
        assert_eq!(create, vec!["CREATE LOGIN [a]]b] WITH PASSWORD = N'x''y'"]);
    }

    #[test]
    fn grants_by_access_level() {
        let grant = |dialect, access| {
            sql(
                dialect,
                UserAction::Grant { name: "app".into(), host: Some("10.0.0.%".into()), database: "shop".into(), access },
            )
        };
        assert_eq!(grant(Dialect::Mysql, Access::Read), vec!["GRANT SELECT ON `shop`.* TO 'app'@'10.0.0.%'"]);
        let pg = grant(Dialect::Postgres, Access::Write);
        assert_eq!(pg[0], "GRANT CONNECT ON DATABASE \"shop\" TO \"app\"");
        assert!(pg.iter().any(|item| item == "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"app\""));
        assert!(pg.iter().any(|item| item.contains("SEQUENCES")));
        let ms = grant(Dialect::Mssql, Access::Write);
        assert_eq!(ms.len(), 3);
        assert!(ms[2].ends_with("ALTER ROLE db_datawriter ADD MEMBER [app]"));
        let databases: Vec<Option<String>> = action_sql(
            Dialect::Postgres,
            &UserAction::Grant { name: "app".into(), host: None, database: "shop".into(), access: Access::Read },
        )
        .unwrap()
        .into_iter()
        .map(|(database, _)| database)
        .collect();
        assert_eq!(databases[0], None);
        assert_eq!(databases[1].as_deref(), Some("shop"));
    }

    #[test]
    fn rejects_bad_input() {
        assert!(action_sql(Dialect::Mysql, &UserAction::Drop { name: " ".into(), host: None }).is_err());
        assert!(action_sql(Dialect::Mysql, &UserAction::Create { name: "a".into(), host: None, password: String::new() }).is_err());
        assert!(action_sql(Dialect::Sqlite, &UserAction::Drop { name: "a".into(), host: None }).is_err());
        assert!(grants_sql(Dialect::Mysql, "a\nb", None, "shop").is_err());
        assert_eq!(grants_sql(Dialect::Mysql, "app", Some("localhost"), "shop").unwrap().1, "SHOW GRANTS FOR 'app'@'localhost'");
    }
}
