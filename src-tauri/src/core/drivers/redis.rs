//! Redis over plain RESP2 on one TCP connection (no client crate needed).
//!
//! Redis has no tables, so the driver maps it onto the SQL-shaped app:
//! databases are `db0`..`dbN`, "tables" are key prefixes (`user:*`), and the
//! editor runs one Redis command per line. `BROWSE <pattern> [LIMIT n]` is a
//! DataForge command that lists matching keys with type, TTL and a value
//! preview; table tabs use it. TLS (`rediss://`) is on when the SSL mode is not
//! "disable".

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_rustls::rustls::pki_types::pem::PemObject;
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName};
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

use super::{
    BatchResult, BoundParam, BoxFuture, ColumnInfo, ConnectionInput, Dialect, Driver, ErSchema,
    QueryResult, SchemaSnapshot, SchemaTable, SslMode, StatementResult, TableInfo, TableKind,
    TxError, TxInput, TxStreamOutcome,
};
use crate::error::{AppError, AppResult};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const PREFIX_SCAN_KEYS: usize = 5_000;
const PREVIEW_ITEMS: i64 = 50;
const PREVIEW_CHARS: usize = 2_000;
/// Commands that take over the connection or never return.
const BLOCKED: [&str; 6] = ["SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "MONITOR", "SYNC", "PSYNC"];

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Resp {
    Simple(String),
    Error(String),
    Int(i64),
    Bulk(Option<Vec<u8>>),
    Array(Option<Vec<Resp>>),
}

impl Resp {
    fn text(&self) -> Option<String> {
        match self {
            Resp::Simple(text) => Some(text.clone()),
            Resp::Bulk(Some(bytes)) => Some(String::from_utf8_lossy(bytes).into_owned()),
            Resp::Int(value) => Some(value.to_string()),
            _ => None,
        }
    }

    fn int(&self) -> Option<i64> {
        match self {
            Resp::Int(value) => Some(*value),
            other => other.text().and_then(|text| text.parse().ok()),
        }
    }

    fn items(self) -> Vec<Resp> {
        match self {
            Resp::Array(Some(items)) => items,
            _ => Vec::new(),
        }
    }

    fn to_json(&self) -> Value {
        match self {
            Resp::Simple(text) | Resp::Error(text) => Value::String(text.clone()),
            Resp::Int(value) => json!(value),
            Resp::Bulk(None) | Resp::Array(None) => Value::Null,
            Resp::Bulk(Some(bytes)) => Value::String(String::from_utf8_lossy(bytes).into_owned()),
            Resp::Array(Some(items)) => Value::Array(items.iter().map(Resp::to_json).collect()),
        }
    }
}

pub(crate) fn encode(args: &[Vec<u8>]) -> Vec<u8> {
    let mut out = format!("*{}\r\n", args.len()).into_bytes();
    for arg in args {
        out.extend_from_slice(format!("${}\r\n", arg.len()).as_bytes());
        out.extend_from_slice(arg);
        out.extend_from_slice(b"\r\n");
    }
    out
}

fn io_err(error: std::io::Error) -> AppError {
    AppError::Db(format!("redis: {error}"))
}

fn read_reply<'a, R: tokio::io::AsyncBufRead + Unpin + Send>(
    reader: &'a mut R,
) -> BoxFuture<'a, AppResult<Resp>> {
    Box::pin(async move {
        let mut line = String::new();
        if reader.read_line(&mut line).await.map_err(io_err)? == 0 {
            return Err(AppError::Db("redis: connection closed".to_string()));
        }
        let line = line.trim_end_matches(['\r', '\n']);
        let kind = line.get(..1).unwrap_or("");
        let rest = line.get(1..).unwrap_or("");
        let number = || {
            rest.parse::<i64>()
                .map_err(|_| AppError::Db(format!("redis: bad reply {line:?}")))
        };
        Ok(match kind {
            "+" => Resp::Simple(rest.to_string()),
            "-" => Resp::Error(rest.to_string()),
            ":" => Resp::Int(number()?),
            "$" => {
                let len = number()?;
                if len < 0 {
                    Resp::Bulk(None)
                } else {
                    let mut data = vec![0u8; len as usize + 2];
                    reader.read_exact(&mut data).await.map_err(io_err)?;
                    data.truncate(len as usize);
                    Resp::Bulk(Some(data))
                }
            }
            "*" => {
                let len = number()?;
                if len < 0 {
                    Resp::Array(None)
                } else {
                    let mut items = Vec::with_capacity(len.min(10_000) as usize);
                    for _ in 0..len {
                        items.push(read_reply(reader).await?);
                    }
                    Resp::Array(Some(items))
                }
            }
            _ => return Err(AppError::Db(format!("redis: unexpected reply {line:?}"))),
        })
    })
}

