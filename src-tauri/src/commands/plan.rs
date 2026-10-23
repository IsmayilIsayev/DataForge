use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::core::drivers::{Dialect, QueryResult};
use crate::error::{AppError, AppResult};
use crate::sql_util::{explainable_statement, result_text};
use crate::state::AppState;

const LARGE_TABLE_ROWS: f64 = 10_000.0;
const LARGE_INNER_ROWS: f64 = 1_000.0;
const ESTIMATE_MISMATCH_RATIO: f64 = 10.0;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlanNode {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows_estimated: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows_actual: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_ms: Option<f64>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub children: Vec<PlanNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplainPlan {
    pub dialect: String,
    pub analyzed: bool,
    pub sql: String,
    pub root: PlanNode,
    pub raw: String,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn explain_plan(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
    sql: String,
    analyze: bool,
) -> AppResult<ExplainPlan> {
    let statement = explainable_statement(&sql).ok_or_else(|| {
        AppError::Config(
            "Only a single SELECT or WITH statement can be explained.".to_string(),
        )
    })?;
    let driver = state.pool.get(&conn_id).await?;
    let dialect = driver.dialect();
    let database = database.filter(|value| !value.trim().is_empty());

    match dialect {
        Dialect::Postgres => {
            let explain_sql = if analyze {
                format!("EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) {statement}")
            } else {
                format!("EXPLAIN (FORMAT JSON) {statement}")
            };
            let result = driver
                .run_statements(&[explain_sql], 100, database)
                .await?;
            let raw = result_text(&result);
            let value = plan_json(&result)?;
            let mut root = normalize_postgres(&value)
                .ok_or_else(|| AppError::Db("The database returned an unexpected EXPLAIN plan.".to_string()))?;
            apply_warnings(&mut root, analyze);
            Ok(ExplainPlan {
                dialect: "postgres".to_string(),
                analyzed: analyze,
                sql: statement.to_string(),
                root,
                raw,
            })
        }
        Dialect::Mysql => {
            let mut analyzed = analyze;
            let (result, from_json) = if analyze {
                let explain_sql = format!("EXPLAIN ANALYZE {statement}");
                match driver
                    .run_statements(&[explain_sql], 100, database.clone())
                    .await
                {
                    Ok(result) => (result, false),
                    Err(error) => {
                        // EXPLAIN ANALYZE needs MySQL 8.0.18+. Older servers (and
                        // MariaDB builds without it) still get the non-analyze plan.
                        eprintln!(
                            "[explain_plan] EXPLAIN ANALYZE failed, falling back to EXPLAIN FORMAT=JSON: {error}"
                        );
                        analyzed = false;
                        let explain_sql = format!("EXPLAIN FORMAT=JSON {statement}");
                        (
                            driver
                                .run_statements(&[explain_sql], 100, database)
                                .await?,
                            true,
                        )
                    }
                }
            } else {
                let explain_sql = format!("EXPLAIN FORMAT=JSON {statement}");
                (
                    driver
                        .run_statements(&[explain_sql], 100, database)
                        .await?,
                    true,
                )
            };
            let raw = result_text(&result);
            let mut root = if from_json {
                normalize_mysql_json(&plan_json(&result)?)
            } else {
                normalize_mysql_text(&raw)
            };
            apply_warnings(&mut root, analyzed);
            Ok(ExplainPlan {
                dialect: "mysql".to_string(),
                analyzed,
                sql: statement.to_string(),
                root,
                raw,
            })
        }
        Dialect::Sqlite => {
            let explain_sql = format!("EXPLAIN QUERY PLAN {statement}");
            let result = driver
                .run_statements(&[explain_sql], 100, database)
                .await?;
            let raw = result_text(&result);
            let mut root = normalize_sqlite(&result);
            apply_warnings(&mut root, false);
            Ok(ExplainPlan {
                dialect: "sqlite".to_string(),
                analyzed: false,
                sql: statement.to_string(),
                root,
                raw,
            })
        }
        Dialect::Mssql => Err(AppError::Config(
            "Execution plans are not supported for SQL Server.".to_string(),
        )),
        Dialect::Mongodb => Err(AppError::Config(
            "Execution plans are not supported for MongoDB.".to_string(),
        )),
    }
}

fn plan_json(result: &QueryResult) -> AppResult<Value> {
    let cell = result
        .rows
        .first()
        .and_then(|row| row.first())
        .ok_or_else(|| AppError::Db("The database returned an empty EXPLAIN plan.".to_string()))?;

    match cell {
        Value::String(text) => serde_json::from_str(text).map_err(|_| {
            AppError::Db("The database returned an EXPLAIN plan that is not valid JSON.".to_string())
        }),
        Value::Array(_) | Value::Object(_) => Ok(cell.clone()),
        _ => Err(AppError::Db(
            "The database returned an unexpected EXPLAIN plan.".to_string(),
        )),
    }
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn number_field(value: &Value, key: &str) -> Option<f64> {
    match value.get(key)? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn leading_number(text: &str) -> Option<f64> {
    let number: String = text
        .trim_start()
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '.' || *character == '-')
        .collect();
    number.parse().ok()
}

fn number_after(text: &str, needle: &str) -> Option<f64> {
    text.split_once(needle)
        .and_then(|(_, rest)| leading_number(rest))
}

fn normalize_postgres(value: &Value) -> Option<PlanNode> {
    let plan = match value {
        Value::Array(items) => {
            let entry = items.first()?;
            entry.get("Plan").unwrap_or(entry)
        }
        Value::Object(_) => value.get("Plan").unwrap_or(value),
        _ => return None,
    };
    Some(postgres_node(plan))
}

fn postgres_node(plan: &Value) -> PlanNode {
    let node_type = text_field(plan, "Node Type").unwrap_or_else(|| "Plan".to_string());
    let sort_method = text_field(plan, "Sort Method");
    let label = match sort_method {
        Some(method) if node_type.to_ascii_lowercase().contains("sort") => {
            format!("{node_type} ({method})")
        }
        _ => node_type,
    };
    let children = plan
        .get("Plans")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(postgres_node).collect())
        .unwrap_or_default();

    PlanNode {
        label,
        relation: text_field(plan, "Relation Name").or_else(|| text_field(plan, "Alias")),
        index: text_field(plan, "Index Name"),
        rows_estimated: number_field(plan, "Plan Rows"),
        rows_actual: number_field(plan, "Actual Rows"),
        cost: number_field(plan, "Total Cost"),
        time_ms: number_field(plan, "Actual Total Time"),
        warnings: Vec::new(),
        children,
    }
}

fn normalize_mysql_json(value: &Value) -> PlanNode {
    match value.get("query_block") {
        Some(block) => mysql_block(block, "Query"),
        None => mysql_block(value, "Query"),
    }
}

fn mysql_block(block: &Value, label: &str) -> PlanNode {
    PlanNode {
        label: label.to_string(),
        cost: block
            .get("cost_info")
            .and_then(|cost| number_field(cost, "query_cost")),
        children: mysql_children(block),
        ..Default::default()
    }
}

fn mysql_children(value: &Value) -> Vec<PlanNode> {
    let mut children = Vec::new();
    match value {
        Value::Array(items) => {
            for item in items {
                children.extend(mysql_children(item));
            }
        }
        Value::Object(_) => {
            if let Some(nested) = value.get("nested_loop").and_then(Value::as_array) {
                let mut loop_children = Vec::new();
                for item in nested {
                    loop_children.extend(mysql_children(item));
                }
                if !loop_children.is_empty() {
                    children.push(PlanNode {
                        label: "Nested loop join".to_string(),
                        children: loop_children,
                        ..Default::default()
                    });
                }
            }

            if let Some(table) = value.get("table") {
                match table {
                    Value::Array(items) => {
                        for item in items {
                            children.push(mysql_table(item));
                        }
                    }
                    Value::Object(_) => children.push(mysql_table(table)),
                    _ => {}
                }
            }

            for (key, label) in [
                ("ordering_operation", "Sort"),
                ("grouping_operation", "Group"),
                ("duplicates_removal", "Duplicate removal"),
            ] {
                if let Some(operation) = value.get(key) {
                    let filesort = operation
                        .get("using_filesort")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let temporary = operation
                        .get("using_temporary_table")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let mut flags = Vec::new();
                    if filesort {
                        flags.push("using filesort");
                    }
                    if temporary {
                        flags.push("using temporary");
                    }
                    let operation_label = if flags.is_empty() {
                        label.to_string()
                    } else {
                        format!("{label} ({})", flags.join(", "))
                    };
                    children.push(PlanNode {
                        label: operation_label,
                        cost: operation
                            .get("cost_info")
                            .and_then(|cost| {
                                number_field(cost, "prefix_cost")
                                    .or_else(|| number_field(cost, "query_cost"))
                            }),
                        children: mysql_children(operation),
                        ..Default::default()
                    });
                }
            }

            if let Some(union) = value.get("union_result") {
                let mut union_children = mysql_children(union);
                if let Some(specs) = union.get("query_specifications").and_then(Value::as_array) {
                    for spec in specs {
                        union_children.push(mysql_block(spec, "Query"));
                    }
                }
                children.push(PlanNode {
                    label: "Union".to_string(),
                    children: union_children,
                    ..Default::default()
                });
            }

            if let Some(materialized) = value.get("materialized_from_subquery") {
                let child = materialized
                    .get("query_block")
                    .map(|block| mysql_block(block, "Materialized subquery"))
                    .unwrap_or_else(|| PlanNode {
                        label: "Materialized subquery".to_string(),
                        ..Default::default()
                    });
                children.push(child);
            }

            if let Some(subqueries) = value.get("attached_subqueries").and_then(Value::as_array) {
                for subquery in subqueries {
                    match subquery.get("query_block") {
                        Some(block) => children.push(mysql_block(block, "Subquery")),
                        None => children.extend(mysql_children(subquery)),
                    }
                }
            }
        }
        _ => {}
    }
    children
}

fn mysql_table(table: &Value) -> PlanNode {
    let access = text_field(table, "access_type").unwrap_or_default();
    let label = match access.to_ascii_lowercase().as_str() {
        "all" => "Full table scan".to_string(),
        "index" => "Full index scan".to_string(),
        "range" => "Index range scan".to_string(),
        "ref" | "eq_ref" | "const" | "system" | "ref_or_null" => "Index lookup".to_string(),
        "index_merge" => "Index merge".to_string(),
        "fulltext" => "Full-text search".to_string(),
        "" => "Table access".to_string(),
        _ => access,
    };

    PlanNode {
        label,
        relation: text_field(table, "table_name"),
        index: text_field(table, "key"),
        rows_estimated: number_field(table, "rows_examined_per_scan")
            .or_else(|| number_field(table, "rows_produced_per_join")),
        rows_actual: None,
        cost: table.get("cost_info").and_then(|cost| {
            number_field(cost, "prefix_cost").or_else(|| number_field(cost, "read_cost"))
        }),
        time_ms: None,
        warnings: Vec::new(),
        children: mysql_children(table),
    }
}

fn normalize_mysql_text(text: &str) -> PlanNode {
    let lines: Vec<(usize, String)> = text
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            let rest = trimmed.strip_prefix("->")?;
            Some((line.len() - trimmed.len(), rest.trim().to_string()))
        })
        .collect();

    if lines.is_empty() {
        return PlanNode {
            label: text.trim().to_string(),
            ..Default::default()
        };
    }

    let mut index = 0;
    let mut roots = mysql_text_nodes(&lines, &mut index, lines[0].0);
    if roots.len() == 1 {
        roots.remove(0)
    } else {
        PlanNode {
            label: "Query".to_string(),
            children: roots,
            ..Default::default()
        }
    }
}

