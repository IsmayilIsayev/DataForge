import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  backupCapabilities,
  backupDatabase,
  cancelOperation,
  errorMessage,
  listTables,
} from "../ipc";
import type {
  BackupCapabilities,
  BackupMode,
  BackupProgress,
  ConnectionMeta,
  TableInfo,
} from "../types";

interface Props {
  connection: ConnectionMeta;
  database: string;
  onClose: () => void;
}

const inputStyle = {
  height: 26,
  border: "1px solid var(--bd2)",
  borderRadius: 4,
  background: "var(--bg)",
  color: "var(--tx)",
  fontFamily: "var(--mono)",
  fontSize: 11.5,
  padding: "0 7px",
};

const checkboxStyle = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontFamily: "var(--mono)",
  fontSize: 11.5,
};

export default function BackupDialog({
  connection,
  database,
  onClose,
}: Props) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [capabilities, setCapabilities] = useState<BackupCapabilities | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<BackupMode>("both");
  const [includeDrop, setIncludeDrop] = useState(false);
  const [rowsInput, setRowsInput] = useState("500");
  const [gzip, setGzip] = useState(false);
  const [useExternal, setUseExternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [progress, setProgress] = useState<
    (BackupProgress & { cancelRequested: boolean }) | null
  >(null);

  const structureSupported = capabilities?.structure_supported ?? false;
  const externalTool = capabilities?.external_tool ?? null;
  const selectedCount = selected.size;
  const rowsPerInsert = Math.min(
    50_000,
    Math.max(1, Math.round(Number(rowsInput) || 500)),
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Promise.all([
      listTables(connection.id, database),
      backupCapabilities(connection.id),
    ])
      .then(([items, caps]) => {
        if (cancelled) return;
        const baseTables = items.filter((item) => item.kind === "table");
        setTables(baseTables);
        setSelected(new Set(baseTables.map((item) => item.name)));
        setCapabilities(caps);
        if (!caps.structure_supported) setMode("data");
      })
      .catch((loadFailure) => {
        if (!cancelled) setLoadError(errorMessage(loadFailure));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [connection.id, database]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<BackupProgress>("backup:progress", (event) => {
      const update = event.payload;
      setProgress((current) => {
        if (!current || current.id !== update.id) return current;
        return {
          ...current,
          ...update,
          cancelRequested: current.cancelRequested,
        };
      });
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

  function toggleTable(name: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function cancel() {
    if (!progress) return;
    setProgress({ ...progress, cancelRequested: true });
    try {
      await cancelOperation(progress.id);
    } catch {
      // The backup may already have finished.
    }
  }

  async function run() {
    const chosen = tables
      .filter((table) => selected.has(table.name))
      .map((table) => table.name);
    if (chosen.length === 0) {
      setBackupError("Choose at least one table to back up.");
      return;
    }

    const id = `backup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setBusy(true);
    setBackupError(null);
    setSavedPath(null);
    setProgress({
      id,
      table: null,
      table_index: 0,
      tables_total: chosen.length,
      rows: 0,
      done: false,
      cancelled: false,
      cancelRequested: false,
    });

    try {
      const saved = await backupDatabase({
        connId: connection.id,
        database,
        tables: chosen,
        mode: structureSupported ? mode : "data",
        includeDrop,
        rowsPerInsert,
        gzip,
        useExternal: !!externalTool && useExternal,
        backupId: id,
      });
      if (saved) {
        setSavedPath(saved);
      }
    } catch (failure) {
      setBackupError(errorMessage(failure));
    } finally {
      setBusy(false);
      setProgress((current) =>
        current && current.id === id ? null : current,
      );
    }
  }

  return (
    <>
      <div
        onMouseDown={() => !busy && onClose()}
        style={{ position: "fixed", inset: 0, zIndex: 74, background: "var(--ov)" }}
      />
      <div
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
          <i
            className="icon-download"
            style={{ fontSize: 14, color: "var(--ac)" }}
          />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Backup database</span>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              color: "var(--fa)",
            }}
          >
            {database}
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

        {loadError && (
          <div
            role="alert"
            style={{
              flex: "none",
              margin: "8px 12px 0",
              padding: "7px 8px",
              border: "1px solid var(--er)",
              borderRadius: 4,
              color: "var(--er)",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
            }}
          >
            {loadError}
          </div>
        )}

        {capabilities && !structureSupported && (
          <div
            role="status"
            style={{
              flex: "none",
              margin: "8px 12px 0",
              padding: "7px 8px",
              border: "1px solid var(--wn)",
              borderRadius: 4,
              color: "var(--wn)",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
            }}
          >
            Structure export is not supported for this database yet
          </div>
        )}

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: "10px 12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 500 }}>Tables</span>
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--fa)",
              }}
            >
              {loading ? "loading…" : `${selectedCount} of ${tables.length}`}
            </span>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="v2-btn"
              disabled={busy || loading || selectedCount === tables.length}
              onClick={() => setSelected(new Set(tables.map((item) => item.name)))}
              style={{ height: 22, padding: "0 8px", fontSize: 11 }}
            >
              Select all
            </button>
            <button
              type="button"
              className="v2-btn"
              disabled={busy || loading || selectedCount === 0}
              onClick={() => setSelected(new Set<string>())}
              style={{ height: 22, padding: "0 8px", fontSize: 11 }}
            >
              None
            </button>
          </div>

          <div
            style={{
              flex: 1,
              minHeight: 140,
              maxHeight: 260,
              overflow: "auto",
              border: "1px solid var(--bd2)",
              borderRadius: 4,
              background: "var(--bg)",
              padding: 6,
            }}
          >
            {loading ? (
              <div style={{ padding: 8, color: "var(--fa)", fontSize: 12 }}>
                Loading tables…
              </div>
            ) : tables.length === 0 ? (
              <div style={{ padding: 8, color: "var(--fa)", fontSize: 12 }}>
                No tables found in this database.
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
                  gap: 4,
                }}
              >
                {tables.map((table) => (
                  <label
                    key={table.name}
                    style={{
                      ...checkboxStyle,
                      padding: "3px 5px",
                      borderRadius: 3,
                      color: selected.has(table.name)
                        ? "var(--tx)"
                        : "var(--mu)",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(table.name)}
                      onChange={() => toggleTable(table.name)}
                      disabled={busy}
                    />
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={table.name}
                    >
                      {table.name}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 14,
              paddingTop: 2,
            }}
          >
            <label style={checkboxStyle}>
              Content
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value as BackupMode)}
                disabled={busy || !structureSupported}
                style={inputStyle}
              >
                <option value="both" disabled={!structureSupported}>
                  Structure and data
                </option>
                <option value="structure" disabled={!structureSupported}>
                  Structure only
                </option>
                <option value="data">Data only</option>
              </select>
            </label>
            <label style={checkboxStyle}>
              <input
                type="checkbox"
                checked={includeDrop}
                onChange={(event) => setIncludeDrop(event.target.checked)}
                disabled={busy || !structureSupported || mode === "data"}
              />
              Include DROP TABLE IF EXISTS
            </label>
            <label style={checkboxStyle}>
              <input
                type="checkbox"
                checked={gzip}
                onChange={(event) => setGzip(event.target.checked)}
                disabled={busy}
              />
              gzip (.sql.gz)
            </label>
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 14,
            }}
          >
            <label style={checkboxStyle}>
              One INSERT per
              <input
                type="number"
                min={1}
                max={50_000}
                value={rowsInput}
                onChange={(event) => setRowsInput(event.target.value)}
                disabled={busy || mode === "structure"}
                style={{ ...inputStyle, width: 80 }}
              />
              rows
            </label>
            {externalTool && !connection.ssh && (
              <label style={checkboxStyle}>
                <input
                  type="checkbox"
                  checked={useExternal}
                  onChange={(event) => setUseExternal(event.target.checked)}
                  disabled={busy}
                />
                Use {externalTool} (recommended for big databases)
              </label>
            )}
            {useExternal && externalTool && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fa)" }}>
                Progress row counts are unavailable for {externalTool}.
              </span>
            )}
          </div>
        </div>

        {progress && !progress.done && (
          <div
            role="status"
            style={{
              flex: "none",
              display: "flex",
              alignItems: "center",
              gap: 8,
              margin: "0 12px 8px",
              padding: "7px 8px",
              border: "1px solid var(--bd2)",
              borderRadius: 4,
              background: "var(--bg)",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
            }}
          >
            <i
              className="icon-download"
              style={{ fontSize: 12, color: "var(--ac)" }}
            />
            <span>
              Backing up{progress.table ? ` ${progress.table}` : ""} ·{" "}
              {progress.rows.toLocaleString("en-US")} rows
              {progress.tables_total > 0
                ? ` · table ${Math.min(
                    progress.table_index + 1,
                    progress.tables_total,
                  )}/${progress.tables_total}`
                : ""}
            </span>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="v2-btn"
              onClick={() => void cancel()}
              disabled={progress.cancelRequested || useExternal}
              title={
                useExternal
                  ? "The external dump tool cannot be cancelled from DataForge"
                  : undefined
              }
              style={{ height: 20, padding: "0 8px", fontSize: 11 }}
            >
              {progress.cancelRequested ? "Cancelling…" : "Cancel"}
            </button>
          </div>
        )}

        {savedPath && (
          <div
            role="status"
            style={{
              flex: "none",
              margin: "0 12px 8px",
              padding: "7px 8px",
              border: "1px solid var(--bd2)",
              borderRadius: 4,
              background: "var(--bg)",
              color: "var(--ok)",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              overflowWrap: "anywhere",
            }}
          >
            Backup saved to {savedPath}
          </div>
        )}

        {backupError && (
          <div
            role="alert"
            style={{
              flex: "none",
              margin: "0 12px 8px",
              padding: "7px 8px",
              border: "1px solid var(--er)",
              borderRadius: 4,
              color: "var(--er)",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              overflowWrap: "anywhere",
            }}
          >
            {backupError}
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
            disabled={busy}
          >
            Close
          </button>
          <button
            type="button"
            className="v2-btn v2-btn-primary"
            onClick={() => void run()}
            disabled={
              busy ||
              loading ||
              !!loadError ||
              selectedCount === 0
            }
          >
            {busy ? "Backing up…" : "Back up"}
          </button>
        </div>
      </div>
    </>
  );
}
