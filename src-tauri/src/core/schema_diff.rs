use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::core::drivers::Dialect;

pub const DIFF_TABLE_LIMIT: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColumnSchema {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default)]
    pub auto_increment: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexSchema {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableSchema {
    pub name: String,
    pub columns: Vec<ColumnSchema>,
    pub indexes: Vec<IndexSchema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pk_constraint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForeignKeySchema {
    pub name: String,
    pub from_table: String,
    pub from_columns: Vec<String>,
    pub to_table: String,
    pub to_columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewSchema {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaData {
    pub database: String,
    pub tables: Vec<TableSchema>,
    pub foreign_keys: Vec<ForeignKeySchema>,
    pub views: Vec<ViewSchema>,
    pub truncated: bool,
}

impl SchemaData {
    pub fn table(&self, name: &str) -> Option<&TableSchema> {
        self.tables.iter().find(|table| table.name == name)
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct DiffSummary {
    pub added_tables: usize,
    pub removed_tables: usize,
    pub changed_tables: usize,
    pub added_columns: usize,
    pub removed_columns: usize,
    pub changed_columns: usize,
    pub added_indexes: usize,
    pub removed_indexes: usize,
    pub added_foreign_keys: usize,
    pub removed_foreign_keys: usize,
    pub added_views: usize,
    pub removed_views: usize,
    pub changed_views: usize,
    pub statements: usize,
    pub destructive: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffStatement {
    pub sql: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    pub destructive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TableDiffItem {
    pub kind: String,
    pub label: String,
    pub destructive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_column: Option<ColumnSchema>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_column: Option<ColumnSchema>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TableDiff {
    pub name: String,
    pub status: String,
    pub items: Vec<TableDiffItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ViewDiff {
    pub name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SchemaDiff {
    pub dialect: String,
    pub source_database: String,
    pub target_database: String,
    pub source_truncated: bool,
    pub target_truncated: bool,
    pub summary: DiffSummary,
    pub tables: Vec<TableDiff>,
    pub views: Vec<ViewDiff>,
    pub statements: Vec<DiffStatement>,
}

#[derive(Default)]
struct StatementPhases {
    create_tables: Vec<DiffStatement>,
    add_columns: Vec<DiffStatement>,
    alter_columns: Vec<DiffStatement>,
    primary_keys: Vec<DiffStatement>,
    add_indexes: Vec<DiffStatement>,
    add_foreign_keys: Vec<DiffStatement>,
    add_views: Vec<DiffStatement>,
    drop_views: Vec<DiffStatement>,
    drop_foreign_keys: Vec<DiffStatement>,
    drop_indexes: Vec<DiffStatement>,
    drop_columns: Vec<DiffStatement>,
    drop_tables: Vec<DiffStatement>,
}

impl StatementPhases {
    fn into_vec(self) -> Vec<DiffStatement> {
        [
            self.create_tables,
            self.add_columns,
            self.alter_columns,
            self.primary_keys,
            self.add_indexes,
            self.add_foreign_keys,
            self.add_views,
            self.drop_views,
            self.drop_foreign_keys,
            self.drop_indexes,
            self.drop_columns,
            self.drop_tables,
        ]
        .into_iter()
        .flatten()
        .collect()
    }
}

fn statement(
    sql: impl Into<String>,
    kind: &str,
    table: Option<&str>,
    destructive: bool,
    reason: Option<String>,
) -> DiffStatement {
    DiffStatement {
        sql: sql.into(),
        kind: kind.to_string(),
        table: table.map(str::to_string),
        destructive,
        reason,
    }
}

fn note(sql: impl Into<String>, table: Option<&str>) -> DiffStatement {
    statement(sql, "note", table, false, None)
}

fn quote(dialect: Dialect, value: &str) -> String {
    match dialect {
        Dialect::Mysql => format!("`{}`", value.replace('`', "``")),
        _ => format!("\"{}\"", value.replace('"', "\"\"")),
    }
}

fn columns_csv(dialect: Dialect, columns: &[String]) -> String {
    columns
        .iter()
        .map(|column| quote(dialect, column))
        .collect::<Vec<_>>()
        .join(", ")
}

fn primary_key_columns(table: &TableSchema) -> Vec<String> {
    table
        .columns
        .iter()
        .filter(|column| column.primary_key)
        .map(|column| column.name.clone())
        .collect()
}

fn normalize(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn normalize_default(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn base_type(data_type: &str) -> String {
    let value = normalize(data_type);
    value
        .split(['(', ' '])
        .next()
        .unwrap_or("")
        .to_string()
}

fn first_length(data_type: &str) -> Option<u32> {
    let open = data_type.find('(')?;
    let rest = &data_type[open + 1..];
    let digits: String = rest.chars().take_while(|character| character.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn precision_scale(data_type: &str) -> Option<(u32, Option<u32>)> {
    let open = data_type.find('(')?;
    let close = data_type[open..].find(')')? + open;
    let inside = &data_type[open + 1..close];
    let mut parts = inside.split(',');
    let precision = parts.next()?.trim().parse().ok()?;
    let scale = parts.next().and_then(|value| value.trim().parse().ok());
    Some((precision, scale))
}

fn integer_rank(dialect: Dialect, data_type: &str) -> Option<u8> {
    let base = base_type(data_type);
    match dialect {
        Dialect::Postgres => match base.as_str() {
            "smallint" | "int2" => Some(2),
            "integer" | "int" | "int4" | "serial" | "serial4" => Some(4),
            "bigint" | "int8" | "bigserial" | "serial8" => Some(8),
            _ => None,
        },
        Dialect::Mysql => match base.as_str() {
            "tinyint" => Some(1),
            "smallint" => Some(2),
            "mediumint" => Some(3),
            "int" | "integer" => Some(4),
            "bigint" => Some(8),
            _ => None,
        },
        Dialect::Sqlite => match base.as_str() {
            "tinyint" => Some(1),
            "smallint" => Some(2),
            "mediumint" => Some(3),
            "int" | "integer" => Some(4),
            "bigint" => Some(8),
            _ => None,
        },
        _ => None,
    }
}

fn text_rank(dialect: Dialect, data_type: &str) -> Option<u8> {
    if dialect != Dialect::Mysql {
        return None;
    }
    match base_type(data_type).as_str() {
        "tinytext" => Some(1),
        "text" => Some(2),
        "mediumtext" => Some(3),
        "longtext" => Some(4),
        "tinyblob" => Some(1),
        "blob" => Some(2),
        "mediumblob" => Some(3),
        "longblob" => Some(4),
        _ => None,
    }
}

fn narrowing_reason(dialect: Dialect, from: &str, to: &str) -> Option<String> {
    if normalize(from) == normalize(to) {
        return None;
    }

    if let (Some(from_rank), Some(to_rank)) = (
        integer_rank(dialect, from),
        integer_rank(dialect, to),
    ) {
        if to_rank < from_rank {
            return Some(format!(
                "Type {from} → {to} narrows the integer range and may truncate existing values."
            ));
        }
    }

    if let (Some(from_length), Some(to_length)) = (first_length(from), first_length(to)) {
        if to_length < from_length {
            return Some(format!(
                "Type {from} → {to} narrows the length and may truncate existing values."
            ));
        }
    }

    if let (Some((from_precision, from_scale)), Some((to_precision, to_scale))) = (
        precision_scale(from),
        precision_scale(to),
    ) {
        if to_precision < from_precision
            || to_scale.unwrap_or(0) < from_scale.unwrap_or(0)
        {
            return Some(format!(
                "Type {from} → {to} narrows numeric precision/scale and may truncate existing values."
            ));
        }
    }

    if let (Some(from_rank), Some(to_rank)) = (text_rank(dialect, from), text_rank(dialect, to)) {
        if to_rank < from_rank {
            return Some(format!(
                "Type {from} → {to} narrows the text/blob size and may truncate existing values."
            ));
        }
    }

    None
}

fn column_definition(dialect: Dialect, column: &ColumnSchema) -> String {
    let mut sql = format!("{} {}", quote(dialect, &column.name), column.data_type.trim());

    match dialect {
        Dialect::Postgres => {
            if column.auto_increment {
                sql.push_str(" GENERATED BY DEFAULT AS IDENTITY");
            } else if let Some(default) = normalize_default(&column.default) {
                sql.push_str(" DEFAULT ");
                sql.push_str(&default);
            }
            if !column.nullable {
                sql.push_str(" NOT NULL");
            }
        }
        Dialect::Mysql => {
            if !column.nullable {
                sql.push_str(" NOT NULL");
            }
            if let Some(default) = normalize_default(&column.default) {
                sql.push_str(" DEFAULT ");
                sql.push_str(&default);
            }
            if column.auto_increment {
                sql.push_str(" AUTO_INCREMENT");
            }
        }
        _ => {
            if !column.nullable {
                sql.push_str(" NOT NULL");
            }
            if let Some(default) = normalize_default(&column.default) {
                sql.push_str(" DEFAULT ");
                sql.push_str(&default);
            }
        }
    }

    sql
}

fn create_table_sql(
    dialect: Dialect,
    table: &TableSchema,
    foreign_keys: &[ForeignKeySchema],
) -> String {
    let mut definitions: Vec<String> = table
        .columns
        .iter()
        .map(|column| column_definition(dialect, column))
        .collect();
    let pk = primary_key_columns(table);

    if dialect == Dialect::Sqlite
        && pk.len() == 1
        && table
            .columns
            .iter()
            .any(|column| column.primary_key && column.auto_increment)
    {
        if let Some(column) = table.columns.iter().find(|column| column.primary_key) {
            let mut definition = format!(
                "{} {} PRIMARY KEY AUTOINCREMENT",
                quote(dialect, &column.name),
                column.data_type.trim()
            );
            if !column.nullable {
                definition.push_str(" NOT NULL");
            }
            if let Some(default) = normalize_default(&column.default) {
                definition.push_str(" DEFAULT ");
                definition.push_str(&default);
            }
            definitions = table
                .columns
                .iter()
                .map(|item| {
                    if item.name == column.name {
                        definition.clone()
                    } else {
                        column_definition(dialect, item)
                    }
                })
                .collect();
        }
    } else if !pk.is_empty() {
        definitions.push(format!(
            "PRIMARY KEY ({})",
            columns_csv(dialect, &pk)
        ));
    }

    if dialect == Dialect::Sqlite {
        for fk in foreign_keys
            .iter()
            .filter(|fk| fk.from_table == table.name)
        {
            definitions.push(format!(
                "FOREIGN KEY ({}) REFERENCES {} ({})",
                columns_csv(dialect, &fk.from_columns),
                quote(dialect, &fk.to_table),
                columns_csv(dialect, &fk.to_columns)
            ));
        }
    }

    format!(
        "CREATE TABLE {} (\n  {}\n)",
        quote(dialect, &table.name),
        definitions.join(",\n  ")
    )
}

fn drop_index_sql(dialect: Dialect, table: &str, index: &str) -> String {
    match dialect {
        Dialect::Mysql => format!(
            "DROP INDEX {} ON {}",
            quote(dialect, index),
            quote(dialect, table)
        ),
        _ => format!("DROP INDEX {}", quote(dialect, index)),
    }
}

fn add_index_sql(dialect: Dialect, table: &str, index: &IndexSchema) -> String {
    format!(
        "CREATE {}INDEX {} ON {} ({})",
        if index.unique { "UNIQUE " } else { "" },
        quote(dialect, &index.name),
        quote(dialect, table),
        columns_csv(dialect, &index.columns)
    )
}

fn add_foreign_key_sql(dialect: Dialect, fk: &ForeignKeySchema) -> String {
    format!(
        "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
        quote(dialect, &fk.from_table),
        quote(dialect, &fk.name),
        columns_csv(dialect, &fk.from_columns),
        quote(dialect, &fk.to_table),
        columns_csv(dialect, &fk.to_columns)
    )
}

fn drop_foreign_key_sql(dialect: Dialect, fk: &ForeignKeySchema) -> String {
    match dialect {
        Dialect::Mysql => format!(
            "ALTER TABLE {} DROP FOREIGN KEY {}",
            quote(dialect, &fk.from_table),
            quote(dialect, &fk.name)
        ),
        _ => format!(
            "ALTER TABLE {} DROP CONSTRAINT {}",
            quote(dialect, &fk.from_table),
            quote(dialect, &fk.name)
        ),
    }
}

fn fk_signature(fk: &ForeignKeySchema) -> String {
    format!(
        "{}\u{0}{}\u{0}{}\u{0}{}",
        fk.from_table,
        fk.from_columns.join("\u{1}"),
        fk.to_table,
        fk.to_columns.join("\u{1}")
    )
}

fn index_signature(index: &IndexSchema) -> String {
    format!(
        "{}\u{0}{}\u{0}{}",
        index.name,
        index.unique,
        index.columns.join("\u{1}")
    )
}

fn push_item(table: &mut TableDiff, item: TableDiffItem) {
    table.items.push(item);
    if table.status != "added" && table.status != "removed" {
        table.status = "changed".to_string();
    }
}

fn column_changes(source: &ColumnSchema, target: &ColumnSchema) -> Vec<String> {
    let mut changes = Vec::new();
    if normalize(&source.data_type) != normalize(&target.data_type) {
        changes.push(format!(
            "type: {} → {}",
            target.data_type, source.data_type
        ));
    }
    if source.nullable != target.nullable {
        changes.push(format!(
            "nullable: {} → {}",
            if target.nullable { "NULL" } else { "NOT NULL" },
            if source.nullable { "NULL" } else { "NOT NULL" }
        ));
    }
    if normalize_default(&source.default) != normalize_default(&target.default) {
        changes.push(format!(
            "default: {} → {}",
            target.default.as_deref().unwrap_or("none"),
            source.default.as_deref().unwrap_or("none")
        ));
    }
    if source.auto_increment != target.auto_increment {
        changes.push(format!(
            "auto increment: {} → {}",
            target.auto_increment, source.auto_increment
        ));
    }
    changes
}

fn sqlite_rebuild_note(table: &str, detail: &str) -> DiffStatement {
    note(
        format!(
            "-- requires table rebuild: {table} {detail} (SQLite cannot do this in place)"
        ),
        Some(table),
    )
}

pub fn diff_schemas(dialect: Dialect, source: &SchemaData, target: &SchemaData) -> SchemaDiff {
    let mut tables: BTreeMap<String, TableDiff> = BTreeMap::new();
    let mut phases = StatementPhases::default();

    let source_names: HashSet<String> =
        source.tables.iter().map(|table| table.name.clone()).collect();
    let target_names: HashSet<String> =
        target.tables.iter().map(|table| table.name.clone()).collect();

    for source_table in &source.tables {
        if !target_names.contains(source_table.name.as_str()) {
            let create_sql = create_table_sql(dialect, source_table, &source.foreign_keys);
            let mut diff = TableDiff {
                name: source_table.name.clone(),
                status: "added".to_string(),
                items: Vec::new(),
            };
            push_item(
                &mut diff,
                TableDiffItem {
                    kind: "table_added".to_string(),
                    label: format!("+ table {}", source_table.name),
                    destructive: false,
                    reason: None,
                    before: None,
                    after: Some(create_sql.clone()),
                    before_column: None,
                    after_column: None,
                    changes: Vec::new(),
                },
            );
            phases.create_tables.push(statement(
                create_sql,
                "create_table",
                Some(&source_table.name),
                false,
                None,
            ));
            for index in &source_table.indexes {
                push_item(
                    &mut diff,
                    TableDiffItem {
                        kind: "index_added".to_string(),
                        label: format!(
                            "+ index {} ({})",
                            index.name,
                            index.columns.join(", ")
                        ),
                        destructive: false,
                        reason: None,
                        before: None,
                        after: Some(add_index_sql(dialect, &source_table.name, index)),
                        before_column: None,
                        after_column: None,
                        changes: Vec::new(),
                    },
                );
                phases.add_indexes.push(statement(
                    add_index_sql(dialect, &source_table.name, index),
                    "add_index",
                    Some(&source_table.name),
                    false,
                    None,
                ));
            }
            tables.insert(source_table.name.clone(), diff);
            continue;
        }

        let target_table = target
            .table(&source_table.name)
            .expect("target table was checked above");
        let mut diff = TableDiff {
            name: source_table.name.clone(),
            status: "same".to_string(),
            items: Vec::new(),
        };

        let source_columns: HashMap<&str, &ColumnSchema> = source_table
            .columns
            .iter()
            .map(|column| (column.name.as_str(), column))
            .collect();
        let target_columns: HashMap<&str, &ColumnSchema> = target_table
            .columns
            .iter()
            .map(|column| (column.name.as_str(), column))
            .collect();

        for column in &source_table.columns {
            if target_columns.contains_key(column.name.as_str()) {
                continue;
            }

            push_item(
                &mut diff,
                TableDiffItem {
                    kind: "column_added".to_string(),
                    label: format!("+ column {} {}", column.name, column.data_type),
                    destructive: false,
                    reason: None,
                    before: None,
                    after: Some(column_definition(dialect, column)),
                    before_column: None,
                    after_column: Some(column.clone()),
                    changes: Vec::new(),
                },
            );

            if dialect == Dialect::Sqlite
                && !column.nullable
                && normalize_default(&column.default).is_none()
            {
                phases.add_columns.push(sqlite_rebuild_note(
                    &source_table.name,
                    &format!(
                        "cannot add NOT NULL column {} without a default",
                        quote(dialect, &column.name)
                    ),
                ));
            } else if dialect == Dialect::Sqlite && column.primary_key {
                phases.add_columns.push(sqlite_rebuild_note(
                    &source_table.name,
                    &format!(
                        "cannot add primary-key column {} with ALTER TABLE",
                        quote(dialect, &column.name)
                    ),
                ));
            } else {
                phases.add_columns.push(statement(
                    format!(
                        "ALTER TABLE {} ADD COLUMN {}",
                        quote(dialect, &source_table.name),
                        column_definition(dialect, column)
                    ),
                    "add_column",
                    Some(&source_table.name),
                    false,
                    None,
                ));
            }
        }

        for column in &target_table.columns {
            if source_columns.contains_key(column.name.as_str()) {
                continue;
            }

            let destructive = true;
            let reason = format!(
                "Dropping column {}.{} deletes its data.",
                source_table.name, column.name
            );
            push_item(
                &mut diff,
                TableDiffItem {
                    kind: "column_removed".to_string(),
                    label: format!("− column {} {}", column.name, column.data_type),
                    destructive,
                    reason: Some(reason.clone()),
                    before: Some(column_definition(dialect, column)),
                    after: None,
                    before_column: Some(column.clone()),
                    after_column: None,
                    changes: Vec::new(),
                },
            );

            if dialect == Dialect::Sqlite
                && primary_key_columns(target_table).contains(&column.name)
            {
                phases.drop_columns.push(sqlite_rebuild_note(
                    &source_table.name,
                    &format!(
                        "cannot drop primary-key column {} with ALTER TABLE",
                        quote(dialect, &column.name)
                    ),
                ));
            } else {
                phases.drop_columns.push(statement(
                    format!(
                        "ALTER TABLE {} DROP COLUMN {}",
                        quote(dialect, &source_table.name),
                        quote(dialect, &column.name)
                    ),
                    "drop_column",
                    Some(&source_table.name),
                    true,
                    Some(reason),
                ));
            }
        }

        for column in &source_table.columns {
            let Some(target_column) = target_columns.get(column.name.as_str()) else {
                continue;
            };
            let changes = column_changes(column, target_column);
            if changes.is_empty() {
                continue;
            }

            let narrowing = narrowing_reason(
                dialect,
                &target_column.data_type,
                &column.data_type,
            );
            let not_null = target_column.nullable && !column.nullable;
            let destructive = narrowing.is_some() || not_null;
            let reason = match (narrowing, not_null) {
                (Some(narrow), true) => Some(format!(
                    "{narrow} Setting NOT NULL on a nullable column can also fail for existing NULL rows."
                )),
                (Some(narrow), false) => Some(narrow),
                (None, true) => Some(format!(
                    "Setting NOT NULL on nullable column {}.{} can fail for existing NULL rows.",
                    source_table.name, column.name
                )),
                (None, false) => None,
            };

            push_item(
                &mut diff,
                TableDiffItem {
                    kind: "column_changed".to_string(),
                    label: format!("~ column {}", column.name),
                    destructive,
                    reason: reason.clone(),
                    before: Some(column_definition(dialect, target_column)),
                    after: Some(column_definition(dialect, column)),
                    before_column: Some((**target_column).clone()),
                    after_column: Some(column.clone()),
                    changes,
                },
            );

            match dialect {
                Dialect::Postgres => {
                    let mut clauses = Vec::new();
                    if normalize(&target_column.data_type) != normalize(&column.data_type) {
                        clauses.push(format!(
                            "ALTER COLUMN {} TYPE {}",
                            quote(dialect, &column.name),
                            column.data_type.trim()
                        ));
                    }
                    if target_column.auto_increment != column.auto_increment {
                        if column.auto_increment {
                            clauses.push(format!(
                                "ALTER COLUMN {} ADD GENERATED BY DEFAULT AS IDENTITY",
                                quote(dialect, &column.name)
                            ));
                        } else {
                            clauses.push(format!(
                                "ALTER COLUMN {} DROP IDENTITY",
                                quote(dialect, &column.name)
                            ));
                        }
                    }
                    if target_column.nullable != column.nullable {
                        clauses.push(format!(
                            "ALTER COLUMN {} {} NOT NULL",
                            quote(dialect, &column.name),
                            if column.nullable { "DROP" } else { "SET" }
                        ));
                    }
                    if normalize_default(&target_column.default)
                        != normalize_default(&column.default)
                        && !column.auto_increment
                    {
                        clauses.push(match normalize_default(&column.default) {
                            Some(default) => format!(
                                "ALTER COLUMN {} SET DEFAULT {}",
                                quote(dialect, &column.name),
                                default
                            ),
                            None => format!(
                                "ALTER COLUMN {} DROP DEFAULT",
                                quote(dialect, &column.name)
                            ),
                        });
                    }
                    if !clauses.is_empty() {
                        phases.alter_columns.push(statement(
                            format!(
                                "ALTER TABLE {} {}",
                                quote(dialect, &source_table.name),
                                clauses.join(", ")
                            ),
                            "alter_column",
                            Some(&source_table.name),
                            destructive,
                            reason,
                        ));
                    }
                }
                Dialect::Mysql => {
                    phases.alter_columns.push(statement(
                        format!(
                            "ALTER TABLE {} MODIFY COLUMN {}",
                            quote(dialect, &source_table.name),
                            column_definition(dialect, column)
                        ),
                        "alter_column",
                        Some(&source_table.name),
                        destructive,
                        reason,
                    ));
                }
                Dialect::Sqlite => {
                    phases.alter_columns.push(sqlite_rebuild_note(
                        &source_table.name,
                        &format!(
                            "column {} needs a type/NULL/DEFAULT change",
                            quote(dialect, &column.name)
                        ),
                    ));
                }
                _ => {}
            }
        }

        let source_pk = primary_key_columns(source_table);
        let target_pk = primary_key_columns(target_table);
        if source_pk != target_pk {
            let before = if target_pk.is_empty() {
                None
            } else {
                Some(format!("({})", target_pk.join(", ")))
            };
            let after = if source_pk.is_empty() {
                None
            } else {
                Some(format!("({})", source_pk.join(", ")))
            };
            let destructive = !target_pk.is_empty();
            let reason = destructive.then(|| {
                format!(
                    "Changing the primary key of {} drops the existing primary key constraint.",
                    source_table.name
                )
            });
            push_item(
                &mut diff,
                TableDiffItem {
                    kind: "primary_key_changed".to_string(),
                    label: "~ primary key".to_string(),
                    destructive,
                    reason: reason.clone(),
                    before,
                    after,
                    before_column: None,
                    after_column: None,
                    changes: vec![format!(
                        "{} → {}",
                        if target_pk.is_empty() {
                            "none".to_string()
                        } else {
                            target_pk.join(", ")
                        },
                        if source_pk.is_empty() {
                            "none".to_string()
                        } else {
                            source_pk.join(", ")
                        }
                    )],
                },
            );

            if dialect == Dialect::Sqlite {
                phases.primary_keys.push(sqlite_rebuild_note(
                    &source_table.name,
                    "primary key change",
                ));
            } else {
                if !target_pk.is_empty() {
                    let pk_name = target_table
                        .pk_constraint
                        .clone()
                        .unwrap_or_else(|| format!("{}_pkey", target_table.name));
                    let drop = match dialect {
                        Dialect::Postgres => format!(
                            "ALTER TABLE {} DROP CONSTRAINT {}",
                            quote(dialect, &source_table.name),
                            quote(dialect, &pk_name)
                        ),
                        _ => format!(
                            "ALTER TABLE {} DROP PRIMARY KEY",
                            quote(dialect, &source_table.name)
                        ),
                    };
                    phases.primary_keys.push(statement(
                        drop,
                        "drop_primary_key",
                        Some(&source_table.name),
                        true,
                        reason.clone(),
                    ));
                }
                if !source_pk.is_empty() {
                    phases.primary_keys.push(statement(
                        format!(
                            "ALTER TABLE {} ADD PRIMARY KEY ({})",
                            quote(dialect, &source_table.name),
                            columns_csv(dialect, &source_pk)
                        ),
                        "add_primary_key",
                        Some(&source_table.name),
                        false,
                        None,
                    ));
                }
            }
        }

        let source_indexes: HashMap<&str, &IndexSchema> = source_table
            .indexes
            .iter()
            .map(|index| (index.name.as_str(), index))
            .collect();
        let target_indexes: HashMap<&str, &IndexSchema> = target_table
            .indexes
            .iter()
            .map(|index| (index.name.as_str(), index))
            .collect();

        for index in &source_table.indexes {
            match target_indexes.get(index.name.as_str()) {
                None => {
                    push_item(
                        &mut diff,
                        TableDiffItem {
                            kind: "index_added".to_string(),
                            label: format!("+ index {} ({})", index.name, index.columns.join(", ")),
                            destructive: false,
                            reason: None,
                            before: None,
                            after: Some(add_index_sql(dialect, &source_table.name, index)),
                            before_column: None,
                            after_column: None,
                            changes: Vec::new(),
                        },
                    );
                    phases.add_indexes.push(statement(
                        add_index_sql(dialect, &source_table.name, index),
                        "add_index",
                        Some(&source_table.name),
                        false,
                        None,
                    ));
                }
                Some(target_index) => {
                    if index_signature(index) != index_signature(target_index) {
                        push_item(
                            &mut diff,
                            TableDiffItem {
                                kind: "index_removed".to_string(),
                                label: format!("− index {}", index.name),
                                destructive: false,
                                reason: None,
                                before: Some(add_index_sql(
                                    dialect,
                                    &source_table.name,
                                    target_index,
                                )),
                                after: None,
                                before_column: None,
                                after_column: None,
                                changes: Vec::new(),
                            },
                        );
                        push_item(
                            &mut diff,
                            TableDiffItem {
                                kind: "index_added".to_string(),
                                label: format!(
                                    "+ index {} ({})",
                                    index.name,
                                    index.columns.join(", ")
                                ),
                                destructive: false,
                                reason: None,
                                before: None,
                                after: Some(add_index_sql(
                                    dialect,
                                    &source_table.name,
                                    index,
                                )),
                                before_column: None,
                                after_column: None,
                                changes: Vec::new(),
                            },
                        );
                        phases.add_indexes.push(statement(
                            drop_index_sql(dialect, &source_table.name, &index.name),
                            "drop_index",
                            Some(&source_table.name),
                            false,
                            None,
                        ));
                        phases.add_indexes.push(statement(
                            add_index_sql(dialect, &source_table.name, index),
                            "add_index",
                            Some(&source_table.name),
                            false,
                            None,
                        ));
                    }
                }
            }
        }

        for index in &target_table.indexes {
            if source_indexes.contains_key(index.name.as_str()) {
                continue;
            }
            push_item(
                &mut diff,
                TableDiffItem {
                    kind: "index_removed".to_string(),
                    label: format!("− index {}", index.name),
                    destructive: false,
                    reason: None,
                    before: Some(add_index_sql(dialect, &source_table.name, index)),
                    after: None,
                    before_column: None,
                    after_column: None,
                    changes: Vec::new(),
                },
            );
            phases.drop_indexes.push(statement(
                drop_index_sql(dialect, &source_table.name, &index.name),
                "drop_index",
                Some(&source_table.name),
                false,
                None,
            ));
        }

        tables.insert(source_table.name.clone(), diff);
    }

    for target_table in &target.tables {
        if source_names.contains(target_table.name.as_str()) {
            continue;
        }
        let mut diff = TableDiff {
            name: target_table.name.clone(),
            status: "removed".to_string(),
            items: Vec::new(),
        };
        let reason = format!(
            "Dropping table {} deletes all of its rows.",
            target_table.name
        );
        push_item(
            &mut diff,
            TableDiffItem {
                kind: "table_removed".to_string(),
                label: format!("− table {}", target_table.name),
                destructive: true,
                reason: Some(reason.clone()),
                before: Some(format!(
                    "{} columns",
                    target_table.columns.len()
                )),
                after: None,
                before_column: None,
                after_column: None,
                changes: Vec::new(),
            },
        );
        phases.drop_tables.push(statement(
            format!("DROP TABLE {}", quote(dialect, &target_table.name)),
            "drop_table",
            Some(&target_table.name),
            true,
            Some(reason),
        ));
        tables.insert(target_table.name.clone(), diff);
    }

    compare_foreign_keys(
        dialect,
        source,
        target,
        &source_names,
        &target_names,
        &mut tables,
        &mut phases,
    );
    let views = compare_views(dialect, source, target, &mut phases);

    let statements = phases.into_vec();
    let table_list: Vec<TableDiff> = tables
        .into_values()
        .filter(|table| !table.items.is_empty())
        .collect();

    let mut summary = DiffSummary {
        statements: statements.len(),
        destructive: statements.iter().filter(|item| item.destructive).count(),
        ..DiffSummary::default()
    };
    for table in &table_list {
        if table.status == "added" {
            summary.added_tables += 1;
        } else if table.status == "removed" {
            summary.removed_tables += 1;
        } else if table.status == "changed" {
            summary.changed_tables += 1;
        }
        for item in &table.items {
            match item.kind.as_str() {
                "column_added" => summary.added_columns += 1,
                "column_removed" => summary.removed_columns += 1,
                "column_changed" => summary.changed_columns += 1,
                "index_added" => summary.added_indexes += 1,
                "index_removed" => summary.removed_indexes += 1,
                "foreign_key_added" => summary.added_foreign_keys += 1,
                "foreign_key_removed" => summary.removed_foreign_keys += 1,
                _ => {}
            }
        }
    }
    for view in &views {
        match view.status.as_str() {
            "added" => summary.added_views += 1,
            "removed" => summary.removed_views += 1,
            "changed" => summary.changed_views += 1,
            _ => {}
        }
    }

    SchemaDiff {
        dialect: dialect.as_str().to_string(),
        source_database: source.database.clone(),
        target_database: target.database.clone(),
        source_truncated: source.truncated,
        target_truncated: target.truncated,
        summary,
        tables: table_list,
        views,
        statements,
    }
}

fn compare_foreign_keys(
    dialect: Dialect,
    source: &SchemaData,
    target: &SchemaData,
    source_names: &HashSet<String>,
    target_names: &HashSet<String>,
    tables: &mut BTreeMap<String, TableDiff>,
    phases: &mut StatementPhases,
) {
    let target_by_signature: HashMap<String, &ForeignKeySchema> = target
        .foreign_keys
        .iter()
        .map(|fk| (fk_signature(fk), fk))
        .collect();
    let target_by_name: HashMap<&str, &ForeignKeySchema> = target
        .foreign_keys
        .iter()
        .map(|fk| (fk.name.as_str(), fk))
        .collect();
    let source_by_signature: HashSet<String> = source
        .foreign_keys
        .iter()
        .map(fk_signature)
        .collect();
    let mut matched_target_names: HashSet<String> = HashSet::new();

    for source_fk in &source.foreign_keys {
        if !source_names.contains(source_fk.from_table.as_str())
            || !source_names.contains(source_fk.to_table.as_str())
        {
            continue;
        }
        if dialect == Dialect::Sqlite
            && !target_names.contains(source_fk.from_table.as_str())
        {
            continue;
        }
        let signature = fk_signature(source_fk);
        if let Some(target_fk) = target_by_signature.get(&signature) {
            matched_target_names.insert(target_fk.name.clone());
            continue;
        }

        let rebuild = target_by_name
            .get(source_fk.name.as_str())
            .filter(|target_fk| fk_signature(target_fk) != signature)
            .copied();

        let table = tables.entry(source_fk.from_table.clone()).or_insert_with(|| TableDiff {
            name: source_fk.from_table.clone(),
            status: "same".to_string(),
            items: Vec::new(),
        });

        if let Some(target_fk) = rebuild {
            matched_target_names.insert(target_fk.name.clone());
            push_item(
                table,
                TableDiffItem {
                    kind: "foreign_key_removed".to_string(),
                    label: format!("− foreign key {}", target_fk.name),
                    destructive: false,
                    reason: None,
                    before: Some(drop_foreign_key_sql(dialect, target_fk)),
                    after: None,
                    before_column: None,
                    after_column: None,
                    changes: Vec::new(),
                },
            );
            push_item(
                table,
                TableDiffItem {
                    kind: "foreign_key_added".to_string(),
                    label: format!(
                        "+ foreign key {} ({}) → {}",
                        source_fk.name,
                        source_fk.from_columns.join(", "),
                        source_fk.to_table
                    ),
                    destructive: false,
                    reason: None,
                    before: None,
                    after: Some(add_foreign_key_sql(dialect, source_fk)),
                    before_column: None,
                    after_column: None,
                    changes: Vec::new(),
                },
            );

            if dialect == Dialect::Sqlite {
                phases.add_foreign_keys.push(sqlite_rebuild_note(
                    &source_fk.from_table,
                    "foreign key change",
                ));
            } else {
                phases.add_foreign_keys.push(statement(
                    drop_foreign_key_sql(dialect, target_fk),
                    "drop_foreign_key",
                    Some(&target_fk.from_table),
                    false,
                    None,
                ));
                phases.add_foreign_keys.push(statement(
                    add_foreign_key_sql(dialect, source_fk),
                    "add_foreign_key",
                    Some(&source_fk.from_table),
                    false,
                    None,
                ));
            }
            continue;
        }

        push_item(
            table,
            TableDiffItem {
                kind: "foreign_key_added".to_string(),
                label: format!(
                    "+ foreign key {} ({}) → {}",
                    source_fk.name,
                    source_fk.from_columns.join(", "),
                    source_fk.to_table
                ),
                destructive: false,
                reason: None,
                before: None,
                after: Some(add_foreign_key_sql(dialect, source_fk)),
                before_column: None,
                after_column: None,
                changes: Vec::new(),
            },
        );

        if dialect == Dialect::Sqlite {
            phases.add_foreign_keys.push(sqlite_rebuild_note(
                &source_fk.from_table,
                &format!(
                    "cannot add foreign key {} with ALTER TABLE",
                    quote(dialect, &source_fk.name)
                ),
            ));
        } else {
            phases.add_foreign_keys.push(statement(
                add_foreign_key_sql(dialect, source_fk),
                "add_foreign_key",
                Some(&source_fk.from_table),
                false,
                None,
            ));
        }
    }

    for target_fk in &target.foreign_keys {
        if !target_names.contains(target_fk.from_table.as_str()) {
            continue;
        }
        if source_by_signature.contains(&fk_signature(target_fk))
            || matched_target_names.contains(&target_fk.name)
        {
            continue;
        }
        if !source_names.contains(target_fk.from_table.as_str()) {
            continue;
        }

        let table = tables.entry(target_fk.from_table.clone()).or_insert_with(|| TableDiff {
            name: target_fk.from_table.clone(),
            status: "same".to_string(),
            items: Vec::new(),
        });
        push_item(
            table,
            TableDiffItem {
                kind: "foreign_key_removed".to_string(),
                label: format!("− foreign key {}", target_fk.name),
                destructive: false,
                reason: None,
                before: Some(drop_foreign_key_sql(dialect, target_fk)),
                after: None,
                before_column: None,
                after_column: None,
                changes: Vec::new(),
            },
        );

        if dialect == Dialect::Sqlite {
            phases.drop_foreign_keys.push(sqlite_rebuild_note(
                &target_fk.from_table,
                &format!(
                    "cannot drop foreign key {} with ALTER TABLE",
                    quote(dialect, &target_fk.name)
                ),
            ));
        } else {
            phases.drop_foreign_keys.push(statement(
                drop_foreign_key_sql(dialect, target_fk),
                "drop_foreign_key",
                Some(&target_fk.from_table),
                false,
                None,
            ));
        }
    }
}

fn compare_views(
    dialect: Dialect,
    source: &SchemaData,
    target: &SchemaData,
    phases: &mut StatementPhases,
) -> Vec<ViewDiff> {
    let mut result = Vec::new();
    let target_by_name: HashMap<&str, &ViewSchema> = target
        .views
        .iter()
        .map(|view| (view.name.as_str(), view))
        .collect();
    let source_names: HashSet<String> =
        source.views.iter().map(|view| view.name.clone()).collect();

    for view in &source.views {
        match target_by_name.get(view.name.as_str()) {
            None => {
                result.push(ViewDiff {
                    name: view.name.clone(),
                    status: "added".to_string(),
                    definition: view.definition.clone(),
                });
                match view.definition.as_deref() {
                    Some(definition) if !definition.trim().is_empty() => {
                        phases.add_views.push(statement(
                            format!(
                                "CREATE VIEW {} AS {}",
                                quote(dialect, &view.name),
                                definition.trim().trim_end_matches(';')
                            ),
                            "create_view",
                            None,
                            false,
                            None,
                        ));
                    }
                    _ => phases.add_views.push(note(
                        format!(
                            "-- view definition unavailable: {} (create it manually)",
                            quote(dialect, &view.name)
                        ),
                        None,
                    )),
                }
            }
            Some(target_view) => {
                let source_definition = normalize_default(&view.definition);
                let target_definition = normalize_default(&target_view.definition);
                if source_definition != target_definition {
                    result.push(ViewDiff {
                        name: view.name.clone(),
                        status: "changed".to_string(),
                        definition: view.definition.clone(),
                    });
                    let Some(definition) = source_definition else {
                        phases.add_views.push(note(
                            format!(
                                "-- view definition unavailable: {} (update it manually)",
                                quote(dialect, &view.name)
                            ),
                            None,
                        ));
                        continue;
                    };
                    if dialect == Dialect::Sqlite {
                        phases.add_views.push(statement(
                            format!("DROP VIEW {}", quote(dialect, &view.name)),
                            "drop_view",
                            None,
                            false,
                            None,
                        ));
                        phases.add_views.push(statement(
                            format!(
                                "CREATE VIEW {} AS {}",
                                quote(dialect, &view.name),
                                definition.trim_end_matches(';')
                            ),
                            "create_view",
                            None,
                            false,
                            None,
                        ));
                    } else {
                        phases.add_views.push(statement(
                            format!(
                                "CREATE OR REPLACE VIEW {} AS {}",
                                quote(dialect, &view.name),
                                definition.trim_end_matches(';')
                            ),
                            "create_view",
                            None,
                            false,
                            None,
                        ));
                    }
                }
            }
        }
    }

    for view in &target.views {
        if source_names.contains(view.name.as_str()) {
            continue;
        }
        result.push(ViewDiff {
            name: view.name.clone(),
            status: "removed".to_string(),
            definition: view.definition.clone(),
        });
        phases.drop_views.push(statement(
            format!("DROP VIEW {}", quote(dialect, &view.name)),
            "drop_view",
            None,
            false,
            None,
        ));
    }

    result
}

#[cfg(test)]
mod tests {
    use super::{
        diff_schemas, ColumnSchema, ForeignKeySchema, IndexSchema, SchemaData, TableSchema,
        ViewSchema,
    };
    use crate::core::drivers::Dialect;

    fn column(name: &str, data_type: &str, nullable: bool, primary_key: bool) -> ColumnSchema {
        ColumnSchema {
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable,
            primary_key,
            default: None,
            auto_increment: false,
        }
    }

    fn table(name: &str, columns: Vec<ColumnSchema>) -> TableSchema {
        TableSchema {
            name: name.to_string(),
            columns,
            indexes: Vec::new(),
            pk_constraint: None,
        }
    }

    fn schema(tables: Vec<TableSchema>) -> SchemaData {
        SchemaData {
            database: "db".to_string(),
            tables,
            foreign_keys: Vec::new(),
            views: Vec::new(),
            truncated: false,
        }
    }

    fn kinds(diff: &super::SchemaDiff) -> Vec<&str> {
        diff.statements
            .iter()
            .map(|statement| statement.kind.as_str())
            .collect()
    }

    #[test]
    fn added_table_generates_create_table() {
        let source = schema(vec![table(
            "users",
            vec![
                column("id", "integer", false, true),
                column("name", "text", false, false),
            ],
        )]);
        let target = schema(Vec::new());

        let diff = diff_schemas(Dialect::Postgres, &source, &target);

        assert_eq!(diff.summary.added_tables, 1);
        assert_eq!(kinds(&diff), vec!["create_table"]);
        assert!(diff.statements[0].sql.contains("CREATE TABLE \"users\""));
        assert!(diff.statements[0].sql.contains("PRIMARY KEY (\"id\")"));
        assert!(!diff.statements[0].destructive);
    }

    #[test]
    fn dropped_column_is_destructive() {
        let source = schema(vec![table(
            "users",
            vec![column("id", "integer", false, true)],
        )]);
        let target = schema(vec![table(
            "users",
            vec![
                column("id", "integer", false, true),
                column("legacy", "text", true, false),
            ],
        )]);

        let diff = diff_schemas(Dialect::Postgres, &source, &target);

        assert_eq!(diff.summary.removed_columns, 1);
        assert_eq!(diff.tables[0].items[0].kind, "column_removed");
        assert!(diff.tables[0].items[0].destructive);
        assert_eq!(kinds(&diff), vec!["drop_column"]);
        assert!(diff.statements[0].destructive);
        assert!(diff.statements[0]
            .sql
            .contains("DROP COLUMN \"legacy\""));
        assert!(diff.statements[0].reason.as_deref().unwrap_or("").contains("deletes"));
    }

    #[test]
    fn mysql_modify_column_keeps_auto_increment_and_default() {
        let mut source_id = column("id", "int", false, true);
        source_id.auto_increment = true;
        let mut target_id = column("id", "bigint", false, true);
        target_id.auto_increment = true;

        let mut source_name = column("name", "varchar(10)", true, false);
        source_name.default = Some("'x'".to_string());
        let mut target_name = column("name", "varchar(255)", true, false);
        target_name.default = Some("'y'".to_string());

        let source = schema(vec![table("users", vec![source_id, source_name])]);
        let target = schema(vec![table("users", vec![target_id, target_name])]);

        let diff = diff_schemas(Dialect::Mysql, &source, &target);

        let alter_id = diff
            .statements
            .iter()
            .find(|statement| statement.sql.contains("MODIFY COLUMN `id`"))
            .expect("id modify statement");
        assert!(alter_id.sql.contains("INT NOT NULL AUTO_INCREMENT"));
        assert!(alter_id.destructive);
        assert!(alter_id
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("narrows"));

        let alter_name = diff
            .statements
            .iter()
            .find(|statement| statement.sql.contains("MODIFY COLUMN `name`"))
            .expect("name modify statement");
        assert!(alter_name.sql.contains("DEFAULT 'x'"));
        assert!(alter_name.destructive);
    }

    #[test]
    fn nullable_to_not_null_is_destructive() {
        let source = schema(vec![table(
            "users",
            vec![column("email", "text", false, false)],
        )]);
        let target = schema(vec![table(
            "users",
            vec![column("email", "text", true, false)],
        )]);

        let diff = diff_schemas(Dialect::Postgres, &source, &target);

        assert_eq!(diff.summary.changed_columns, 1);
        assert!(diff.tables[0].items[0].destructive);
        assert!(diff.tables[0].items[0]
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("NOT NULL"));
        assert_eq!(kinds(&diff), vec!["alter_column"]);
        assert!(diff.statements[0].sql.contains("SET NOT NULL"));
        assert!(diff.statements[0].destructive);
    }

    #[test]
    fn postgres_type_change_generates_alter_column_type() {
        let source = schema(vec![table(
            "users",
            vec![column("name", "varchar(50)", true, false)],
        )]);
        let target = schema(vec![table(
            "users",
            vec![column("name", "varchar(255)", true, false)],
        )]);

        let diff = diff_schemas(Dialect::Postgres, &source, &target);

        assert_eq!(diff.summary.changed_columns, 1);
        assert_eq!(kinds(&diff), vec!["alter_column"]);
        assert!(diff.statements[0]
            .sql
            .contains("ALTER COLUMN \"name\" TYPE varchar(50)"));
        assert!(diff.statements[0].destructive);
    }

    #[test]
    fn new_index_generates_create_index() {
        let mut source_table = table(
            "users",
            vec![column("id", "integer", false, true), column("email", "text", true, false)],
        );
        source_table.indexes.push(IndexSchema {
            name: "idx_users_email".to_string(),
            columns: vec!["email".to_string()],
            unique: true,
        });
        let target_table = table(
            "users",
            vec![column("id", "integer", false, true), column("email", "text", true, false)],
        );

        let diff = diff_schemas(
            Dialect::Postgres,
            &schema(vec![source_table]),
            &schema(vec![target_table]),
        );

        assert_eq!(diff.summary.added_indexes, 1);
        assert_eq!(kinds(&diff), vec!["add_index"]);
        assert!(diff.statements[0]
            .sql
            .contains("CREATE UNIQUE INDEX \"idx_users_email\""));
    }

    #[test]
    fn new_foreign_key_generates_add_constraint() {
        let source = SchemaData {
            database: "db".to_string(),
            tables: vec![
                table("customers", vec![column("id", "integer", false, true)]),
                table(
                    "orders",
                    vec![
                        column("id", "integer", false, true),
                        column("customer_id", "integer", false, false),
                    ],
                ),
            ],
            foreign_keys: vec![ForeignKeySchema {
                name: "fk_orders_customer".to_string(),
                from_table: "orders".to_string(),
                from_columns: vec!["customer_id".to_string()],
                to_table: "customers".to_string(),
                to_columns: vec!["id".to_string()],
            }],
            views: Vec::new(),
            truncated: false,
        };
        let target = schema(vec![
            table("customers", vec![column("id", "integer", false, true)]),
            table(
                "orders",
                vec![
                    column("id", "integer", false, true),
                    column("customer_id", "integer", false, false),
                ],
            ),
        ]);

        let diff = diff_schemas(Dialect::Postgres, &source, &target);

        assert_eq!(diff.summary.added_foreign_keys, 1);
        assert_eq!(kinds(&diff), vec!["add_foreign_key"]);
        assert!(diff.statements[0]
            .sql
            .contains("ADD CONSTRAINT \"fk_orders_customer\" FOREIGN KEY"));
    }

    #[test]
    fn sqlite_column_change_emits_rebuild_note_instead_of_sql() {
        let source = schema(vec![table(
            "users",
            vec![column("name", "text", false, false)],
        )]);
        let target = schema(vec![table(
            "users",
            vec![column("name", "integer", true, false)],
        )]);

        let diff = diff_schemas(Dialect::Sqlite, &source, &target);

        assert_eq!(kinds(&diff), vec!["note"]);
        assert!(diff.statements[0].sql.starts_with("-- requires table rebuild"));
        assert!(!diff.statements[0].destructive);
    }

    #[test]
    fn sqlite_foreign_key_change_emits_rebuild_note() {
        let source = SchemaData {
            database: "main".to_string(),
            tables: vec![
                table("customers", vec![column("id", "integer", false, true)]),
                table(
                    "orders",
                    vec![
                        column("id", "integer", false, true),
                        column("customer_id", "integer", false, false),
                    ],
                ),
            ],
            foreign_keys: vec![ForeignKeySchema {
                name: "fk_orders_customer".to_string(),
                from_table: "orders".to_string(),
                from_columns: vec!["customer_id".to_string()],
                to_table: "customers".to_string(),
                to_columns: vec!["id".to_string()],
            }],
            views: Vec::new(),
            truncated: false,
        };
        let target = schema(vec![
            table("customers", vec![column("id", "integer", false, true)]),
            table(
                "orders",
                vec![
                    column("id", "integer", false, true),
                    column("customer_id", "integer", false, false),
                ],
            ),
        ]);

        let diff = diff_schemas(Dialect::Sqlite, &source, &target);

        assert_eq!(kinds(&diff), vec!["note"]);
        assert!(diff.statements[0].sql.contains("requires table rebuild"));
    }

    #[test]
    fn statements_are_ordered_safely_and_drops_come_last() {
        let mut source_orders = table(
            "orders",
            vec![
                column("id", "integer", false, true),
                column("customer_id", "integer", false, false),
                column("note", "text", true, false),
            ],
        );
        source_orders.indexes.push(IndexSchema {
            name: "idx_orders_note".to_string(),
            columns: vec!["note".to_string()],
            unique: false,
        });
        let mut target_orders = table(
            "orders",
            vec![
                column("id", "integer", false, true),
                column("customer_id", "integer", false, false),
                column("legacy", "text", true, false),
            ],
        );
        target_orders.indexes.push(IndexSchema {
            name: "idx_orders_legacy".to_string(),
            columns: vec!["legacy".to_string()],
            unique: false,
        });

        let source = SchemaData {
            database: "db".to_string(),
            tables: vec![
                table("new_table", vec![column("id", "integer", false, true)]),
                source_orders,
            ],
            foreign_keys: vec![ForeignKeySchema {
                name: "fk_orders_customer".to_string(),
                from_table: "orders".to_string(),
                from_columns: vec!["customer_id".to_string()],
                to_table: "new_table".to_string(),
                to_columns: vec!["id".to_string()],
            }],
            views: Vec::new(),
            truncated: false,
        };
        let target = schema(vec![
            target_orders,
            table("old_table", vec![column("id", "integer", false, true)]),
        ]);

        let diff = diff_schemas(Dialect::Postgres, &source, &target);
        let order = kinds(&diff);

        let position = |kind: &str| {
            order
                .iter()
                .position(|item| *item == kind)
                .unwrap_or_else(|| panic!("missing {kind}: {order:?}"))
        };

        assert!(position("create_table") < position("add_column"));
        assert!(position("add_column") < position("add_index"));
        assert!(position("add_index") < position("add_foreign_key"));
        assert!(position("add_foreign_key") < position("drop_index"));
        assert!(position("drop_index") < position("drop_column"));
        assert!(position("drop_column") < position("drop_table"));
        assert_eq!(order.last(), Some(&"drop_table"));
    }

    #[test]
    fn dropped_table_and_view_are_reported() {
        let source = SchemaData {
            database: "db".to_string(),
            tables: vec![table("kept", vec![column("id", "integer", false, true)])],
            foreign_keys: Vec::new(),
            views: vec![ViewSchema {
                name: "v_kept".to_string(),
                definition: Some("SELECT 1".to_string()),
            }],
            truncated: false,
        };
        let target = SchemaData {
            database: "db".to_string(),
            tables: vec![
                table("kept", vec![column("id", "integer", false, true)]),
                table("gone", vec![column("id", "integer", false, true)]),
            ],
            foreign_keys: Vec::new(),
            views: vec![ViewSchema {
                name: "v_gone".to_string(),
                definition: Some("SELECT 2".to_string()),
            }],
            truncated: false,
        };

        let diff = diff_schemas(Dialect::Postgres, &source, &target);

        assert_eq!(diff.summary.removed_tables, 1);
        assert_eq!(diff.summary.removed_views, 1);
        assert!(diff
            .statements
            .iter()
            .any(|statement| statement.kind == "drop_table" && statement.destructive));
        assert!(diff
            .statements
            .iter()
            .any(|statement| statement.kind == "drop_view" && !statement.destructive));
    }
}
