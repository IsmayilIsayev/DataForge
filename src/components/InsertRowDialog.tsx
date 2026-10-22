import { useEffect, useRef, useState } from "react";
import { errorMessage, insertRow } from "../ipc";
import type { CellRef } from "../ipc";
import { sqliteBooleanLiteral } from "../sql";
import type { ColumnInfo, Dialect } from "../types";

interface Props {
  connId: string;
  database: string;
  table: string;
  dialect: Dialect;
  columns: ColumnInfo[];
  onClose: () => void;
  onInserted: () => void;
}

type Mode = "value" | "null" | "default";

interface FieldState {
  mode: Mode;
  text: string;
}

export default function InsertRowDialog({
  connId,
  database,
  table,
  dialect,
  columns,
  onClose,
  onInserted,
}: Props) {
  const [fields, setFields] = useState<Record<string, FieldState>>(() => {
    const initial: Record<string, FieldState> = {};
    for (const column of columns) {
      // Start every column on DEFAULT (including primary keys, which are often
      // auto-increment). Columns the user does not touch are omitted from the
      // INSERT so the database's own defaults apply.
      initial[column.name] = { mode: "default", text: "" };
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const setField = (name: string, patch: Partial<FieldState>) =>
    setFields((current) => ({
      ...current,
      [name]: { ...current[name], ...patch },
    }));

  const save = async () => {
    const values: CellRef[] = [];
    for (const column of columns) {
      const field = fields[column.name];
      if (field.mode === "default") continue; // let the DB fill it
      let value: string | null =
        field.mode === "null" ? null : field.text;
      if (
        value !== null &&
        dialect === "sqlite" &&
        /bool/i.test(column.data_type)
      ) {
        // SQLite BOOLEAN has NUMERIC affinity: the text 'false' would be
        // stored verbatim, while 0/1 behave as a boolean.
        value = sqliteBooleanLiteral(value) ?? value;
      }
      values.push({ column: column.name, value });
    }
    setSaving(true);
    setError(null);
    try {
      await insertRow(connId, database, table, values);
      onInserted();
      onClose();
    } catch (insertError) {
      setError(errorMessage(insertError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div
        onMouseDown={() => !saving && onClose()}
        style={{ position: "fixed", inset: 0, zIndex: 70, background: "var(--ov)" }}
      />
      <div
        style={{
          position: "fixed",
          left: "50%",
          top: "12%",
          transform: "translateX(-50%)",
          zIndex: 71,
          width: 560,
          maxWidth: "92vw",
          maxHeight: "76vh",
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
          <i className="icon-plus" style={{ fontSize: 14, color: "var(--fa)" }} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Insert row</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fa)" }}>
            {database}.{table}
          </span>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "4px 0" }}>
          {columns.map((column, index) => {
            const field = fields[column.name];
            const disabled = field.mode === "null";
            const muted = field.mode !== "value";
            return (
              <div
                key={column.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 12px",
                }}
              >
                <div style={{ width: 150, flex: "none", minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                      color: "var(--tx)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={`${column.name} · ${column.data_type}`}
                  >
                    {column.key === "PRI" && (
                      <i
                        className="icon-key-round"
                        style={{ fontSize: 10, color: "var(--fa)", marginRight: 4 }}
                      />
                    )}
                    {column.name}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--fa)" }}>
                    {column.data_type}
                    {!column.nullable && " · NOT NULL"}
                  </div>
                </div>
                <input
                  ref={index === 0 ? firstRef : undefined}
                  value={field.mode === "value" ? field.text : ""}
                  disabled={disabled}
                  placeholder={field.mode === "null" ? "NULL" : field.mode === "default" ? "DEFAULT" : ""}
                  onChange={(event) => {
                    const text = event.target.value;
                    // Typing a value switches the field to VALUE; clearing it
                    // back to empty restores DEFAULT so untouched columns stay
                    // omitted from the INSERT.
                    setField(column.name, {
                      text,
                      mode: text === "" ? "default" : "value",
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void save();
                    }
                  }}
                  spellCheck={false}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    height: 26,
                    border: "1px solid var(--bd2)",
                    borderRadius: 4,
                    background: muted ? "var(--sf2)" : "var(--bg)",
                    color: muted ? "var(--fa)" : "var(--tx)",
                    fontStyle: muted ? "italic" : "normal",
                    padding: "0 8px",
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                  }}
                />
                <MiniToggle
                  label="NULL"
                  active={field.mode === "null"}
                  disabled={!column.nullable}
                  onClick={() =>
                    setField(column.name, {
                      mode: field.mode === "null" ? "value" : "null",
                    })
                  }
                />
                <MiniToggle
                  label="DEFAULT"
                  active={field.mode === "default"}
                  onClick={() =>
                    setField(column.name, {
                      mode: field.mode === "default" ? "value" : "default",
                    })
                  }
                />
              </div>
            );
          })}
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
          <button
            type="button"
            className="v2-btn"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="v2-btn v2-btn-primary"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "Inserting…" : "Insert row"}
          </button>
        </div>
      </div>
    </>
  );
}

function MiniToggle({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "Column is NOT NULL" : label}
      style={{
        flex: "none",
        height: 20,
        padding: "0 6px",
        border: `1px solid ${active ? "var(--acd)" : "var(--bd2)"}`,
        borderRadius: 3,
        background: active ? "var(--acd)" : "transparent",
        color: active ? "#fff" : disabled ? "var(--bd2)" : "var(--mu)",
        fontSize: 9.5,
        letterSpacing: ".03em",
        cursor: disabled ? "not-allowed" : "default",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}