fn mysql_text_nodes(
    lines: &[(usize, String)],
    index: &mut usize,
    depth: usize,
) -> Vec<PlanNode> {
    let mut nodes = Vec::new();
    while *index < lines.len() {
        let (line_depth, line) = &lines[*index];
        if *line_depth < depth || *line_depth > depth {
            break;
        }

        let mut node = mysql_text_node(line);
        *index += 1;
        if *index < lines.len() && lines[*index].0 > depth {
            let child_depth = lines[*index].0;
            node.children = mysql_text_nodes(lines, index, child_depth);
        }
        nodes.push(node);
    }
    nodes
}

fn mysql_text_node(line: &str) -> PlanNode {
    let label = line
        .find(" (cost=")
        .map(|index| line[..index].trim())
        .unwrap_or_else(|| line.trim())
        .to_string();

    PlanNode {
        label: label.clone(),
        relation: mysql_text_relation(&label),
        index: mysql_text_index(&label),
        rows_estimated: number_after(line, "rows="),
        rows_actual: if line.contains("actual time=") {
            line.rsplit_once("rows=")
                .and_then(|(_, rest)| leading_number(rest))
        } else {
            None
        },
        cost: number_after(line, "cost="),
        time_ms: line
            .split_once("actual time=")
            .and_then(|(_, rest)| rest.split_once(".."))
            .and_then(|(_, rest)| leading_number(rest)),
        warnings: Vec::new(),
        children: Vec::new(),
    }
}

