import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import Editor from "@monaco-editor/react";
import {
  compareSchemas,
  connectConnection,
  errorMessage,
  listDatabases,
  saveSqlScript,
} from "../ipc";
import { copyText } from "../clipboard";
import { notify } from "../notifications";
import { useAppStore } from "../store";
import type {
  ConnectionMeta,
  DiffStatement,
  SchemaColumn,
  SchemaDiff,
  TableDiff,
  TableDiffItem,
  ViewDiff,
} from "../types";

interface Props {
  defaultConnId: string | null;
  defaultDatabase: string | null;
  theme: "dark" | "light";
  onClose: () => void;
  onOpenInEditor: (
    sql: string,
    connectionId: string,
    database: string,
  ) => void;
}

const selectStyle: CSSProperties = {
  height: 28,
  minWidth: 0,
  flex: 1,
  border: "1px solid var(--bd2)",
  borderRadius: 4,
  background: "var(--bg)",
  color: "var(--tx)",
  padding: "0 6px",
  fontSize: 12,
};

const buttonStyle: CSSProperties = {
  height: 26,
  padding: "0 10px",
  border: "1px solid var(--bd2)",
  borderRadius: 4,
  background: "var(--sf2)",
  color: "var(--tx)",
  fontSize: 12,
  cursor: "default",
};

function connectionLabel(connection: ConnectionMeta | undefined) {
  if (!connection) return "—";
  return `${connection.name} (${connection.dialect})`;
}

function itemSymbol(item: TableDiffItem) {
  if (item.kind.includes("added")) return "+";
  if (item.kind.includes("removed")) return "−";
  return "~";
}

function itemColor(item: TableDiffItem) {
  if (item.destructive) return "var(--er)";
  if (item.kind.includes("added")) return "var(--ok)";
  if (item.kind.includes("removed")) return "var(--wn)";
  return "var(--ac)";
}

function columnDefinition(column: SchemaColumn) {
  let text = `${column.name} ${column.data_type}`;
  if (!column.nullable) text += " NOT NULL";
  if (column.default) text += ` DEFAULT ${column.default}`;
  if (column.auto_increment) text += " AUTO_INCREMENT";
  return text;
}

function statusColor(status: string) {
  if (status === "added") return "var(--ok)";
  if (status === "removed") return "var(--er)";
  return "var(--ac)";
}

function summaryChip(label: string, value: number, color?: string) {
  if (value === 0) return null;
  return (
    <span
      key={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 6px",
        border: "1px solid var(--bd)",
        borderRadius: 10,
        color: color ?? "var(--mu)",
        fontSize: 11,
      }}
    >
      <span style={{ fontFamily: "var(--mono)" }}>{value}</span>
      {label}
    </span>
  );
}

function StatementRow({
  index,
  statement,
  checked,
  onToggle,
}: {
  index: number;
  statement: DiffStatement;
  checked: boolean;
  onToggle: () => void;
}) {
  const note = statement.kind === "note";
  return (
    <label
      title={statement.reason ?? statement.sql}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        padding: "4px 8px",
        borderBottom: "1px solid var(--bd)",
        cursor: "default",
        color: statement.destructive ? "var(--er)" : "var(--tx)",
        background: statement.destructive ? "var(--ers)" : "transparent",
        opacity: note ? 0.7 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={note}
        onChange={onToggle}
        style={{ marginTop: 2, flex: "none" }}
      />
      <span
        style={{
          width: 16,
          flex: "none",
          color: "var(--fa)",
          fontFamily: "var(--mono)",
          fontSize: 10,
        }}
      >
        {index + 1}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          lineHeight: 1.4,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          fontStyle: note ? "italic" : "normal",
        }}
      >
        {statement.sql}
      </span>
    </label>
  );
}

function ColumnChange({ item }: { item: TableDiffItem }) {
  if (item.kind !== "column_changed" || !item.before_column || !item.after_column) {
    return null;
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 6,
        padding: "2px 0 4px 38px",
      }}
    >
      <div
        style={{
          padding: "4px 6px",
          border: "1px solid var(--bd)",
          borderRadius: 4,
          background: "var(--dels)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--mu)",
          overflowWrap: "anywhere",
        }}
      >
        {columnDefinition(item.before_column)}
      </div>
      <div
        style={{
          padding: "4px 6px",
          border: "1px solid var(--bd)",
          borderRadius: 4,
          background: "var(--newrow)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--tx)",
          overflowWrap: "anywhere",
        }}
      >
        {columnDefinition(item.after_column)}
      </div>
    </div>
  );
}