/// Split a command line like redis-cli: whitespace separates arguments,
/// single or double quotes group them, and double quotes allow \n, \t, \" and \\.
pub(crate) fn split_args(line: &str) -> AppResult<Vec<Vec<u8>>> {
    let mut args = Vec::new();
    let mut chars = line.trim().trim_end_matches(';').chars().peekable();
    while let Some(&first) = chars.peek() {
        if first.is_whitespace() {
            chars.next();
            continue;
        }
        let mut arg = String::new();
        if first == '"' || first == '\'' {
            chars.next();
            let mut closed = false;
            while let Some(c) = chars.next() {
                if c == first {
                    closed = true;
                    break;
                }
                if c == '\\' && first == '"' {
                    match chars.next() {
                        Some('n') => arg.push('\n'),
                        Some('t') => arg.push('\t'),
                        Some('r') => arg.push('\r'),
                        Some(other) => arg.push(other),
                        None => break,
                    }
                } else {
                    arg.push(c);
                }
            }
            if !closed {
                return Err(AppError::Config("unbalanced quotes".to_string()));
            }
        } else {
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                arg.push(c);
                chars.next();
            }
        }
        args.push(arg.into_bytes());
    }
    Ok(args)
}

fn db_index(database: &str) -> Option<i64> {
    database.trim().trim_start_matches("db").parse().ok()
}

trait Io: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Io for T {}

struct Conn {
    reader: BufReader<Box<dyn Io>>,
    db: i64,
}

/// Public CA roots plus the connection's own CA file, if set.
fn tls_connector(ca_path: Option<&str>) -> AppResult<TlsConnector> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    if let Some(path) = ca_path.map(str::trim).filter(|path| !path.is_empty()) {
        let pem = std::fs::read(path)
            .map_err(|error| AppError::Config(format!("CA certificate: {error}")))?;
        for certificate in CertificateDer::pem_slice_iter(&pem) {
            let certificate = certificate
                .map_err(|error| AppError::Config(format!("CA certificate: {error}")))?;
            roots
                .add(certificate)
                .map_err(|error| AppError::Config(format!("CA certificate: {error}")))?;
        }
    }
    // shortcut: certificates are always verified (no "trust any certificate"); add a verifier option if self-signed servers without a CA file come up.
    let config = ClientConfig::builder_with_provider(Arc::new(
        tokio_rustls::rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|error| AppError::Db(format!("redis TLS: {error}")))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(TlsConnector::from(Arc::new(config)))
}