fn mysql_text_relation(label: &str) -> Option<String> {
    let lower = label.to_ascii_lowercase();
    let start = lower.find(" on ")? + 4;
    let rest = &label[start..];
    let rest_lower = rest.to_ascii_lowercase();
    let end = rest_lower
        .find(" using ")
        .or_else(|| rest.find(" ("))
        .unwrap_or(rest.len());
    let relation = rest[..end].trim();
    if relation.is_empty() {
        None
    } else {
        Some(relation.to_string())
    }
}

fn mysql_text_index(label: &str) -> Option<String> {
    let lower = label.to_ascii_lowercase();
    let start = lower.find("using index ").map(|index| index + 12)?;
    let rest = &label[start..];
    let end = rest
        .find(|character: char| character.is_whitespace() || character == '(')
        .unwrap_or(rest.len());
    let index = rest[..end].trim();
    if index.is_empty() {
        None
    } else {
        Some(index.to_string())
    }
}

fn normalize_sqlite(result: &QueryResult) -> PlanNode {
    let id_column = column_index(&result.columns, "id").unwrap_or(0);
    let parent_column = column_index(&result.columns, "parent").unwrap_or(1);
    let detail_column = column_index(&result.columns, "detail")
        .unwrap_or_else(|| result.columns.len().saturating_sub(1));

    let mut nodes: HashMap<i64, PlanNode> = HashMap::new();
    let mut parent_of: HashMap<i64, i64> = HashMap::new();
    let mut order = Vec::new();

    for row in &result.rows {
        let Some(id) = row.get(id_column).and_then(json_i64) else {
            continue;
        };
        let parent = row.get(parent_column).and_then(json_i64).unwrap_or(0);
        let detail = row
            .get(detail_column)
            .map(json_text)
            .unwrap_or_default();
        let mut node = PlanNode {
            label: detail.clone(),
            ..Default::default()
        };
        enrich_sqlite_node(&detail, &mut node);
        nodes.insert(id, node);
        parent_of.insert(id, parent);
        order.push(id);
    }

    if nodes.is_empty() {
        return PlanNode {
            label: "EXPLAIN QUERY PLAN returned no rows".to_string(),
            ..Default::default()
        };
    }

    let mut children_by_parent: HashMap<i64, Vec<i64>> = HashMap::new();
    for id in &order {
        let parent = parent_of.get(id).copied().unwrap_or(0);
        children_by_parent.entry(parent).or_default().push(*id);
    }

    let mut roots: Vec<i64> = order
        .iter()
        .copied()
        .filter(|id| !nodes.contains_key(parent_of.get(id).unwrap_or(&0)))
        .collect();
    if roots.is_empty() {
        roots.push(order[0]);
    }

    let mut built: Vec<PlanNode> = roots
        .iter()
        .filter_map(|id| build_sqlite_node(*id, &mut nodes, &children_by_parent))
        .collect();

    if built.len() == 1 {
        built.remove(0)
    } else {
        PlanNode {
            label: "Query plan".to_string(),
            children: built,
            ..Default::default()
        }
    }
}

