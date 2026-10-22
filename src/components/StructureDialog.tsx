import { useCallback, useEffect, useState } from "react";
import {
  addColumnSql,
  canChangeType,
  changeTypeSql,
  dropColumnSql,
  renameColumnSql,
} from "../ddl";
import { errorMessage, listColumns, runQuery } from "../ipc";
import { quoteIdentifier } from "../sql";
import type { ColumnInfo, Dialect } from "../types";

interface Props {
  connId: string;
  database: string;
  table: string;
  dialect: Dialect;
  onClose: () => void;
  onApplied: () => void;
}

export default function StructureDialog({
  connId,
  database,
  table,
  dialect,
  onClose,
  onApplied,
}: Props) {
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [mysqlCreate, setMysqlCreate] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editType, setEditType] = useState("");
  const [editNull, setEditNull] = useState(true);
  // Add-column form
  const [addName, setAddName] = useState("");
  const [addType, setAddType] = useState("");
  const [addNull, setAddNull] = useState(true);
  const [addDefault, setAddDefault] = useState("");
  // Pending confirmation
  const [pending, setPending] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    listColumns(connId, database, table)
      .then(setColumns)
      .catch((loadError) => setError(errorMessage(loadError)));

    if (dialect !== "mysql") {
      setMysqlCreate(null);
      return;
    }

    // MySQL MODIFY COLUMN replaces the whole definition. Keep the original
    // CREATE statement so DEFAULT / AUTO_INCREMENT / EXTRA survive a type change.
    const target = database
      ? `${quoteIdentifier("mysql", database)}.${quoteIdentifier("mysql", table)}`
      : quoteIdentifier("mysql", table);
    runQuery(connId, `SHOW CREATE TABLE ${target}`, 0, database)
      .then((result) => {
        const index = result.columns.findIndex(
          (column) => column.toLowerCase() === "create table",
        );
        const value =
          index >= 0 ? result.rows[0]?.[index] : result.rows[0]?.[1];
        setMysqlCreate(typeof value === "string" ? value : null);
      })
      .catch(() => setMysqlCreate(null));
  }, [connId, database, table, dialect]);

  useEffect(() => {
    reload();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reload, onClose, busy]);

  const beginEdit = (col: ColumnInfo) => {
    setError(null);
    setEditing(col.name);
    setEditName(col.name);
    setEditType(col.data_type);
    setEditNull(col.nullable);
  };

  const buildEdit = (original: ColumnInfo): string[] | null => {
    const statements: string[] = [];
    const typeChanged = editType.trim() !== original.data_type;
    const nullChanged = editNull !== original.nullable;

    if ((typeChanged || nullChanged) && canChangeType(dialect)) {
      // Use the (possibly) new name so the statement applies after a rename.
      const name = editName.trim() || original.name;
      const sql = changeTypeSql(
        dialect,
        database,
        table,
        name,
        editType.trim(),
        editNull,
        dialect === "mysql" && mysqlCreate
          ? {
              definition: mysqlCreate,
              currentType: original.data_type,
              currentName: original.name,
            }
          : undefined,
      );
      if (!sql) {
        setError(
          "Cannot change this column because its full definition (DEFAULT / AUTO_INCREMENT) could not be read. Reload the table and try again.",
        );
        return null;
      }
      statements.push(sql);
    }

    if (editName.trim() && editName.trim() !== original.name) {
      // Rename after MODIFY so the definition still references the old name.
      statements.push(
        renameColumnSql(dialect, database, table, original.name, editName.trim()),
      );
    }
    return statements;
  };

  const run = async (statements: string[]) => {
    if (statements.length === 0) {
      setPending(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (const sql of statements) {
        await runQuery(connId, sql, 0, database);
      }
      setPending(null);
      setEditing(null);
      setAddName("");
      setAddType("");
      setAddDefault("");
      setAddNull(true);
      reload();
      onApplied();
    } catch (runError) {
      setError(errorMessage(runError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        onMouseDown={() => !busy && onClose()}
        style={{ position: "fixed", inset: 0, zIndex: 70, background: "var(--ov)" }}
      />
      <div
        style={{
          position: "fixed",
          left: "50%",
          top: "9%",
          transform: "translateX(-50%)",
          zIndex: 71,
          width: 680,
          maxWidth: "94vw",
          maxHeight: "82vh",
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
            padding: "11px 12px",
            borderBottom: "1px solid var(--bd)",
          }}
        >
          <i className="icon-table-2" style={{ fontSize: 14, color: "var(--fa)" }} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Design table</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fa)" }}>
            {database}.{table}
          </span>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {/* Column list */}
          {columns.map((col) => {
            const isEditing = editing === col.name;
            return (
              <div
                key={col.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "5px 12px",
                  borderBottom: "1px solid var(--bd)",
                }}
              >
                {isEditing ? (
                  <>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      spellCheck={false}
                      style={inputStyle(170)}
                    />
                    <input
                      value={editType}
                      onChange={(e) => setEditType(e.target.value)}
                      disabled={!canChangeType(dialect)}
                      title={
                        canChangeType(dialect)
                          ? "Column type"
                          : "Type changes aren't supported on this engine"
                      }
                      spellCheck={false}
                      style={inputStyle(150)}
                    />
                    <label style={labelStyle}>
                      <input
                        type="checkbox"
                        checked={editNull}
                        disabled={!canChangeType(dialect)}
                        onChange={(e) => setEditNull(e.target.checked)}
                      />
                      NULL
                    </label>
                    <div style={{ flex: 1 }} />
                    <button
                      type="button"
                      className="v2-btn v2-btn-primary"
                      disabled={busy}
                      onClick={() => {
                        const statements = buildEdit(col);
                        if (!statements) return;
                        if (statements.length === 0) {
                          setEditing(null);
                        } else {
                          setPending(statements);
                        }
                      }}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="v2-btn"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <span
                      style={{
                        width: 170,
                        flex: "none",
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        color: "var(--tx)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {col.key === "PRI" && (
                        <i
                          className="icon-key-round"
                          style={{ fontSize: 10, color: "var(--fa)", marginRight: 4 }}
                        />
                      )}
                      {col.name}
                    </span>
                    <span style={{ width: 150, flex: "none", fontSize: 11.5, color: "var(--mu)" }}>
                      {col.data_type}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--fa)" }}>
                      {col.nullable ? "NULL" : "NOT NULL"}
                    </span>
                    <div style={{ flex: 1 }} />
                    <button
                      type="button"
                      className="v2-btn"
                      disabled={busy}
                      onClick={() => beginEdit(col)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="v2-btn"
                      disabled={busy}
                      onClick={() =>
                        setPending([dropColumnSql(dialect, database, table, col.name)])
                      }
                      style={{ color: "var(--er)" }}
                    >
                      Drop
                    </button>
                  </>
                )}
              </div>
            );
          })}

          {/* Add column */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              background: "var(--sf2)",
            }}
          >
            <i className="icon-plus" style={{ fontSize: 12, color: "var(--fa)", flex: "none" }} />
            <input
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="new_column"
              spellCheck={false}
              style={inputStyle(150)}
            />
            <input
              value={addType}
              onChange={(e) => setAddType(e.target.value)}
              placeholder={dialect === "postgres" ? "text" : "VARCHAR(255)"}
              spellCheck={false}
              style={inputStyle(130)}
            />
            <input
              value={addDefault}
              onChange={(e) => setAddDefault(e.target.value)}
              placeholder="default (optional)"
              spellCheck={false}
              style={inputStyle(120)}
            />
            <label style={labelStyle}>
              <input
                type="checkbox"
                checked={addNull}
                onChange={(e) => setAddNull(e.target.checked)}
              />
              NULL
            </label>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="v2-btn v2-btn-primary"
              disabled={busy || !addName.trim() || !addType.trim()}
              onClick={() =>
                setPending([
                  addColumnSql(dialect, database, table, {
                    name: addName.trim(),
                    type: addType.trim(),
                    nullable: addNull,
                    default: addDefault.trim() || undefined,
                  }),
                ])
              }
            >
              Add column
            </button>
          </div>
        </div>

        {error && (
          <div
            style={{
              flex: "none",
              margin: "8px 12px 0",
              padding: "7px 8px",
              border: "1px solid var(--er)",
              borderRadius: 4,
              background: "var(--ers)",
              color: "var(--er)",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
            }}
            role="alert"
          >
            {error}
          </div>
        )}

        {/* SQL preview / confirm */}
        {pending && (
          <div
            style={{
              flex: "none",
              padding: "10px 12px",
              borderTop: "1px solid var(--bd)",
              background: "var(--bg)",
            }}
          >
            <div style={{ fontSize: 11, color: "var(--fa)", marginBottom: 6 }}>
              This will run against the live database:
            </div>
            <pre
              style={{
                margin: 0,
                padding: "8px 10px",
                maxHeight: 120,
                overflow: "auto",
                background: "var(--sf2)",
                border: "1px solid var(--bd)",
                borderRadius: 4,
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                color: "var(--tx)",
                whiteSpace: "pre-wrap",
              }}
            >
              {pending.join(";\n")}
            </pre>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <button type="button" className="v2-btn" disabled={busy} onClick={() => setPending(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="v2-btn v2-btn-primary"
                disabled={busy}
                onClick={() => void run(pending)}
              >
                {busy ? "Running…" : "Run"}
              </button>
            </div>
          </div>
        )}

        <div
          style={{
            flex: "none",
            display: "flex",
            justifyContent: "flex-end",
            padding: "10px 12px",
            borderTop: "1px solid var(--bd)",
          }}
        >
          <button type="button" className="v2-btn" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}

const labelStyle = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flex: "none" as const,
  fontSize: 11,
  color: "var(--mu)",
};

function inputStyle(width: number) {
  return {
    width,
    flex: "none" as const,
    height: 26,
    border: "1px solid var(--bd2)",
    borderRadius: 4,
    background: "var(--bg)",
    color: "var(--tx)",
    padding: "0 8px",
    fontFamily: "var(--mono)",
    fontSize: 12,
  };
}