pub struct RedisDriver {
    host: String,
    port: u16,
    /// Certificate check name: the real server host, also through an SSH tunnel.
    tls: Option<(TlsConnector, ServerName<'static>)>,
    username: String,
    password: Option<String>,
    default_db: i64,
    conn: Mutex<Option<Conn>>,
}

impl RedisDriver {
    pub async fn connect(
        input: &ConnectionInput,
        password: Option<&str>,
        tls_host: &str,
    ) -> AppResult<Self> {
        let tls = if matches!(input.ssl_mode, None | Some(SslMode::Disable)) {
            None
        } else {
            let name = ServerName::try_from(tls_host.trim().to_string())
                .map_err(|_| AppError::Config(format!("redis TLS: invalid host {tls_host:?}")))?;
            Some((tls_connector(input.ssl_ca_path.as_deref())?, name))
        };
        let driver = Self {
            host: input.host.trim().to_string(),
            port: if input.port == 0 { 6379 } else { input.port },
            tls,
            username: input.username.trim().to_string(),
            password: password.filter(|value| !value.is_empty()).map(str::to_string),
            default_db: input.database.as_deref().and_then(db_index).unwrap_or(0),
            conn: Mutex::new(None),
        };
        driver.pipeline(None, vec![vec![b"PING".to_vec()]]).await?;
        Ok(driver)
    }

    async fn open(&self) -> AppResult<Conn> {
        let stream = tokio::time::timeout(
            Duration::from_secs(10),
            TcpStream::connect((self.host.as_str(), self.port)),
        )
        .await
        .map_err(|_| AppError::Db("redis: connection timed out".to_string()))?
        .map_err(io_err)?;
        let stream: Box<dyn Io> = match &self.tls {
            None => Box::new(stream),
            Some((connector, name)) => Box::new(
                tokio::time::timeout(Duration::from_secs(10), connector.connect(name.clone(), stream))
                    .await
                    .map_err(|_| AppError::Db("redis: TLS handshake timed out".to_string()))?
                    .map_err(|error| AppError::Db(format!("redis TLS: {error}")))?,
            ),
        };
        let mut conn = Conn {
            reader: BufReader::new(stream),
            db: 0,
        };
        if let Some(password) = &self.password {
            let mut auth = vec![b"AUTH".to_vec()];
            if !self.username.is_empty() && self.username != "default" {
                auth.push(self.username.clone().into_bytes());
            }
            auth.push(password.clone().into_bytes());
            if let Resp::Error(message) = exchange(&mut conn, vec![auth]).await?.remove(0) {
                return Err(AppError::Db(format!("redis: {message}")));
            }
        }
        Ok(conn)
    }

    /// Send every command, then read every reply (one round trip). A broken
    /// connection is dropped so the next call reconnects.
    async fn pipeline(&self, database: Option<&str>, commands: Vec<Vec<Vec<u8>>>) -> AppResult<Vec<Resp>> {
        let mut guard = self.conn.lock().await;
        if guard.is_none() {
            *guard = Some(self.open().await?);
        }
        let conn = guard.as_mut().expect("connection opened above");
        let want = database.and_then(db_index).unwrap_or(self.default_db);
        let mut commands = commands;
        let switch = conn.db != want;
        if switch {
            commands.insert(0, vec![b"SELECT".to_vec(), want.to_string().into_bytes()]);
        }
        match tokio::time::timeout(COMMAND_TIMEOUT, exchange(conn, commands)).await {
            Ok(Ok(mut replies)) => {
                if switch {
                    if let Resp::Error(message) = replies.remove(0) {
                        return Err(AppError::Db(format!("redis: {message}")));
                    }
                    conn.db = want;
                }
                Ok(replies)
            }
            Ok(Err(error)) => {
                *guard = None;
                Err(error)
            }
            Err(_) => {
                *guard = None;
                Err(AppError::Db("redis: command timed out".to_string()))
            }
        }
    }

    async fn command(&self, database: Option<&str>, args: Vec<Vec<u8>>) -> AppResult<Resp> {
        match self.pipeline(database, vec![args]).await?.remove(0) {
            Resp::Error(message) => Err(AppError::Db(message)),
            reply => Ok(reply),
        }
    }