fn build_sqlite_node(
    id: i64,
    nodes: &mut HashMap<i64, PlanNode>,
    children_by_parent: &HashMap<i64, Vec<i64>>,
) -> Option<PlanNode> {
    let mut node = nodes.remove(&id)?;
    if let Some(children) = children_by_parent.get(&id) {
        node.children = children
            .iter()
            .filter_map(|child| build_sqlite_node(*child, nodes, children_by_parent))
            .collect();
    }
    Some(node)
}

fn column_index(columns: &[String], name: &str) -> Option<usize> {
    columns
        .iter()
        .position(|column| column.eq_ignore_ascii_case(name))
}

fn json_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn json_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn enrich_sqlite_node(detail: &str, node: &mut PlanNode) {
    let lower = detail.to_ascii_lowercase();
    let rest = if lower.starts_with("scan ") {
        &detail[5..]
    } else if lower.starts_with("search ") {
        &detail[7..]
    } else {
        ""
    };

    if !rest.is_empty() {
        let rest_lower = rest.to_ascii_lowercase();
        let end = rest_lower
            .find(" using ")
            .or_else(|| rest.find(" ("))
            .unwrap_or(rest.len());
        let relation = rest[..end].trim();
        if !relation.is_empty() {
            node.relation = Some(relation.to_string());
        }
    }

    if let Some(index) = sqlite_index(detail, "using covering index ") {
        node.index = Some(index);
    } else if let Some(index) = sqlite_index(detail, "using index ") {
        node.index = Some(index);
    }

    node.rows_estimated = detail
        .find("(~")
        .and_then(|index| leading_number(&detail[index + 2..]));
}

