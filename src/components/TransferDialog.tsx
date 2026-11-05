import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelOperation,
  connectConnection,
  errorMessage,
  listDatabases,
  listTables,
  transferTables,
  type TransferIfExists,
} from "../ipc";
import { isProduction, isReadOnly } from "../environment";
import { useAppStore } from "../store";
import type {
  ConnectionMeta,
  TableInfo,
  TransferProgress,
  TransferSummary,
} from "../types";

interface Props {
  connection: ConnectionMeta;
  database: string;
  onClose: () => void;
  onDone: (connection: ConnectionMeta, database: string) => void;
}

const WRITABLE = new Set(["mysql", "postgres", "sqlite", "mssql"]);

const inputStyle = {
  height: 26,
  border: "1px solid var(--bd2)",
  borderRadius: 4,
  background: "var(--bg)",
  color: "var(--tx)",
  fontFamily: "var(--mono)",
  fontSize: 11.5,
  padding: "0 7px",
  minWidth: 0,
};

const labelStyle = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontFamily: "var(--mono)",
  fontSize: 11.5,
};

const boxStyle = {
  flex: "none" as const,
  margin: "0 12px 8px",
  padding: "7px 8px",
  border: "1px solid var(--bd2)",
  borderRadius: 4,
  background: "var(--bg)",
  fontFamily: "var(--mono)",
  fontSize: 11.5,
  overflowWrap: "anywhere" as const,
};