    async fn scan(&self, database: Option<&str>, pattern: &str, limit: usize) -> AppResult<(Vec<String>, bool)> {
        let mut keys = Vec::new();
        let mut cursor = "0".to_string();
        loop {
            let reply = self
                .command(
                    database,
                    vec![
                        b"SCAN".to_vec(),
                        cursor.into_bytes(),
                        b"MATCH".to_vec(),
                        pattern.as_bytes().to_vec(),
                        b"COUNT".to_vec(),
                        b"1000".to_vec(),
                    ],
                )
                .await?;
            let mut parts = reply.items().into_iter();
            cursor = parts.next().and_then(|part| part.text()).unwrap_or_else(|| "0".to_string());
            for key in parts.next().map(Resp::items).unwrap_or_default() {
                if let Some(key) = key.text() {
                    keys.push(key);
                }
            }
            if keys.len() >= limit {
                keys.truncate(limit);
                return Ok((keys, cursor != "0"));
            }
            if cursor == "0" {
                return Ok((keys, false));
            }
        }
    }

    async fn browse(&self, database: Option<&str>, pattern: &str, limit: usize) -> AppResult<QueryResult> {
        let started = Instant::now();
        let (keys, more) = self.scan(database, pattern, limit).await?;
        let key_arg = |key: &String| key.as_bytes().to_vec();
        let mut meta = Vec::with_capacity(keys.len() * 2);
        for key in &keys {
            meta.push(vec![b"TYPE".to_vec(), key_arg(key)]);
            meta.push(vec![b"PTTL".to_vec(), key_arg(key)]);
        }
        let meta = self.pipeline(database, meta).await?;
        let types: Vec<String> = meta
            .chunks(2)
            .map(|pair| pair[0].text().unwrap_or_default())
            .collect();

        let n = PREVIEW_ITEMS.to_string().into_bytes();
        let values: Vec<Vec<Vec<u8>>> = keys
            .iter()
            .zip(&types)
            .map(|(key, kind)| {
                let key = key_arg(key);
                match kind.as_str() {
                    "string" => vec![b"GETRANGE".to_vec(), key, b"0".to_vec(), PREVIEW_CHARS.to_string().into_bytes()],
                    "hash" => vec![b"HSCAN".to_vec(), key, b"0".to_vec(), b"COUNT".to_vec(), n.clone()],
                    "list" => vec![b"LRANGE".to_vec(), key, b"0".to_vec(), (PREVIEW_ITEMS - 1).to_string().into_bytes()],
                    "set" => vec![b"SSCAN".to_vec(), key, b"0".to_vec(), b"COUNT".to_vec(), n.clone()],
                    "zset" => vec![b"ZRANGE".to_vec(), key, b"0".to_vec(), (PREVIEW_ITEMS - 1).to_string().into_bytes(), b"WITHSCORES".to_vec()],
                    "stream" => vec![b"XREVRANGE".to_vec(), key, b"+".to_vec(), b"-".to_vec(), b"COUNT".to_vec(), b"10".to_vec()],
                    _ => vec![b"TYPE".to_vec(), key],
                }
            })
            .collect();
        let values = self.pipeline(database, values).await?;

        let rows = keys
            .iter()
            .enumerate()
            .map(|(index, key)| {
                let kind = &types[index];
                let ttl = meta[index * 2 + 1].int().unwrap_or(-1);
                let value = match (kind.as_str(), &values[index]) {
                    (_, Resp::Error(message)) => Value::String(format!("(error) {message}")),
                    // SCAN-style replies are [cursor, items].
                    ("hash" | "set", reply) => {
                        let items = reply.clone().items().into_iter().nth(1).unwrap_or(Resp::Array(None));
                        preview(kind, &items)
                    }
                    (_, reply) => preview(kind, reply),
                };
                vec![
                    Value::String(key.clone()),
                    Value::String(kind.clone()),
                    if ttl < 0 { Value::Null } else { json!(ttl / 1000) },
                    value,
                ]
            })
            .collect();

        Ok(QueryResult {
            columns: vec!["key".into(), "type".into(), "ttl".into(), "value".into()],
            rows,
            rows_affected: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
            truncated: more,
        })
    }

