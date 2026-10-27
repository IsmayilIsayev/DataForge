//! Restore helpers shared by the command layer and the SQL editor.
//!
//! The splitter is the same state machine used by `run_query`, but it is
//! incremental: a dump can be read in small chunks and statements may cross
//! chunk boundaries anywhere, including inside quotes, comments and `$$`
//! bodies. Nothing here depends on Tauri, so the behaviour is unit tested.

use crate::core::drivers::Dialect;

/// Gzip files always start with this magic number. The extension alone is not
/// trusted because users rename dumps (and `.gz` files can be corrupted).
pub fn is_gzip(prefix: &[u8]) -> bool {
    prefix.len() >= 2 && prefix[0] == 0x1f && prefix[1] == 0x8b
}

/// First 200 characters, on a character boundary, for previews and errors.
pub fn truncate_preview(sql: &str, max_chars: usize) -> String {
    sql.chars().take(max_chars).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanState {
    Normal,
    SingleQuote,
    DoubleQuote,
    Backtick,
    Bracket,
    LineComment,
    BlockComment,
    /// PostgreSQL dollar-quoted body (`$$ ... $$` or `$tag$ ... $tag$`).
    Dollar,
}

enum TagResult {
    Complete(usize),
    Incomplete,
    NotTag,
}

fn is_tag_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Look ahead from `index` for a `$tag$` opener. `previous` is the byte before
/// the opener (used to avoid treating `a$b$` as a quote).
fn dollar_tag_at(input: &[u8], index: usize, previous: Option<u8>) -> TagResult {
    if previous.is_some_and(is_tag_byte) {
        return TagResult::NotTag;
    }

    let mut end = index + 1;
    while end < input.len() && is_tag_byte(input[end]) {
        end += 1;
    }

    if end >= input.len() {
        // The chunk ended before we could see the closing `$`; wait for more.
        return TagResult::Incomplete;
    }
    if input[end] != b'$' {
        return TagResult::NotTag;
    }
    if end > index + 1 && input[index + 1].is_ascii_digit() {
        // `$1` is a parameter, and tags cannot start with a digit.
        return TagResult::NotTag;
    }

    TagResult::Complete(end + 1 - index)
}

/// Stateful statement splitter. Feed arbitrary byte chunks with [`feed`], then
/// call [`finish`] once at end of input. Complete statements are appended to
/// the output vector (without their trailing semicolon and trimmed).
pub struct SqlSplitter {
    dialect: Dialect,
    state: ScanState,
    buffer: Vec<u8>,
    has_code: bool,
    dollar_tag: Vec<u8>,
    carry: Vec<u8>,
}

impl SqlSplitter {
    pub fn new(dialect: Dialect) -> Self {
        Self {
            dialect,
            state: ScanState::Normal,
            buffer: Vec::new(),
            has_code: false,
            dollar_tag: Vec::new(),
            carry: Vec::new(),
        }
    }

    pub fn feed(&mut self, chunk: &[u8], out: &mut Vec<String>) {
        if chunk.is_empty() {
            return;
        }

        let mut data = std::mem::take(&mut self.carry);
        data.extend_from_slice(chunk);
        let consumed = self.scan(&data, false, out);
        if consumed < data.len() {
            self.carry.extend_from_slice(&data[consumed..]);
        }
    }

    pub fn finish(&mut self, out: &mut Vec<String>) {
        let data = std::mem::take(&mut self.carry);
        let consumed = self.scan(&data, true, out);
        debug_assert_eq!(consumed, data.len());
        self.flush_statement(out);
        self.carry.clear();
    }

    fn flush_statement(&mut self, out: &mut Vec<String>) {
        if !self.has_code {
            self.buffer.clear();
            return;
        }
        let text = String::from_utf8_lossy(&self.buffer);
        let statement = text.trim();
        if !statement.is_empty() {
            out.push(statement.to_string());
        }
        self.buffer.clear();
        self.has_code = false;
    }

    fn scan(&mut self, input: &[u8], finalising: bool, out: &mut Vec<String>) -> usize {
        let mut index = 0;

        while index < input.len() {
            let current = input[index];

            match self.state {
                ScanState::Normal => {
                    if current == b'\'' {
                        self.state = ScanState::SingleQuote;
                        self.has_code = true;
                        self.buffer.push(current);
                        index += 1;
                    } else if current == b'"' {
                        self.state = ScanState::DoubleQuote;
                        self.has_code = true;
                        self.buffer.push(current);
                        index += 1;
                    } else if current == b'`' {
                        self.state = ScanState::Backtick;
                        self.has_code = true;
                        self.buffer.push(current);
                        index += 1;
                    } else if self.dialect == Dialect::Mssql && current == b'[' {
                        self.state = ScanState::Bracket;
                        self.has_code = true;
                        self.buffer.push(current);
                        index += 1;
                    } else if current == b'$' && self.dialect == Dialect::Postgres {
                        let previous = self.buffer.last().copied();
                        match dollar_tag_at(input, index, previous) {
                            TagResult::Complete(length) => {
                                self.has_code = true;
                                self.buffer.extend_from_slice(&input[index..index + length]);
                                self.dollar_tag = input[index..index + length].to_vec();
                                self.state = ScanState::Dollar;
                                index += length;
                            }
                            TagResult::Incomplete if !finalising => break,
                            TagResult::Incomplete | TagResult::NotTag => {
                                self.buffer.push(current);
                                index += 1;
                            }
                        }
                    } else if current == b'#'
                        && self.dialect == Dialect::Mysql
                    {
                        self.state = ScanState::LineComment;
                        self.buffer.push(current);
                        index += 1;
                    } else if current == b'-' {
                        if index + 1 >= input.len() {
                            if !finalising {
                                break;
                            }
                            self.buffer.push(current);
                            index += 1;
                        } else if input[index + 1] == b'-' {
                            let is_comment = if self.dialect != Dialect::Mysql {
                                true
                            } else if index + 2 >= input.len() {
                                if !finalising {
                                    break;
                                }
                                // MySQL accepts `--` at end of input as a comment.
                                true
                            } else {
                                input[index + 2].is_ascii_whitespace()
                            };

                            if is_comment {
                                self.state = ScanState::LineComment;
                                self.buffer.extend_from_slice(b"--");
                                index += 2;
                            } else {
                                self.buffer.push(current);
                                index += 1;
                            }
                        } else {
                            self.buffer.push(current);
                            index += 1;
                        }
                    } else if current == b'/' {
                        if index + 1 >= input.len() {
                            if !finalising {
                                break;
                            }
                            self.buffer.push(current);
                            index += 1;
                        } else if input[index + 1] == b'*' {
                            self.state = ScanState::BlockComment;
                            self.buffer.extend_from_slice(b"/*");
                            index += 2;
                        } else {
                            self.buffer.push(current);
                            index += 1;
                        }
                    } else if current == b';' {
                        self.flush_statement(out);
                        index += 1;
                    } else {
                        if !current.is_ascii_whitespace() {
                            self.has_code = true;
                        }
                        self.buffer.push(current);
                        index += 1;
                    }
                }
                ScanState::SingleQuote
                | ScanState::DoubleQuote
                | ScanState::Backtick
                | ScanState::Bracket => {
                    let quote = match self.state {
                        ScanState::SingleQuote => b'\'',
                        ScanState::DoubleQuote => b'"',
                        ScanState::Bracket => b']',
                        _ => b'`',
                    };
                    let backslash_escapes = matches!(
                        self.dialect,
                        Dialect::Mysql | Dialect::Clickhouse
                    );

                    if backslash_escapes && current == b'\\' {
                        if index + 1 >= input.len() {
                            if !finalising {
                                break;
                            }
                            self.buffer.push(current);
                            index += 1;
                        } else {
                            self.buffer.push(current);
                            self.buffer.push(input[index + 1]);
                            index += 2;
                        }
                    } else if current == quote {
                        if index + 1 >= input.len() {
                            if !finalising {
                                break;
                            }
                            self.buffer.push(current);
                            self.state = ScanState::Normal;
                            index += 1;
                        } else if input[index + 1] == quote {
                            self.buffer.push(current);
                            self.buffer.push(quote);
                            index += 2;
                        } else {
                            self.buffer.push(current);
                            self.state = ScanState::Normal;
                            index += 1;
                        }
                    } else {
                        self.buffer.push(current);
                        index += 1;
                    }
                }
                ScanState::Dollar => {
                    let tag = self.dollar_tag.clone();
                    let remaining = &input[index..];
                    if !finalising && remaining.len() < tag.len() && tag.starts_with(remaining)
                    {
                        break;
                    }
                    if remaining.starts_with(&tag) {
                        self.buffer.extend_from_slice(&tag);
                        self.state = ScanState::Normal;
                        index += tag.len();
                    } else {
                        self.buffer.push(current);
                        index += 1;
                    }
                }
                ScanState::LineComment => {
                    self.buffer.push(current);
                    if current == b'\n' {
                        self.state = ScanState::Normal;
                    }
                    index += 1;
                }
                ScanState::BlockComment => {
                    if current == b'*' {
                        if index + 1 >= input.len() {
                            if !finalising {
                                break;
                            }
                            self.buffer.push(current);
                            index += 1;
                        } else if input[index + 1] == b'/' {
                            self.buffer.extend_from_slice(b"*/");
                            self.state = ScanState::Normal;
                            index += 2;
                        } else {
                            self.buffer.push(current);
                            index += 1;
                        }
                    } else {
                        self.buffer.push(current);
                        index += 1;
                    }
                }
            }
        }

        index
    }
}

/// Split a complete SQL string. This is the original `run_query` entry point
/// kept as a thin wrapper around the incremental splitter.
pub fn split_statements(sql: &str, dialect: Dialect) -> Vec<String> {
    let mut splitter = SqlSplitter::new(dialect);
    let mut statements = Vec::new();
    splitter.feed(sql.as_bytes(), &mut statements);
    splitter.finish(&mut statements);
    statements
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatementKind {
    Create,
    Insert,
    Other,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StatementCounts {
    pub create: u64,
    pub insert: u64,
    pub other: u64,
}

impl StatementCounts {
    pub fn add(&mut self, kind: StatementKind) {
        match kind {
            StatementKind::Create => self.create += 1,
            StatementKind::Insert => self.insert += 1,
            StatementKind::Other => self.other += 1,
        }
    }

    pub fn total(&self) -> u64 {
        self.create + self.insert + self.other
    }
}

/// The leading keyword, skipping whitespace and SQL comments. Dumps start with
/// a comment header, so classification must look past it.
pub fn first_keyword(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut index = 0;

    loop {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index + 1 < bytes.len() && bytes[index] == b'-' && bytes[index + 1] == b'-' {
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if index < bytes.len() && bytes[index] == b'#' {
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if index + 1 < bytes.len() && bytes[index] == b'/' && bytes[index + 1] == b'*' {
            index += 2;
            while index + 1 < bytes.len()
                && !(bytes[index] == b'*' && bytes[index + 1] == b'/')
            {
                index += 1;
            }
            index = if index + 1 < bytes.len() {
                index + 2
            } else {
                bytes.len()
            };
            continue;
        }
        break;
    }

    let start = index;
    while index < bytes.len()
        && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
    {
        index += 1;
    }

    String::from_utf8_lossy(&bytes[start..index]).to_ascii_uppercase()
}

pub fn classify_statement(sql: &str) -> StatementKind {
    match first_keyword(sql).as_str() {
        "CREATE" => StatementKind::Create,
        "INSERT" => StatementKind::Insert,
        _ => StatementKind::Other,
    }
}

/// Transaction-control statements from a dump would conflict with the single
/// transaction the restore command opens around PostgreSQL/SQLite dumps.
pub fn is_transaction_control(sql: &str) -> bool {
    matches!(
        first_keyword(sql).as_str(),
        "BEGIN" | "START" | "COMMIT" | "END" | "ROLLBACK" | "SAVEPOINT" | "RELEASE"
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreError {
    pub statement: u64,
    pub sql: String,
    pub message: String,
}

/// Pure bookkeeping for stop-on-error vs continue-and-report. The command layer
/// feeds it the driver outcome; tests pin the two modes and the 100-error cap.
#[derive(Debug, Clone)]
pub struct RestoreStats {
    pub executed: u64,
    pub errors: Vec<RestoreError>,
    pub stop_on_error: bool,
    pub max_errors: usize,
    pub stopped: bool,
}

impl RestoreStats {
    pub fn new(stop_on_error: bool, max_errors: usize) -> Self {
        Self {
            executed: 0,
            errors: Vec::new(),
            stop_on_error,
            max_errors,
            stopped: false,
        }
    }

    pub fn record_success(&mut self) {
        self.executed += 1;
    }

    /// Returns `true` when the caller should keep going, `false` in
    /// stop-on-first-error mode.
    pub fn record_error(&mut self, statement: u64, sql: &str, message: &str) -> bool {
        if self.errors.len() < self.max_errors {
            self.errors.push(RestoreError {
                statement,
                sql: truncate_preview(sql, 200),
                message: message.to_string(),
            });
        }
        if self.stop_on_error {
            self.stopped = true;
            false
        } else {
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_statement, first_keyword, is_gzip, is_transaction_control, split_statements,
        truncate_preview, RestoreStats, SqlSplitter, StatementCounts, StatementKind,
    };
    use crate::core::drivers::Dialect;

    fn split_in_chunks(sql: &str, dialect: Dialect, size: usize) -> Vec<String> {
        let mut splitter = SqlSplitter::new(dialect);
        let mut statements = Vec::new();
        for chunk in sql.as_bytes().chunks(size) {
            splitter.feed(chunk, &mut statements);
        }
        splitter.finish(&mut statements);
        statements
    }

    #[test]
    fn statement_split_across_chunks_is_joined() {
        let parts = split_in_chunks("SELECT 1; SELECT 2;", Dialect::Postgres, 3);
        assert_eq!(parts, vec!["SELECT 1".to_string(), "SELECT 2".to_string()]);
    }

    #[test]
    fn quotes_comments_and_dollar_bodies_survive_chunk_boundaries() {
        let sql = "SELECT 'a;b' AS x; -- line ; comment\nSELECT 2 /* block ; */; \
                   CREATE FUNCTION f() RETURNS trigger AS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$ LANGUAGE plpgsql; \
                   SELECT \"c;d\";";
        let expected = split_statements(sql, Dialect::Postgres);

        for size in [1usize, 2, 3, 7, 16] {
            assert_eq!(
                split_in_chunks(sql, Dialect::Postgres, size),
                expected,
                "chunk size {size}"
            );
        }
        assert_eq!(expected.len(), 4, "{expected:?}");
        assert!(expected[2].contains("RETURN NEW;"));
    }

    #[test]
    fn one_byte_chunks_match_one_big_chunk() {
        let sql = "SELECT 'it''s; ok'; SELECT 2; \
                   SELECT [a;b] FROM t; SELECT `c;d`;";
        let big = split_statements(sql, Dialect::Mssql);
        assert_eq!(split_in_chunks(sql, Dialect::Mssql, 1), big);
        assert_eq!(
            big,
            vec![
                "SELECT 'it''s; ok'".to_string(),
                "SELECT 2".to_string(),
                "SELECT [a;b] FROM t".to_string(),
                "SELECT `c;d`".to_string(),
            ]
        );
    }

    #[test]
    fn mysql_backslash_escape_across_a_chunk_boundary() {
        let sql = "SELECT 'C:\\'; SELECT 2;";
        assert_eq!(
            split_in_chunks(sql, Dialect::Mysql, 1),
            // \' keeps the literal open to EOF, so the last ';' is string content, not a terminator.
            vec!["SELECT 'C:\\'; SELECT 2;".to_string()]
        );
        assert_eq!(
            split_in_chunks(sql, Dialect::Postgres, 1),
            vec!["SELECT 'C:\\'".to_string(), "SELECT 2".to_string()]
        );
    }

    #[test]
    fn gzip_is_detected_from_magic_bytes_not_the_name() {
        assert!(is_gzip(&[0x1f, 0x8b, 0x08, 0x00]));
        assert!(!is_gzip(&[0x1f]));
        assert!(!is_gzip(&[0x1f, 0x00]));
        assert!(!is_gzip(b"CREATE TABLE"));
        assert!(!is_gzip(&[]));
    }

    #[test]
    fn classification_skips_comments_and_counts_create_insert_other() {
        let sql = "-- DataForge dump\n\
                   CREATE TABLE users (id int);\n\
                   /* another comment */ INSERT INTO users VALUES (1);\n\
                   INSERT INTO users VALUES (2);\n\
                   UPDATE users SET id = 3;\n\
                   CREATE INDEX idx_users ON users (id);";
        let mut counts = StatementCounts::default();
        for statement in split_statements(sql, Dialect::Postgres) {
            counts.add(classify_statement(&statement));
        }

        assert_eq!(
            counts,
            StatementCounts {
                create: 2,
                insert: 2,
                other: 1,
            }
        );
        assert_eq!(counts.total(), 5);
        assert_eq!(first_keyword("/* hi */\nCREATE TABLE t (a int)"), "CREATE");
        assert_eq!(
            classify_statement("-- header\nINSERT INTO t VALUES (1)"),
            StatementKind::Insert
        );
    }

    #[test]
    fn transaction_control_statements_are_recognised() {
        for sql in [
            "BEGIN",
            "START TRANSACTION",
            "COMMIT",
            "END",
            "ROLLBACK",
            "SAVEPOINT x",
            "RELEASE SAVEPOINT x",
        ] {
            assert!(is_transaction_control(sql), "{sql}");
        }
        assert!(!is_transaction_control("CREATE TABLE t (a int)"));
        assert!(!is_transaction_control("INSERT INTO t VALUES (1)"));
    }

    #[test]
    fn stop_on_error_stops_but_continue_keeps_the_first_hundred_errors() {
        let mut stopped = RestoreStats::new(true, 100);
        stopped.record_success();
        assert!(!stopped.record_error(2, "BAD SQL", "syntax error"));
        assert!(stopped.stopped);
        assert_eq!(stopped.errors.len(), 1);
        assert_eq!(stopped.executed, 1);

        let mut continued = RestoreStats::new(false, 100);
        for index in 0..150 {
            assert!(continued.record_error(
                index + 1,
                &format!("INSERT {index}"),
                "duplicate key"
            ));
        }
        assert!(!continued.stopped);
        assert_eq!(continued.errors.len(), 100);
        assert_eq!(continued.errors[0].statement, 1);
        assert_eq!(continued.errors[99].statement, 100);
    }

    #[test]
    fn preview_is_truncated_on_a_character_boundary() {
        let text = format!("{}é", "a".repeat(200));
        let preview = truncate_preview(&text, 200);
        assert_eq!(preview.chars().count(), 200);
        assert!(preview.is_char_boundary(preview.len()));
    }
}