export default function TransferDialog({
  connection,
  database,
  onClose,
  onDone,
}: Props) {
  const connections = useAppStore((state) => state.connections);
  const targets = connections.filter((item) => WRITABLE.has(item.dialect));

  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [targetId, setTargetId] = useState(
    targets.find((item) => item.id !== connection.id)?.id ?? targets[0]?.id ?? "",
  );
  const [databases, setDatabases] = useState<string[]>([]);
  const [targetDb, setTargetDb] = useState("");
  const [ifExists, setIfExists] = useState<TransferIfExists>("append");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<TransferSummary | null>(null);
  const [progress, setProgress] = useState<
    (TransferProgress & { cancelRequested: boolean }) | null
  >(null);

  const target = targets.find((item) => item.id === targetId) ?? null;
  const sameDb = target?.id === connection.id && targetDb === database;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listTables(connection.id, database)
      .then((items) => {
        if (cancelled) return;
        const base = items.filter((item) => item.kind === "table");
        setTables(base);
        setSelected(new Set(base.map((item) => item.name)));
      })
      .catch((failure) => !cancelled && setError(errorMessage(failure)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [connection.id, database]);

  useEffect(() => {
    const target = useAppStore
      .getState()
      .connections.find((item) => item.id === targetId);
    if (!target) return;
    let cancelled = false;
    setDatabases([]);
    setTargetDb("");
    (async () => {
      if (!useAppStore.getState().connected[target.id]) {
        await connectConnection(target.id);
        useAppStore.getState().setConnected(target.id, true);
      }
      const names = await listDatabases(target.id);
      if (cancelled) return;
      setDatabases(names);
      const preferred =
        names.find((name) => name === target.database) ??
        names.find((name) => !(target.id === connection.id && name === database)) ??
        names[0] ??
        "";
      setTargetDb(preferred);
    })().catch((failure) => !cancelled && setError(errorMessage(failure)));
    return () => {
      cancelled = true;
    };
  }, [targetId, connection.id, database]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<TransferProgress>("transfer:progress", (event) => {
      const update = event.payload;
      setProgress((current) =>
        current && current.id === update.id
          ? { ...update, cancelRequested: current.cancelRequested }
          : current,
      );
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // Only available inside Tauri.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  function toggle(name: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function run() {
    if (!target || !targetDb) return;
    const chosen = tables
      .filter((table) => selected.has(table.name))
      .map((table) => table.name);
    if (chosen.length === 0) {
      setError("Choose at least one table to transfer.");
      return;
    }
    if (isProduction(target)) {
      const confirmed = await useAppStore.getState().requestProdConfirm({
        connectionName: target.name,
        databaseName: targetDb,
        statements: [
          {
            sql: `TRANSFER ${chosen.length} TABLE(S) FROM ${connection.name}.${database}`,
            kind: "ddl",
            keyword: ifExists === "replace" ? "DELETE" : "INSERT",
            hasWhere: false,
            requiresTypedConfirm: true,
          },
        ],
        title: "Transfer data into production",
        note: `${chosen.length} table(s) will be written into ${targetDb}${
          ifExists === "replace" ? ", replacing the rows of existing tables" : ""
        }. Type the database name to confirm.`,
      });
      if (!confirmed) return;
    }

    const id = `transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setBusy(true);
    setError(null);
    setSummary(null);
    setProgress({
      id,
      table: "",
      table_index: 0,
      tables_total: chosen.length,
      rows: 0,
      done: false,
      cancelRequested: false,
    });
    try {
      const result = await transferTables({
        sourceConn: connection.id,
        sourceDb: database,
        targetConn: target.id,
        targetDb,
        tables: chosen,
        ifExists,
        transferId: id,
      });
      setSummary(result);
      onDone(target, targetDb);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function cancel() {
    if (!progress) return;
    setProgress({ ...progress, cancelRequested: true });
    try {
      await cancelOperation(progress.id);
    } catch {
      // The transfer may already have finished.
    }
  }

  const failed = summary?.tables.filter((item) => item.error) ?? [];
  const copied = summary?.tables.filter((item) => !item.error && !item.skipped) ?? [];

  return (
    <>
      <div
        onMouseDown={() => !busy && onClose()}
        style={{ position: "fixed", inset: 0, zIndex: 74, background: "var(--ov)" }}
      />
      <div
        role="dialog"
        aria-label="Transfer data"
        style={{
          position: "fixed",
          left: "50%",
          top: "7%",
          transform: "translateX(-50%)",
          zIndex: 75,
          width: 760,
          maxWidth: "94vw",
          maxHeight: "88vh",
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
          <i className="icon-arrow-right-left" style={{ fontSize: 14, color: "var(--ac)" }} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Transfer data</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fa)" }}>
            {connection.name} · {database}
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="v2-btn"
            onClick={onClose}
            disabled={busy}
            style={{ height: 22, padding: "0 8px", fontSize: 11 }}
          >
            Close
          </button>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: "10px 12px",
            overflow: "auto",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            <label style={labelStyle}>
              To
              <select
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                disabled={busy}
                style={{ ...inputStyle, maxWidth: 220 }}
              >
                {targets.length === 0 && <option value="">No MySQL/PostgreSQL/SQLite/SQL Server connection</option>}
                {targets.map((item) => (
                  <option key={item.id} value={item.id} disabled={isReadOnly(item)}>
                    {item.name}
                    {isReadOnly(item) ? " (read-only)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label style={labelStyle}>
              Database
              <select
                value={targetDb}
                onChange={(event) => setTargetDb(event.target.value)}
                disabled={busy || databases.length === 0}
                style={{ ...inputStyle, maxWidth: 200 }}
              >
                {databases.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label style={labelStyle}>
              Existing tables
              <select
                value={ifExists}
                onChange={(event) => setIfExists(event.target.value as TransferIfExists)}
                disabled={busy}
                style={inputStyle}
              >
                <option value="append">Add rows</option>
                <option value="replace">Replace rows</option>
                <option value="skip">Skip</option>
              </select>
            </label>
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fa)" }}>
            Missing tables are created with their columns and primary key. Each table is
            copied in its own transaction: a failing table is rolled back and the rest
            continue.
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 500 }}>Tables</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fa)" }}>
              {loading ? "loading…" : `${selected.size} of ${tables.length}`}
            </span>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="v2-btn"
              disabled={busy || loading || selected.size === tables.length}
              onClick={() => setSelected(new Set(tables.map((item) => item.name)))}
              style={{ height: 22, padding: "0 8px", fontSize: 11 }}
            >
              Select all
            </button>
            <button
              type="button"
              className="v2-btn"
              disabled={busy || loading || selected.size === 0}
              onClick={() => setSelected(new Set<string>())}
              style={{ height: 22, padding: "0 8px", fontSize: 11 }}
            >
              None
            </button>
          </div>
          <div
            style={{
              minHeight: 120,
              maxHeight: 240,
              overflow: "auto",
              border: "1px solid var(--bd2)",
              borderRadius: 4,
              background: "var(--bg)",
              padding: 6,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
              alignContent: "start",
              gap: 4,
            }}
          >
            {!loading && tables.length === 0 && (
              <div style={{ padding: 8, color: "var(--fa)", fontSize: 12 }}>
                No tables found in this database.
              </div>
            )}
            {tables.map((table) => (
              <label
                key={table.name}
                style={{
                  ...labelStyle,
                  padding: "3px 5px",
                  color: selected.has(table.name) ? "var(--tx)" : "var(--mu)",
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(table.name)}
                  onChange={() => toggle(table.name)}
                  disabled={busy}
                />
                <span
                  title={table.name}
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {table.name}
                </span>
              </label>
            ))}
          </div>
        </div>

        {progress && (
          <div role="status" style={{ ...boxStyle, display: "flex", alignItems: "center", gap: 8 }}>
            <span>
              Copying{progress.table ? ` ${progress.table}` : ""} ·{" "}
              {progress.rows.toLocaleString("en-US")} rows · table{" "}
              {Math.min(progress.table_index + 1, progress.tables_total)}/{progress.tables_total}
            </span>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="v2-btn"
              onClick={() => void cancel()}
              disabled={progress.cancelRequested}
              style={{ height: 20, padding: "0 8px", fontSize: 11 }}
            >
              {progress.cancelRequested ? "Cancelling…" : "Cancel"}
            </button>
          </div>
        )}

        {summary && (
          <div role="status" style={{ ...boxStyle, maxHeight: 160, overflow: "auto" }}>
            <div style={{ color: failed.length ? "var(--wn)" : "var(--ok)", marginBottom: 4 }}>
              {summary.cancelled ? "Cancelled. " : ""}
              {copied.length} table(s) copied,{" "}
              {copied.reduce((sum, item) => sum + item.rows, 0).toLocaleString("en-US")} rows
              {failed.length ? `, ${failed.length} failed` : ""}
            </div>
            {summary.tables.map((item) => (
              <div key={item.table} style={{ color: item.error ? "var(--er)" : "var(--mu)" }}>
                {item.table}:{" "}
                {item.error
                  ? item.error
                  : item.skipped
                    ? "skipped (exists)"
                    : `${item.rows.toLocaleString("en-US")} rows${item.created ? ", created" : ""}${
                        item.dropped_columns.length
                          ? ` · not in target: ${item.dropped_columns.join(", ")}`
                          : ""
                      }`}
              </div>
            ))}
          </div>
        )}

        {error && (
          <div role="alert" style={{ ...boxStyle, border: "1px solid var(--er)", color: "var(--er)" }}>
            {error}
          </div>
        )}

        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 12px",
            borderTop: "1px solid var(--bd)",
          }}
        >
          {sameDb && (
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--wn)", marginRight: "auto" }}>
              Choose a different target database.
            </span>
          )}
          <button type="button" className="v2-btn" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button
            type="button"
            className="v2-btn v2-btn-primary"
            onClick={() => void run()}
            disabled={busy || loading || !target || !targetDb || sameDb || selected.size === 0}
          >
            {busy ? "Transferring…" : "Transfer"}
          </button>
        </div>
      </div>
    </>
  );
}