    async fn run_line(&self, database: Option<&str>, line: &str, max_rows: i64) -> AppResult<QueryResult> {
        let started = Instant::now();
        let args = split_args(line)?;
        let Some(name) = args.first().map(|arg| String::from_utf8_lossy(arg).to_ascii_uppercase()) else {
            return Ok(QueryResult::empty());
        };
        if BLOCKED.contains(&name.as_str()) {
            return Err(AppError::Config(format!("{name} is not supported in DataForge")));
        }
        if name == "BROWSE" {
            let text = |index: usize| args.get(index).map(|arg| String::from_utf8_lossy(arg).into_owned());
            let pattern = text(1).unwrap_or_else(|| "*".to_string());
            let limit = match text(2).map(|word| word.to_ascii_uppercase()).as_deref() {
                Some("LIMIT") => text(3).and_then(|value| value.parse().ok()).unwrap_or(1000),
                _ => 1000,
            };
            return self.browse(database, &pattern, limit.min(max_rows.max(1) as usize)).await;
        }

        let reply = self.command(database, args).await?;
        let mut result = reply_table(&name, reply, max_rows.max(1) as usize);
        result.elapsed_ms = started.elapsed().as_millis() as u64;
        Ok(result)
    }
}

async fn exchange(conn: &mut Conn, commands: Vec<Vec<Vec<u8>>>) -> AppResult<Vec<Resp>> {
    let mut payload = Vec::new();
    for command in &commands {
        payload.extend_from_slice(&encode(command));
    }
    conn.reader.get_mut().write_all(&payload).await.map_err(io_err)?;
    conn.reader.get_mut().flush().await.map_err(io_err)?;
    let mut replies = Vec::with_capacity(commands.len());
    for _ in 0..commands.len() {
        replies.push(read_reply(&mut conn.reader).await?);
    }
    Ok(replies)
}

fn preview(kind: &str, reply: &Resp) -> Value {
    match reply {
        Resp::Bulk(Some(_)) | Resp::Simple(_) | Resp::Int(_) => reply.to_json(),
        Resp::Array(Some(items)) => {
            // Field/value and member/score pairs read best as an object.
            if matches!(kind, "hash" | "zset") && items.len() % 2 == 0 {
                let mut object = serde_json::Map::new();
                for pair in items.chunks(2) {
                    object.insert(pair[0].text().unwrap_or_default(), pair[1].to_json());
                }
                Value::String(Value::Object(object).to_string())
            } else {
                Value::String(reply.to_json().to_string())
            }
        }
        _ => Value::Null,
    }
}

/// Turn any reply into rows: scalars become one `value` cell, flat arrays one
/// row per item, and field/value replies (HGETALL, CONFIG GET) two columns.
pub(crate) fn reply_table(command: &str, reply: Resp, max_rows: usize) -> QueryResult {
    let mut result = QueryResult::empty();
    let pairs = matches!(command, "HGETALL" | "CONFIG" | "XINFO");
    match reply {
        Resp::Array(Some(items)) if pairs && items.len() % 2 == 0 => {
            result.columns = vec!["field".into(), "value".into()];
            result.truncated = items.len() / 2 > max_rows;
            result.rows = items
                .chunks(2)
                .take(max_rows)
                .map(|pair| vec![Value::String(pair[0].text().unwrap_or_default()), pair[1].to_json()])
                .collect();
        }
        Resp::Array(Some(items)) => {
            result.columns = vec!["#".into(), "value".into()];
            result.truncated = items.len() > max_rows;
            result.rows = items
                .iter()
                .take(max_rows)
                .enumerate()
                .map(|(index, item)| {
                    let value = match item {
                        Resp::Array(_) => Value::String(item.to_json().to_string()),
                        other => other.to_json(),
                    };
                    vec![json!(index + 1), value]
                })
                .collect();
        }
        Resp::Int(value) => {
            result.columns = vec!["value".into()];
            result.rows = vec![vec![json!(value)]];
            result.rows_affected = u64::try_from(value).ok();
        }
        other => {
            result.columns = vec!["value".into()];
            result.rows = vec![vec![other.to_json()]];
        }
    }
    result
}

fn unsupported(what: &str) -> AppError {
    AppError::Config(format!("{what} is not supported for Redis"))
}

impl Driver for RedisDriver {
    fn dialect(&self) -> Dialect {
        Dialect::Redis
    }

