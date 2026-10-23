use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// ER diagrams are capped so a pathological schema cannot freeze the UI.
pub const ER_TABLE_LIMIT: usize = 300;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub pk: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErTable {
    pub name: String,
    pub columns: Vec<ErColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErForeignKey {
    pub name: String,
    pub from_table: String,
    pub from_columns: Vec<String>,
    pub to_table: String,
    pub to_columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErSchema {
    pub database: String,
    pub tables: Vec<ErTable>,
    pub foreign_keys: Vec<ErForeignKey>,
    pub truncated: bool,
}

/// One column of a foreign key, as returned by a dialect introspection query.
#[derive(Debug, Clone)]
pub struct ForeignKeyRow {
    pub constraint_name: String,
    pub from_table: String,
    pub from_column: String,
    pub from_position: i64,
    pub to_table: String,
    pub to_column: String,
    pub to_position: i64,
}

/// Group per-column FK rows into one composite constraint and order the columns
/// by their ordinal position inside the constraint.
pub fn group_foreign_keys(rows: Vec<ForeignKeyRow>) -> Vec<ErForeignKey> {
    let mut grouped: BTreeMap<(String, String, String), Vec<ForeignKeyRow>> = BTreeMap::new();

    for row in rows {
        grouped
            .entry((
                row.constraint_name.clone(),
                row.from_table.clone(),
                row.to_table.clone(),
            ))
            .or_default()
            .push(row);
    }

    grouped
        .into_iter()
        .map(|((name, from_table, to_table), mut columns)| {
            columns.sort_by(|a, b| {
                a.from_position
                    .cmp(&b.from_position)
                    .then(a.to_position.cmp(&b.to_position))
                    .then(a.from_column.cmp(&b.from_column))
                    .then(a.to_column.cmp(&b.to_column))
            });

            ErForeignKey {
                name,
                from_table,
                from_columns: columns
                    .iter()
                    .map(|column| column.from_column.clone())
                    .collect(),
                to_table,
                to_columns: columns
                    .iter()
                    .map(|column| column.to_column.clone())
                    .collect(),
            }
        })
        .collect()
}

pub fn postgres_tables_sql() -> &'static str {
    "SELECT table_name \
     FROM information_schema.tables \
     WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' \
     ORDER BY table_name"
}

pub fn postgres_columns_sql() -> &'static str {
    "SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, \
            (pk.column_name IS NOT NULL) AS is_pk \
     FROM information_schema.columns c \
     LEFT JOIN ( \
       SELECT kcu.table_schema, kcu.table_name, kcu.column_name \
       FROM information_schema.table_constraints tc \
       JOIN information_schema.key_column_usage kcu \
         ON tc.constraint_name = kcu.constraint_name \
        AND tc.constraint_schema = kcu.constraint_schema \
        AND tc.table_name = kcu.table_name \
       WHERE tc.constraint_type = 'PRIMARY KEY' \
         AND tc.table_schema = current_schema() \
     ) pk ON pk.table_schema = c.table_schema \
        AND pk.table_name = c.table_name \
        AND pk.column_name = c.column_name \
     WHERE c.table_schema = current_schema() \
     ORDER BY c.table_name, c.ordinal_position"
}

pub fn postgres_foreign_keys_sql() -> &'static str {
    "SELECT con.conname AS constraint_name, \
            src.relname AS from_table, \
            src_col.attname AS from_column, \
            src_key.ord AS from_position, \
            tgt.relname AS to_table, \
            tgt_col.attname AS to_column, \
            tgt_key.ord AS to_position \
     FROM pg_catalog.pg_constraint con \
     JOIN pg_catalog.pg_class src ON src.oid = con.conrelid \
     JOIN pg_catalog.pg_namespace src_ns ON src_ns.oid = src.relnamespace \
     JOIN pg_catalog.pg_class tgt ON tgt.oid = con.confrelid \
     JOIN pg_catalog.pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace \
     JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS src_key(attnum, ord) ON true \
     JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS tgt_key(attnum, ord) \
       ON tgt_key.ord = src_key.ord \
     JOIN pg_catalog.pg_attribute src_col \
       ON src_col.attrelid = con.conrelid AND src_col.attnum = src_key.attnum \
     JOIN pg_catalog.pg_attribute tgt_col \
       ON tgt_col.attrelid = con.confrelid AND tgt_col.attnum = tgt_key.attnum \
     WHERE con.contype = 'f' \
       AND src_ns.nspname = current_schema() \
       AND tgt_ns.nspname = current_schema() \
     ORDER BY con.conname, src_key.ord"
}

pub fn mysql_tables_sql() -> &'static str {
    "SELECT TABLE_NAME \
     FROM information_schema.TABLES \
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' \
     ORDER BY TABLE_NAME"
}

pub fn mysql_columns_sql() -> &'static str {
    "SELECT c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, \
            (c.COLUMN_KEY = 'PRI') AS IS_PK \
     FROM information_schema.COLUMNS c \
     WHERE c.TABLE_SCHEMA = ? \
     ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION"
}

pub fn mysql_foreign_keys_sql() -> &'static str {
    "SELECT k.CONSTRAINT_NAME, k.TABLE_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION, \
            k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, k.ORDINAL_POSITION \
     FROM information_schema.KEY_COLUMN_USAGE k \
     WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL \
     ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION"
}