fn sqlite_index(detail: &str, marker: &str) -> Option<String> {
    let lower = detail.to_ascii_lowercase();
    let start = lower.find(marker)? + marker.len();
    let rest = &detail[start..];
    let end = rest
        .find(|character: char| character.is_whitespace() || character == '(')
        .unwrap_or(rest.len());
    let index = rest[..end].trim();
    if index.is_empty() {
        None
    } else {
        Some(index.to_string())
    }
}

fn apply_warnings(node: &mut PlanNode, analyzed: bool) {
    warn_node(node, analyzed);
    for child in &mut node.children {
        apply_warnings(child, analyzed);
    }
}

fn warn_node(node: &mut PlanNode, analyzed: bool) {
    let label = node.label.to_ascii_lowercase();
    let full_scan = label.contains("seq scan")
        || label.contains("full table scan")
        || label.contains("table scan on")
        || label.starts_with("scan ");

    if full_scan {
        if let (Some(relation), Some(rows)) = (node.relation.as_deref(), node.rows_estimated) {
            if rows > LARGE_TABLE_ROWS {
                push_warning(
                    node,
                    format!(
                        "Full table scan on {relation} (~{rows:.0} estimated rows) — an index may help."
                    ),
                );
            }
        }
    }

    if label.contains("nested loop") {
        if let Some(inner) = node.children.last() {
            let rows = inner
                .rows_estimated
                .or(inner.rows_actual)
                .unwrap_or(0.0);
            if rows > LARGE_INNER_ROWS {
                push_warning(
                    node,
                    format!(
                        "Nested loop with a large inner side (~{rows:.0} rows) — an index on the join key may help."
                    ),
                );
            }
        }
    }

    if label.contains("external") {
        push_warning(
            node,
            "Sort spills to disk (external merge) — raise work_mem or add an index for the ORDER BY."
                .to_string(),
        );
    }

    if label.contains("filesort") {
        push_warning(
            node,
            "Using filesort — MySQL sorts the result instead of reading it in index order.".to_string(),
        );
    }

    if label.contains("temporary") {
        push_warning(
            node,
            "Using temporary — MySQL builds an internal temporary table.".to_string(),
        );
    }

    if analyzed {
        if let (Some(estimated), Some(actual)) = (node.rows_estimated, node.rows_actual) {
            let estimated = estimated.max(1.0);
            let actual = actual.max(1.0);
            let ratio = (estimated / actual).max(actual / estimated);
            if ratio > ESTIMATE_MISMATCH_RATIO {
                push_warning(
                    node,
                    format!(
                        "Estimated {estimated:.0} rows but returned {actual:.0} ({ratio:.0}× off) — run ANALYZE or check the index statistics."
                    ),
                );
            }
        }
    }
}