    fn dialect_name(&self) -> &'static str {
        "Redis"
    }

    fn query<'a>(&'a self, sql: &'a str, max_rows: i64) -> BoxFuture<'a, AppResult<QueryResult>> {
        Box::pin(async move { self.run_line(None, sql, max_rows).await })
    }

    fn run_statements_batch<'a>(
        &'a self,
        statements: &'a [String],
        _params: Vec<Vec<BoundParam>>,
        max_rows: i64,
        database: Option<String>,
    ) -> BoxFuture<'a, AppResult<BatchResult>> {
        Box::pin(async move {
            let mut results = Vec::with_capacity(statements.len());
            for (index, line) in statements.iter().enumerate() {
                match self.run_line(database.as_deref(), line, max_rows).await {
                    Ok(result) => results.push(StatementResult::new(line, result)),
                    Err(error) => return Ok(BatchResult::failure(results, index, line, error)),
                }
            }
            Ok(BatchResult::success(results))
        })
    }

    fn stream_table<'a>(
        &'a self,
        _sql: &'a str,
        _database: Option<String>,
        _batch_size: usize,
        _on_batch: &'a mut (dyn FnMut(Vec<Vec<Value>>) -> AppResult<bool> + Send),
    ) -> BoxFuture<'a, AppResult<bool>> {
        Box::pin(async move { Err(unsupported("Table export")) })
    }

    fn apply_transaction<'a>(
        &'a self,
        _statements: &'a [String],
        _database: Option<String>,
    ) -> BoxFuture<'a, Result<u64, TxError>> {
        Box::pin(async move { Err(TxError::new(None, unsupported("Editing rows"))) })
    }

    fn stream_transaction<'a>(
        &'a self,
        _input: tokio::sync::mpsc::Receiver<TxInput>,
        _database: Option<String>,
    ) -> BoxFuture<'a, Result<TxStreamOutcome, TxError>> {
        Box::pin(async move { Err(TxError::new(None, unsupported("Importing rows"))) })
    }

    fn stream_restore<'a>(
        &'a self,
        _input: tokio::sync::mpsc::Receiver<TxInput>,
        _database: Option<String>,
        _transactional: bool,
    ) -> BoxFuture<'a, Result<TxStreamOutcome, TxError>> {
        Box::pin(async move { Err(TxError::new(None, unsupported("Restore"))) })
    }

    fn get_schema<'a>(&'a self, database: Option<&'a str>) -> BoxFuture<'a, AppResult<SchemaSnapshot>> {
        Box::pin(async move {
            let name = database.map(str::to_string).unwrap_or_else(|| format!("db{}", self.default_db));
            let columns = key_columns();
            let tables = self
                .list_tables(&name)
                .await?
                .into_iter()
                .map(|table| SchemaTable {
                    name: table.name,
                    columns: columns.clone(),
                })
                .collect();
            Ok(SchemaSnapshot { database: name, tables })
        })
    }

    fn get_er_schema<'a>(&'a self, _database: Option<&'a str>) -> BoxFuture<'a, AppResult<ErSchema>> {
        Box::pin(async move { Err(unsupported("ER diagrams")) })
    }

    fn list_databases<'a>(&'a self) -> BoxFuture<'a, AppResult<Vec<String>>> {
        Box::pin(async move {
            // INFO keyspace lists databases that hold keys ("db3:keys=10,...").
            let info = self
                .command(None, vec![b"INFO".to_vec(), b"keyspace".to_vec()])
                .await?
                .text()
                .unwrap_or_default();
            let mut indexes: BTreeSet<i64> = info
                .lines()
                .filter_map(|line| line.split(':').next().and_then(db_index))
                .collect();
            indexes.insert(0);
            indexes.insert(self.default_db);
            Ok(indexes.into_iter().map(|index| format!("db{index}")).collect())
        })
    }

    fn list_tables<'a>(&'a self, database: &'a str) -> BoxFuture<'a, AppResult<Vec<TableInfo>>> {
        Box::pin(async move {
            let (keys, _) = self.scan(Some(database), "*", PREFIX_SCAN_KEYS).await?;
            Ok(prefix_tables(&keys)
                .into_iter()
                .map(|name| TableInfo {
                    name,
                    kind: TableKind::Table,
                })
                .collect())
        })
    }

    fn list_columns<'a>(&'a self, _database: &'a str, _table: &'a str) -> BoxFuture<'a, AppResult<Vec<ColumnInfo>>> {
        Box::pin(async move { Ok(key_columns()) })
    }
}

