import { useEffect, useState } from "react";
import { createTableSql } from "../ddl";
import type { ColumnSpec } from "../ddl";
import { errorMessage, runQuery } from "../ipc";
import type { Dialect } from "../types";

interface Props {
  connId: string;
  database: string;
  dialect: Dialect;
  onClose: () => void;
  onCreated: (table: string) => void;
}

interface Row extends ColumnSpec {
  default: string;
}

const emptyRow = (): Row => ({
  name: "",
  type: "",
  nullable: true,
  primaryKey: false,
  default: "",
});

export default function CreateTableDialog({
  connId,
  database,
  dialect,
  onClose,
  onCreated,
}: Props) {
  const [name, setName] = useState("");
  const [rows, setRows] = useState<Row[]>([
    { ...emptyRow(), name: "id", type: dialect === "postgres" ? "serial" : "INT", primaryKey: false, nullable: false },
    emptyRow(),
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const setRow = (index: number, patch: Partial<Row>) =>
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );

  const cols = rows.filter((row) => row.name.trim() && row.type.trim());
  const canCreate = name.trim().length > 0 && cols.length > 0;
  const preview = canCreate
    ? createTableSql(
        dialect,
        database,
        name.trim(),
        cols.map((row) => ({
          name: row.name.trim(),
          type: row.type.trim(),
          nullable: row.nullable,
          primaryKey: row.primaryKey,
          default: row.default.trim() || undefined,
        })),
      )
    : "";

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      await runQuery(connId, preview, 0, database);
      onCreated(name.trim());
      onClose();
    } catch (createError) {
      setError(errorMessage(createError));
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
          width: 700,
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
          <span style={{ fontSize: 13, fontWeight: 500 }}>Create table</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fa)" }}>
            in {database}
          </span>
          <div style={{ flex: 1 }} />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="table_name"
            autoFocus
            spellCheck={false}
            style={{
              width: 220,
              height: 28,
              border: "1px solid var(--bd2)",
              borderRadius: 4,
              background: "var(--bg)",
              color: "var(--tx)",
              padding: "0 8px",
              fontFamily: "var(--mono)",
              fontSize: 12.5,
            }}
          />
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "4px 0" }}>
          <div
            style={{
              display: "flex",
              gap: 8,
              padding: "4px 12px",
              fontSize: 10,
              letterSpacing: ".03em",
              color: "var(--fa)",
            }}
          >
            <span style={{ width: 160, flex: "none" }}>NAME</span>
            <span style={{ width: 140, flex: "none" }}>TYPE</span>
            <span style={{ width: 120, flex: "none" }}>DEFAULT</span>
            <span style={{ width: 52, flex: "none" }}>NULL</span>
            <span style={{ width: 36, flex: "none" }}>PK</span>
          </div>
          {rows.map((row, index) => (
            <div
              key={index}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 12px" }}
            >
              <input
                value={row.name}
                onChange={(e) => setRow(index, { name: e.target.value })}
                spellCheck={false}
                style={inputStyle(160)}
              />
              <input
                value={row.type}
                onChange={(e) => setRow(index, { type: e.target.value })}
                placeholder={dialect === "postgres" ? "text" : "VARCHAR(255)"}
                spellCheck={false}
                style={inputStyle(140)}
              />
              <input
                value={row.default}
                onChange={(e) => setRow(index, { default: e.target.value })}
                spellCheck={false}
                style={inputStyle(120)}
              />
              <span style={{ width: 52, flex: "none", textAlign: "center" }}>
                <input
                  type="checkbox"
                  checked={row.nullable}
                  onChange={(e) => setRow(index, { nullable: e.target.checked })}
                />
              </span>
              <span style={{ width: 36, flex: "none", textAlign: "center" }}>
                <input
                  type="checkbox"
                  checked={!!row.primaryKey}
                  onChange={(e) =>
                    setRow(index, {
                      primaryKey: e.target.checked,
                      nullable: e.target.checked ? false : row.nullable,
                    })
                  }
                />
              </span>
              <button
                type="button"
                className="v2-btn"
                title="Remove column"
                disabled={rows.length === 1}
                onClick={() => setRows((cur) => cur.filter((_, i) => i !== index))}
                style={{ flex: "none" }}
              >
                ✕
              </button>
            </div>
          ))}
          <div style={{ padding: "4px 12px" }}>
            <button
              type="button"
              className="v2-btn"
              onClick={() => setRows((cur) => [...cur, emptyRow()])}
            >
              + Add column
            </button>
          </div>
        </div>

        {error && (
          <div
            style={{
              flex: "none",
              margin: "0 12px 8px",
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

        {preview && (
          <pre
            style={{
              flex: "none",
              margin: "0 12px 8px",
              padding: "8px 10px",
              maxHeight: 110,
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
            {preview}
          </pre>
        )}

        <div
          style={{
            flex: "none",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 12px",
            borderTop: "1px solid var(--bd)",
          }}
        >
          <button type="button" className="v2-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="v2-btn v2-btn-primary"
            onClick={() => void create()}
            disabled={busy || !canCreate}
          >
            {busy ? "Creating…" : "Create table"}
          </button>
        </div>
      </div>
    </>
  );
}

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