pub fn mssql_tables_sql() -> &'static str {
    "SELECT t.name \
     FROM sys.tables t \
     WHERE SCHEMA_NAME(t.schema_id) = 'dbo' \
     ORDER BY t.name"
}

pub fn mssql_columns_sql() -> &'static str {
    "SELECT t.name AS table_name, c.name AS column_name, ty.name AS data_type, \
            c.is_nullable, \
            CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_pk \
     FROM sys.tables t \
     JOIN sys.columns c ON c.object_id = t.object_id \
     JOIN sys.types ty ON ty.user_type_id = c.user_type_id \
     LEFT JOIN ( \
       SELECT ic.object_id, ic.column_id \
       FROM sys.indexes i \
       JOIN sys.index_columns ic \
         ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
       WHERE i.is_primary_key = 1 \
     ) pk ON pk.object_id = t.object_id AND pk.column_id = c.column_id \
     WHERE SCHEMA_NAME(t.schema_id) = 'dbo' \
     ORDER BY t.name, c.column_id"
}

pub fn mssql_foreign_keys_sql() -> &'static str {
    "SELECT fk.name AS constraint_name, \
            parent.name AS from_table, \
            pc.name AS from_column, \
            fkc.constraint_column_id AS from_position, \
            ref.name AS to_table, \
            rc.name AS to_column, \
            fkc.constraint_column_id AS to_position \
     FROM sys.foreign_keys fk \
     JOIN sys.tables parent ON parent.object_id = fk.parent_object_id \
     JOIN sys.tables ref ON ref.object_id = fk.referenced_object_id \
     JOIN sys.foreign_key_columns fkc \
       ON fkc.constraint_object_id = fk.object_id \
     JOIN sys.columns pc \
       ON pc.object_id = fkc.parent_object_id \
      AND pc.column_id = fkc.parent_column_id \
     JOIN sys.columns rc \
       ON rc.object_id = fkc.referenced_object_id \
      AND rc.column_id = fkc.referenced_column_id \
     WHERE SCHEMA_NAME(parent.schema_id) = 'dbo' \
       AND SCHEMA_NAME(ref.schema_id) = 'dbo' \
     ORDER BY fk.name, fkc.constraint_column_id"
}

pub fn sqlite_columns_sql() -> &'static str {
    "SELECT m.name, p.name, p.type, p.\"notnull\", p.pk \
     FROM sqlite_master m \
     JOIN pragma_table_info(m.name) p \
     WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' \
     ORDER BY m.name, p.cid"
}

pub fn sqlite_foreign_keys_sql(schema: &str, table: &str) -> String {
    format!(
        "PRAGMA {}.foreign_key_list({})",
        quote_identifier(if schema.is_empty() { "main" } else { schema }),
        quote_identifier(table)
    )
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::{
        group_foreign_keys, mssql_foreign_keys_sql, mysql_foreign_keys_sql,
        postgres_foreign_keys_sql, sqlite_foreign_keys_sql, ForeignKeyRow,
    };

    fn row(
        name: &str,
        from_table: &str,
        from_column: &str,
        from_position: i64,
        to_table: &str,
        to_column: &str,
        to_position: i64,
    ) -> ForeignKeyRow {
        ForeignKeyRow {
            constraint_name: name.to_string(),
            from_table: from_table.to_string(),
            from_column: from_column.to_string(),
            from_position,
            to_table: to_table.to_string(),
            to_column: to_column.to_string(),
            to_position,
        }
    }

    #[test]
    fn groups_composite_foreign_keys_in_column_order() {
        let grouped = group_foreign_keys(vec![
            row("fk_order", "orders", "tenant_id", 2, "customers", "tenant_id", 2),
            row("fk_order", "orders", "customer_id", 1, "customers", "id", 1),
        ]);

        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].name, "fk_order");
        assert_eq!(grouped[0].from_table, "orders");
        assert_eq!(grouped[0].from_columns, vec!["customer_id".to_string(), "tenant_id".to_string()]);
        assert_eq!(grouped[0].to_table, "customers");
        assert_eq!(grouped[0].to_columns, vec!["id".to_string(), "tenant_id".to_string()]);
    }

    #[test]
    fn keeps_separate_constraints_separate() {
        let grouped = group_foreign_keys(vec![
            row("fk_a", "lines", "order_id", 1, "orders", "id", 1),
            row("fk_b", "lines", "product_id", 1, "products", "id", 1),
        ]);

        assert_eq!(grouped.len(), 2);
    }

    #[test]
    fn dialect_builders_use_the_right_catalogs() {
        assert!(postgres_foreign_keys_sql().contains("pg_constraint"));
        assert!(postgres_foreign_keys_sql().contains("WITH ORDINALITY"));
        assert!(mysql_foreign_keys_sql()
            .contains("REFERENCED_TABLE_NAME IS NOT NULL"));
        assert!(mssql_foreign_keys_sql().contains("sys.foreign_key_columns"));
        assert_eq!(
            sqlite_foreign_keys_sql("main", "order\"items"),
            "PRAGMA \"main\".foreign_key_list(\"order\"\"items\")"
        );
    }
}