fn key_columns() -> Vec<ColumnInfo> {
    [("key", "string"), ("type", "string"), ("ttl", "integer"), ("value", "string")]
        .into_iter()
        .map(|(name, data_type)| ColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable: name == "ttl" || name == "value",
            key: None,
        })
        .collect()
}

/// "All keys" first, then one pattern per prefix before the first ':'.
pub(crate) fn prefix_tables(keys: &[String]) -> Vec<String> {
    let prefixes: BTreeSet<String> = keys
        .iter()
        .filter_map(|key| key.split_once(':').map(|(prefix, _)| format!("{prefix}:*")))
        .collect();
    std::iter::once("*".to_string()).chain(prefixes).collect()
}

#[cfg(test)]
mod tests {
    use super::{encode, prefix_tables, read_reply, reply_table, split_args, tls_connector, Resp};
    use serde_json::json;

    #[test]
    fn builds_a_tls_config_and_rejects_a_missing_ca_file() {
        assert!(tls_connector(None).is_ok());
        assert!(tls_connector(Some("/no/such/ca.pem")).is_err());
    }

    #[test]
    fn splits_arguments_like_redis_cli() {
        let args = split_args(r#"SET "user:1 name" 'it''s' "a\"b\n";"#).unwrap();
        let text: Vec<String> = args.iter().map(|arg| String::from_utf8_lossy(arg).into_owned()).collect();
        assert_eq!(text, vec!["SET", "user:1 name", "it", "s", "a\"b\n"]);
        assert!(split_args("GET \"open").is_err());
    }

    #[test]
    fn encodes_commands_as_resp_arrays() {
        assert_eq!(
            encode(&[b"GET".to_vec(), b"k".to_vec()]),
            b"*2\r\n$3\r\nGET\r\n$1\r\nk\r\n".to_vec()
        );
    }

    #[tokio::test]
    async fn parses_nested_replies() {
        let mut input: &[u8] = b"*3\r\n:5\r\n$-1\r\n*2\r\n+OK\r\n$2\r\nhi\r\n";
        let reply = read_reply(&mut input).await.unwrap();
        assert_eq!(
            reply,
            Resp::Array(Some(vec![
                Resp::Int(5),
                Resp::Bulk(None),
                Resp::Array(Some(vec![Resp::Simple("OK".into()), Resp::Bulk(Some(b"hi".to_vec()))])),
            ]))
        );
    }

    #[test]
    fn hgetall_becomes_field_value_rows() {
        let reply = Resp::Array(Some(vec![
            Resp::Bulk(Some(b"name".to_vec())),
            Resp::Bulk(Some(b"Ada".to_vec())),
        ]));
        let result = reply_table("HGETALL", reply, 100);
        assert_eq!(result.columns, vec!["field", "value"]);
        assert_eq!(result.rows, vec![vec![json!("name"), json!("Ada")]]);
    }

    #[test]
    fn groups_keys_by_prefix() {
        let keys = vec!["user:1".to_string(), "user:2".to_string(), "session:x".to_string(), "plain".to_string()];
        assert_eq!(prefix_tables(&keys), vec!["*", "session:*", "user:*"]);
    }
}