function TableGroup({ table }: { table: TableDiff }) {
  return (
    <div style={{ borderBottom: "1px solid var(--bd)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 8px",
          background: "var(--sf2)",
          position: "sticky",
          top: 0,
          zIndex: 1,
        }}
      >
        <i
          className="icon-table-2"
          style={{ fontSize: 12, color: statusColor(table.status) }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "var(--tx)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {table.name}
        </span>
        <span style={{ fontSize: 10, color: statusColor(table.status) }}>
          {table.status}
        </span>
      </div>
      {table.items.map((item, index) => (
        <div key={`${item.kind}-${index}`}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 6,
              padding: "3px 8px",
              color: itemColor(item),
            }}
          >
            <span
              style={{
                width: 12,
                flex: "none",
                fontFamily: "var(--mono)",
                fontSize: 12,
                textAlign: "center",
              }}
            >
              {itemSymbol(item)}
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 11.5 }}>
              {item.label}
              {item.changes && item.changes.length > 0 && (
                <span style={{ color: "var(--mu)" }}>
                  {" "}
                  — {item.changes.join("; ")}
                </span>
              )}
              {item.reason && (
                <span
                  style={{
                    display: "block",
                    color: "var(--er)",
                    fontSize: 10.5,
                    lineHeight: 1.35,
                  }}
                >
                  {item.reason}
                </span>
              )}
            </span>
          </div>
          <ColumnChange item={item} />
        </div>
      ))}
    </div>
  );
}

function ViewGroup({ view }: { view: ViewDiff }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        padding: "4px 8px",
        borderBottom: "1px solid var(--bd)",
        color: statusColor(view.status),
      }}
    >
      <span style={{ width: 12, flex: "none", fontFamily: "var(--mono)" }}>
        {view.status === "added" ? "+" : view.status === "removed" ? "−" : "~"}
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 11.5 }}>
        view {view.name}
        {view.definition && (
          <span
            style={{
              display: "block",
              color: "var(--mu)",
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {view.definition.replace(/\s+/g, " ").slice(0, 220)}
          </span>
        )}
        {view.reason && (
          <span
            style={{
              display: "block",
              color: "var(--er)",
              fontSize: 10.5,
              lineHeight: 1.35,
            }}
          >
            {view.reason}
          </span>
        )}
      </span>
    </div>
  );
}