fn push_warning(node: &mut PlanNode, warning: String) {
    if !node.warnings.iter().any(|existing| existing == &warning) {
        node.warnings.push(warning);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_warnings, normalize_mysql_json, normalize_sqlite, normalize_postgres, PlanNode,
    };
    use crate::core::drivers::QueryResult;
    use serde_json::{json, Value};

    const POSTGRES_PLAN: &str = r#"[{
        "Plan": {
            "Node Type": "Hash Join",
            "Startup Cost": 1.0,
            "Total Cost": 120.0,
            "Plan Rows": 100,
            "Actual Startup Time": 0.1,
            "Actual Total Time": 3.5,
            "Actual Rows": 90,
            "Actual Loops": 1,
            "Plans": [
                {
                    "Node Type": "Seq Scan",
                    "Relation Name": "orders",
                    "Alias": "orders",
                    "Total Cost": 80.0,
                    "Plan Rows": 20000,
                    "Actual Total Time": 2.0,
                    "Actual Rows": 19000,
                    "Actual Loops": 1
                },
                {
                    "Node Type": "Hash",
                    "Total Cost": 10.0,
                    "Plan Rows": 100,
                    "Plans": [
                        {
                            "Node Type": "Index Scan",
                            "Relation Name": "users",
                            "Index Name": "users_pkey",
                            "Total Cost": 9.0,
                            "Plan Rows": 100,
                            "Actual Rows": 100
                        }
                    ]
                }
            ]
        }
    }]"#;

    #[test]
    fn normalizes_a_postgres_explain_json_tree() {
        let value: Value = serde_json::from_str(POSTGRES_PLAN).unwrap();
        let mut root = normalize_postgres(&value).expect("a plan root");
        apply_warnings(&mut root, true);

        assert_eq!(root.label, "Hash Join");
        assert_eq!(root.cost, Some(120.0));
        assert_eq!(root.rows_estimated, Some(100.0));
        assert_eq!(root.children.len(), 2);

        let seq_scan = &root.children[0];
        assert_eq!(seq_scan.label, "Seq Scan");
        assert_eq!(seq_scan.relation.as_deref(), Some("orders"));
        assert_eq!(seq_scan.rows_estimated, Some(20000.0));
        assert!(seq_scan
            .warnings
            .iter()
            .any(|warning| warning.contains("Full table scan on orders")));

        let index_scan = &root.children[1].children[0];
        assert_eq!(index_scan.label, "Index Scan");
        assert_eq!(index_scan.index.as_deref(), Some("users_pkey"));
        assert_eq!(index_scan.rows_actual, Some(100.0));
    }

    const MYSQL_PLAN: &str = r#"{
        "query_block": {
            "select_id": 1,
            "cost_info": { "query_cost": "15.50" },
            "ordering_operation": {
                "using_filesort": true,
                "cost_info": { "sort_cost": "5.00" },
                "nested_loop": [
                    {
                        "table": {
                            "table_name": "orders",
                            "access_type": "ALL",
                            "rows_examined_per_scan": 25000,
                            "rows_produced_per_join": 2500,
                            "cost_info": { "prefix_cost": "10.00" }
                        }
                    },
                    {
                        "table": {
                            "table_name": "users",
                            "access_type": "eq_ref",
                            "key": "PRIMARY",
                            "rows_examined_per_scan": 1,
                            "rows_produced_per_join": 2500,
                            "cost_info": { "prefix_cost": "15.50" }
                        }
                    }
                ]
            }
        }
    }"#;

    #[test]
    fn normalizes_a_mysql_explain_json_tree() {
        let value: Value = serde_json::from_str(MYSQL_PLAN).unwrap();
        let mut root = normalize_mysql_json(&value);
        apply_warnings(&mut root, false);

        assert_eq!(root.label, "Query");
        assert_eq!(root.cost, Some(15.5));
        assert_eq!(root.children.len(), 1);

        let sort = &root.children[0];
        assert_eq!(sort.label, "Sort (using filesort)");
        assert!(sort
            .warnings
            .iter()
            .any(|warning| warning.contains("Using filesort")));

        let nested_loop = &sort.children[0];
        assert_eq!(nested_loop.label, "Nested loop join");
        assert_eq!(nested_loop.children.len(), 2);

        let orders = &nested_loop.children[0];
        assert_eq!(orders.label, "Full table scan");
        assert_eq!(orders.relation.as_deref(), Some("orders"));
        assert_eq!(orders.rows_estimated, Some(25000.0));
        assert!(orders
            .warnings
            .iter()
            .any(|warning| warning.contains("Full table scan on orders")));

        let users = &nested_loop.children[1];
        assert_eq!(users.label, "Index lookup");
        assert_eq!(users.relation.as_deref(), Some("users"));
        assert_eq!(users.index.as_deref(), Some("PRIMARY"));
    }

    #[test]
    fn normalizes_sqlite_explain_query_plan_rows_into_a_tree() {
        let result = QueryResult {
            columns: vec![
                "id".to_string(),
                "parent".to_string(),
                "notused".to_string(),
                "detail".to_string(),
            ],
            rows: vec![
                vec![json!(2), json!(0), json!(0), json!("SCAN orders")],
                vec![
                    json!(3),
                    json!(2),
                    json!(0),
                    json!("SEARCH users USING INDEX users_pkey (id=?)"),
                ],
            ],
            rows_affected: None,
            elapsed_ms: 0,
            truncated: false,
        };

        let mut root = normalize_sqlite(&result);
        apply_warnings(&mut root, false);

        assert_eq!(root.label, "SCAN orders");
        assert_eq!(root.relation.as_deref(), Some("orders"));
        assert_eq!(root.children.len(), 1);

        let lookup = &root.children[0];
        assert_eq!(lookup.relation.as_deref(), Some("users"));
        assert_eq!(lookup.index.as_deref(), Some("users_pkey"));
        assert!(lookup.label.contains("SEARCH users"));
    }

    #[test]
    fn warning_rules_cover_scans_nested_loops_spills_mismatches_and_mysql_flags() {
        let mut seq_scan = PlanNode {
            label: "Seq Scan".to_string(),
            relation: Some("events".to_string()),
            rows_estimated: Some(20_000.0),
            ..Default::default()
        };
        apply_warnings(&mut seq_scan, false);
        assert!(seq_scan
            .warnings
            .iter()
            .any(|warning| warning.contains("Full table scan on events")));

        let mut small_scan = PlanNode {
            label: "Seq Scan".to_string(),
            relation: Some("events".to_string()),
            rows_estimated: Some(500.0),
            ..Default::default()
        };
        apply_warnings(&mut small_scan, false);
        assert!(small_scan.warnings.is_empty());

        let mut nested_loop = PlanNode {
            label: "Nested Loop".to_string(),
            children: vec![
                PlanNode {
                    rows_estimated: Some(10.0),
                    ..Default::default()
                },
                PlanNode {
                    rows_estimated: Some(5_000.0),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        apply_warnings(&mut nested_loop, false);
        assert!(nested_loop
            .warnings
            .iter()
            .any(|warning| warning.contains("large inner side")));

        let mut sort_spill = PlanNode {
            label: "Sort (external merge Disk: 2048kB)".to_string(),
            ..Default::default()
        };
        apply_warnings(&mut sort_spill, false);
        assert!(sort_spill
            .warnings
            .iter()
            .any(|warning| warning.contains("spills to disk")));

        let mut mismatch = PlanNode {
            label: "Index Scan".to_string(),
            rows_estimated: Some(10.0),
            rows_actual: Some(500.0),
            ..Default::default()
        };
        apply_warnings(&mut mismatch, true);
        assert!(mismatch
            .warnings
            .iter()
            .any(|warning| warning.contains("50× off")));

        let mut not_analyzed = mismatch.clone();
        not_analyzed.warnings.clear();
        apply_warnings(&mut not_analyzed, false);
        assert!(!not_analyzed
            .warnings
            .iter()
            .any(|warning| warning.contains("off")));

        let mut mysql_filesort = PlanNode {
            label: "Sort (using filesort)".to_string(),
            ..Default::default()
        };
        apply_warnings(&mut mysql_filesort, false);
        assert!(mysql_filesort
            .warnings
            .iter()
            .any(|warning| warning.contains("Using filesort")));

        let mut mysql_temporary = PlanNode {
            label: "Group (using temporary)".to_string(),
            ..Default::default()
        };
        apply_warnings(&mut mysql_temporary, false);
        assert!(mysql_temporary
            .warnings
            .iter()
            .any(|warning| warning.contains("Using temporary")));
    }
}