export default function SchemaCompareDialog({
  defaultConnId,
  defaultDatabase,
  theme,
  onClose,
  onOpenInEditor,
}: Props) {
  const connections = useAppStore((state) => state.connections);
  const initialSource =
    connections.find((connection) => connection.id === defaultConnId)?.id ??
    connections[0]?.id ??
    "";
  const initialTarget =
    connections.find((connection) => connection.id !== initialSource)?.id ??
    initialSource;

  const [sourceConn, setSourceConn] = useState(initialSource);
  const [targetConn, setTargetConn] = useState(initialTarget);
  const [sourceDb, setSourceDb] = useState(defaultDatabase ?? "");
  const [targetDb, setTargetDb] = useState(defaultDatabase ?? "");
  const [sourceDbs, setSourceDbs] = useState<string[]>([]);
  const [targetDbs, setTargetDbs] = useState<string[]>([]);
  const [diff, setDiff] = useState<SchemaDiff | null>(null);
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, loading]);

  useEffect(() => {
    if (!sourceConn) {
      setSourceDbs([]);
      setSourceDb("");
      return;
    }
    let cancelled = false;
    connectConnection(sourceConn)
      .then(() => listDatabases(sourceConn))
      .then((databases) => {
        if (cancelled) return;
        setSourceDbs(databases);
        setSourceDb((current) => {
          if (current && databases.includes(current)) return current;
          const preferred = connections.find(
            (connection) => connection.id === sourceConn,
          )?.database;
          if (preferred && databases.includes(preferred)) return preferred;
          return databases[0] ?? "";
        });
      })
      .catch((loadError) => {
        if (!cancelled) setError(errorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, [sourceConn, connections]);

  useEffect(() => {
    if (!targetConn) {
      setTargetDbs([]);
      setTargetDb("");
      return;
    }
    let cancelled = false;
    connectConnection(targetConn)
      .then(() => listDatabases(targetConn))
      .then((databases) => {
        if (cancelled) return;
        setTargetDbs(databases);
        setTargetDb((current) => {
          if (current && databases.includes(current)) return current;
          const preferred = connections.find(
            (connection) => connection.id === targetConn,
          )?.database;
          if (preferred && databases.includes(preferred)) return preferred;
          return databases[0] ?? "";
        });
      })
      .catch((loadError) => {
        if (!cancelled) setError(errorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, [targetConn, connections]);

  useEffect(() => {
    setDiff(null);
    setSelected({});
  }, [sourceConn, targetConn, sourceDb, targetDb]);

  const selectedSql = useMemo(() => {
    if (!diff) return "";
    const statements = diff.statements
      .map((statement, index) =>
        selected[index] && statement.kind !== "note"
          ? `${statement.sql.trim().replace(/;$/, "")};`
          : null,
      )
      .filter((statement): statement is string => statement !== null);
    return statements.join("\n\n");
  }, [diff, selected]);

  const runCompare = async () => {
    if (!sourceConn || !targetConn) {
      setError("Choose a source and a target connection.");
      return;
    }
    if (!sourceDb || !targetDb) {
      setError("Choose a source and a target database.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await compareSchemas(
        sourceConn,
        sourceDb,
        targetConn,
        targetDb,
      );
      setDiff(result);
      setSelected(
        Object.fromEntries(
          result.statements.map((statement, index) => [
            index,
            !statement.destructive && statement.kind !== "note",
          ]),
        ),
      );
    } catch (compareError) {
      setDiff(null);
      setError(errorMessage(compareError));
    } finally {
      setLoading(false);
    }
  };

  const copyScript = async () => {
    if (!selectedSql.trim()) {
      void notify("DataForge", "Select at least one statement first.");
      return;
    }
    const copied = await copyText(selectedSql);
    void notify(
      "DataForge",
      copied ? "Migration script copied." : "Copy failed.",
    );
  };

  const saveScript = async () => {
    if (!selectedSql.trim()) {
      void notify("DataForge", "Select at least one statement first.");
      return;
    }
    setSaving(true);
    try {
      const saved = await saveSqlScript(
        selectedSql,
        `schema-migration-${diff?.target_database ?? "target"}.sql`,
      );
      if (saved) void notify("DataForge", "Migration script saved.");
    } catch (saveError) {
      void notify("DataForge", "Save failed: " + errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const openInEditor = () => {
    if (!selectedSql.trim()) {
      void notify("DataForge", "Select at least one statement first.");
      return;
    }
    onOpenInEditor(selectedSql, targetConn, targetDb);
  };

  const toggle = (index: number) => {
    setSelected((current) => ({ ...current, [index]: !current[index] }));
  };

  const summary = diff?.summary;

  return (
    <>
      <div
        onMouseDown={() => !loading && onClose()}
        style={{ position: "fixed", inset: 0, zIndex: 70, background: "var(--ov)" }}
      />
      <div
        style={{
          position: "fixed",
          left: "50%",
          top: "4%",
          transform: "translateX(-50%)",
          zIndex: 71,
          width: 1080,
          maxWidth: "96vw",
          height: "88vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--sf)",
          border: "1px solid var(--bd2)",
          borderRadius: 8,
          boxShadow: "var(--sh)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            borderBottom: "1px solid var(--bd)",
          }}
        >
          <i
            className="icon-git-compare"
            style={{ fontSize: 15, color: "var(--fa)" }}
          />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Compare schemas</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fa)" }}>
            source → target
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="v2-btn"
            onClick={onClose}
            disabled={loading}
          >
            Close
          </button>
        </div>

        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "flex-end",
            gap: 10,
            padding: "8px 12px",
            borderBottom: "1px solid var(--bd)",
            background: "var(--sf2)",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10.5, color: "var(--mu)", marginBottom: 3 }}>
              Source (desired schema)
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <select
                value={sourceConn}
                onChange={(event) => setSourceConn(event.target.value)}
                style={selectStyle}
                title={connectionLabel(
                  connections.find((connection) => connection.id === sourceConn),
                )}
              >
                {connections.length === 0 && <option value="">No connections</option>}
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connectionLabel(connection)}
                  </option>
                ))}
              </select>
              <select
                value={sourceDb}
                onChange={(event) => setSourceDb(event.target.value)}
                style={{ ...selectStyle, flex: 0.7 }}
              >
                {sourceDbs.length === 0 && <option value="">—</option>}
                {sourceDbs.map((database) => (
                  <option key={database} value={database}>
                    {database}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div
            style={{
              flex: "none",
              paddingBottom: 7,
              color: "var(--fa)",
              fontFamily: "var(--mono)",
            }}
          >
            →
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10.5, color: "var(--mu)", marginBottom: 3 }}>
              Target (will be changed)
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <select
                value={targetConn}
                onChange={(event) => setTargetConn(event.target.value)}
                style={selectStyle}
                title={connectionLabel(
                  connections.find((connection) => connection.id === targetConn),
                )}
              >
                {connections.length === 0 && <option value="">No connections</option>}
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connectionLabel(connection)}
                  </option>
                ))}
              </select>
              <select
                value={targetDb}
                onChange={(event) => setTargetDb(event.target.value)}
                style={{ ...selectStyle, flex: 0.7 }}
              >
                {targetDbs.length === 0 && <option value="">—</option>}
                {targetDbs.map((database) => (
                  <option key={database} value={database}>
                    {database}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button
            type="button"
            className="v2-btn v2-btn-primary"
            style={{ height: 28, minWidth: 86 }}
            onClick={() => void runCompare()}
            disabled={loading || !sourceConn || !targetConn}
          >
            {loading ? "Comparing…" : "Compare"}
          </button>
        </div>

        {error && (
          <div
            style={{
              flex: "none",
              padding: "6px 12px",
              color: "var(--er)",
              background: "var(--ers)",
              borderBottom: "1px solid var(--bd)",
              fontSize: 11.5,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <div
            style={{
              width: "42%",
              minWidth: 260,
              display: "flex",
              flexDirection: "column",
              borderRight: "1px solid var(--bd)",
              minHeight: 0,
            }}
          >
            <div
              style={{
                flex: "none",
                display: "flex",
                flexWrap: "wrap",
                gap: 5,
                padding: "7px 8px",
                borderBottom: "1px solid var(--bd)",
                background: "var(--sf2)",
              }}
            >
              {summary ? (
                <>
                  {summaryChip("tables +", summary.added_tables, "var(--ok)")}
                  {summaryChip("tables −", summary.removed_tables, "var(--er)")}
                  {summaryChip("tables ~", summary.changed_tables, "var(--ac)")}
                  {summaryChip("columns +", summary.added_columns, "var(--ok)")}
                  {summaryChip("columns −", summary.removed_columns, "var(--er)")}
                  {summaryChip("columns ~", summary.changed_columns, "var(--ac)")}
                  {summaryChip("indexes +", summary.added_indexes, "var(--ok)")}
                  {summaryChip("indexes −", summary.removed_indexes, "var(--wn)")}
                  {summaryChip("FKs +", summary.added_foreign_keys, "var(--ok)")}
                  {summaryChip("FKs −", summary.removed_foreign_keys, "var(--wn)")}
                  {summaryChip("views", summary.added_views + summary.removed_views + summary.changed_views, "var(--ac)")}
                  {summaryChip("destructive", summary.destructive, "var(--er)")}
                  {summary.added_tables + summary.removed_tables + summary.changed_tables + summary.added_columns + summary.removed_columns + summary.changed_columns + summary.added_indexes + summary.removed_indexes + summary.added_foreign_keys + summary.removed_foreign_keys + summary.added_views + summary.removed_views + summary.changed_views === 0 && (
                    <span style={{ color: "var(--ok)", fontSize: 11 }}>
                      Schemas match
                    </span>
                  )}
                </>
              ) : (
                <span style={{ color: "var(--mu)", fontSize: 11 }}>
                  Pick two databases and run Compare.
                </span>
              )}
            </div>

            <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
              {diff ? (
                diff.tables.length === 0 && diff.views.length === 0 ? (
                  <div
                    style={{
                      padding: 22,
                      textAlign: "center",
                      color: "var(--ok)",
                      fontSize: 12.5,
                    }}
                  >
                    No differences found.
                  </div>
                ) : (
                  <>
                    {diff.tables.map((table) => (
                      <TableGroup key={table.name} table={table} />
                    ))}
                    {diff.views.length > 0 && (
                      <div
                        style={{
                          padding: "5px 8px",
                          background: "var(--sf2)",
                          fontSize: 11,
                          color: "var(--mu)",
                          borderBottom: "1px solid var(--bd)",
                        }}
                      >
                        Views
                      </div>
                    )}
                    {diff.views.map((view) => (
                      <ViewGroup key={view.name} view={view} />
                    ))}
                  </>
                )
              ) : (
                <div
                  style={{
                    padding: 22,
                    textAlign: "center",
                    color: "var(--fa)",
                    fontSize: 12,
                  }}
                >
                  The diff and migration script will appear here.
                </div>
              )}
              {(diff?.source_truncated || diff?.target_truncated) && (
                <div
                  style={{
                    padding: "6px 8px",
                    color: "var(--wn)",
                    fontSize: 11,
                  }}
                >
                  Schema comparison is capped at 500 tables; only the first 500
                  are shown.
                </div>
              )}
            </div>
          </div>

          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <div
              style={{
                flex: "none",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderBottom: "1px solid var(--bd)",
                background: "var(--sf2)",
              }}
            >
              <span style={{ fontSize: 11, color: "var(--mu)" }}>
                Migration script
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10.5, color: "var(--fa)" }}>
                destructive statements start unchecked
              </span>
            </div>

            <div
              style={{
                flex: "none",
                maxHeight: 190,
                overflow: "auto",
                borderBottom: "1px solid var(--bd)",
              }}
            >
              {diff && diff.statements.length > 0 ? (
                diff.statements.map((statement, index) => (
                  <StatementRow
                    key={`${statement.kind}-${index}`}
                    index={index}
                    statement={statement}
                    checked={!!selected[index]}
                    onToggle={() => toggle(index)}
                  />
                ))
              ) : (
                <div style={{ padding: "10px 8px", color: "var(--fa)", fontSize: 11.5 }}>
                  {diff ? "No statements needed." : "No script yet."}
                </div>
              )}
            </div>

            <div style={{ flex: 1, minHeight: 0 }}>
              <Editor
                height="100%"
                language="sql"
                theme={theme === "dark" ? "vs-dark" : "vs"}
                value={selectedSql || "-- No statements selected."}
                options={{
                  readOnly: true,
                  domReadOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12.5,
                  lineHeight: 19,
                  fontFamily:
                    '"JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace',
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                  wordWrap: "off",
                  padding: { top: 8, bottom: 8 },
                  renderLineHighlight: "none",
                  lineNumbersMinChars: 3,
                  glyphMargin: false,
                  folding: false,
                  smoothScrolling: true,
                  tabSize: 2,
                  overviewRulerLanes: 0,
                  hideCursorInOverviewRuler: true,
                  scrollbar: {
                    verticalScrollbarSize: 10,
                    horizontalScrollbarSize: 10,
                  },
                }}
              />
            </div>
          </div>
        </div>

        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            borderTop: "1px solid var(--bd)",
            background: "var(--sf2)",
          }}
        >
          <span style={{ fontSize: 10.5, color: "var(--fa)" }}>
            Nothing runs until you press Run in the editor.
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void copyScript()}
            disabled={!diff}
          >
            Copy script
          </button>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void saveScript()}
            disabled={!diff || saving}
          >
            {saving ? "Saving…" : "Save .sql"}
          </button>
          <button
            type="button"
            className="v2-btn v2-btn-primary"
            style={{ height: 26 }}
            onClick={openInEditor}
            disabled={!diff || !selectedSql.trim()}
          >
            Open in editor
          </button>
        </div>
      </div>
    </>
  );
}
