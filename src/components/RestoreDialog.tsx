import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelOperation,
  errorMessage,
  listDatabases,
  previewRestore,
  restoreDatabase,
} from "../ipc";
import type {
  ConnectionMeta,
  RestorePreview,
  RestoreProgress,
  RestoreSummary,
} from "../types";
import { isProduction, isReadOnly } from "../environment";
import { useAppStore } from "../store";

interface Props {
  connection: ConnectionMeta;
  database: string;
  path: string;
  onClose: () => void;
  onRestored: (database: string) => void;
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function noteFor(connection: ConnectionMeta, stopOnError: boolean): string {
  if (connection.dialect === "mysql") {
    return "MySQL runs statements without a transaction; DDL commits automatically, so a failed restore can leave partial changes.";
  }
  if (connection.dialect === "mssql") {
    return "SQL Server runs statements one by one without a transaction; a failed restore can leave partial changes.";
  }
  if (connection.dialect === "clickhouse") {
    return "ClickHouse runs statements one by one without a transaction; a failed restore can leave partial changes.";
  }
  if (stopOnError) {
    return "PostgreSQL/SQLite run the whole dump in one transaction. On the first error every change is rolled back.";
  }
  return "Continue mode is not transactional: statements that succeed stay applied even when later statements fail.";
}

export default function RestoreDialog({
  connection,
  database,
  path,
  onClose,
  onRestored,
}: Props) {
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [previewing, setPreviewing] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [databasesError, setDatabasesError] = useState<string | null>(null);
  const [target, setTarget] = useState(database);
  const [stopOnError, setStopOnError] = useState(true);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [summary, setSummary] = useState<RestoreSummary | null>(null);
  const [progress, setProgress] = useState<
    (RestoreProgress & { cancelRequested: boolean }) | null
  >(null);

  const readOnly = isReadOnly(connection);
  const canRun =
    !busy &&
    !readOnly &&
    !!preview &&
    preview.total_statements > 0 &&
    (!databases.length || target !== "");

  useEffect(() => {
    let cancelled = false;
    setPreviewing(true);
    setPreviewError(null);
    previewRestore(connection.id, path)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((error) => {
        if (!cancelled) setPreviewError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection.id, path]);

  useEffect(() => {
    let cancelled = false;
    setDatabasesError(null);
    listDatabases(connection.id)
      .then((items) => {
        if (!cancelled) setDatabases(items);
      })
      .catch((error) => {
        if (!cancelled) setDatabasesError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [connection.id]);

  useEffect(() => {
    setTarget((current) => {
      if (current && databases.includes(current)) return current;
      if (database && databases.includes(database)) return database;
      return databases[0] ?? current;
    });
  }, [databases, database]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<RestoreProgress>("restore:progress", (event) => {
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

  async function cancel() {
    if (!progress) return;
    setProgress({ ...progress, cancelRequested: true });
    try {
      await cancelOperation(progress.id);
    } catch {
      // The restore may already have finished.
    }
  }

  async function confirmProduction(): Promise<boolean> {
    if (!isProduction(connection)) return true;
    return useAppStore.getState().requestProdConfirm({
      connectionName: connection.name,
      databaseName: target,
      statements: [
        {
          sql: `RESTORE FROM ${path}`,
          kind: "ddl",
          keyword: "RESTORE",
          hasWhere: false,
          requiresTypedConfirm: true,
        },
      ],
      title: "Restore database on production",
      note: `This will run ${
        preview?.total_statements.toLocaleString("en-US") ?? "the"
      } statements from ${path} against ${target}. Type the database name to confirm.`,
    });
  }

  async function run() {
    if (!canRun || !preview) return;
    setRunError(null);
    setSummary(null);

    try {
      const confirmed = await confirmProduction();
      if (!confirmed) return;
    } catch (error) {
      setRunError(errorMessage(error));
      return;
    }

    const id = `restore-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setBusy(true);
    setProgress({
      id,
      statements: 0,
      bytes_read: 0,
      total_bytes: preview.total_bytes,
      done: false,
      cancelled: false,
      cancelRequested: false,
    });

    try {
      const result = await restoreDatabase({
        connId: connection.id,
        database: target,
        path,
        stopOnError,
        restoreId: id,
      });
      setSummary(result);
      if (result.statements > 0) onRestored(target);
    } catch (error) {
      setRunError(errorMessage(error));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const percent =
    progress && progress.total_bytes > 0
      ? Math.min(100, (progress.bytes_read / progress.total_bytes) * 100)
      : 0;

  return (
    <>
      <div
        onMouseDown={() => !busy && onClose()}
        style={{ position: "fixed", inset: 0, zIndex: 76, background: "var(--ov)" }}
      />
      <div
        style={{
          position: "fixed",
          left: "50%",
          top: "5%",
          transform: "translateX(-50%)",
          zIndex: 77,
          width: 820,
          maxWidth: "94vw",
          maxHeight: "90vh",
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
            className="icon-upload"
            style={{ fontSize: 14, color: "var(--ac)" }}
          />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Restore database</span>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              color: "var(--fa)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={path}
          >
            {path}
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

        {(previewError || databasesError) && (
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
            {previewError ?? databasesError}
          </div>
        )}

        {readOnly && (
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
            This connection is read-only — restore is disabled.
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
            overflow: "auto",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14 }}>
            <label style={checkboxStyle}>
              Target
              <select
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                disabled={busy || databases.length === 0}
                style={inputStyle}
              >
                {databases.length === 0 && (
                  <option value={target}>{target || "default database"}</option>
                )}
                {databases.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            {preview && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fa)" }}>
                {formatBytes(preview.total_bytes)} ·{" "}
                {preview.gzip ? "gzip" : "plain SQL"} ·{" "}
                {preview.total_statements.toLocaleString("en-US")} statements
              </span>
            )}
            {previewing && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fa)" }}>
                Scanning file…
              </span>
            )}
          </div>

          {preview && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 14,
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                color: "var(--mu)",
              }}
            >
              <span>
                CREATE <strong style={{ color: "var(--tx)" }}>{preview.create.toLocaleString("en-US")}</strong>
              </span>
              <span>
                INSERT <strong style={{ color: "var(--tx)" }}>{preview.insert.toLocaleString("en-US")}</strong>
              </span>
              <span>
                other <strong style={{ color: "var(--tx)" }}>{preview.other.toLocaleString("en-US")}</strong>
              </span>
            </div>
          )}

          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 500 }}>Preview</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fa)" }}>
                first {preview?.statements.length ?? 0} statements, 200 characters each
              </span>
            </div>
            <div
              style={{
                maxHeight: 230,
                overflow: "auto",
                border: "1px solid var(--bd2)",
                borderRadius: 4,
                background: "var(--bg)",
                padding: 6,
              }}
            >
              {previewing ? (
                <div style={{ padding: 8, color: "var(--fa)", fontSize: 12 }}>
                  Reading the dump…
                </div>
              ) : preview && preview.statements.length > 0 ? (
                preview.statements.map((statement) => (
                  <div
                    key={statement.number}
                    style={{
                      display: "flex",
                      gap: 8,
                      padding: "3px 4px",
                      borderBottom: "1px solid var(--bd)",
                    }}
                  >
                    <span
                      style={{
                        flex: "none",
                        width: 46,
                        textAlign: "right",
                        fontFamily: "var(--mono)",
                        fontSize: 10.5,
                        color: "var(--fa)",
                      }}
                    >
                      {statement.number}
                    </span>
                    <code
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 11,
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                        color: "var(--tx)",
                      }}
                    >
                      {statement.sql}
                    </code>
                  </div>
                ))
              ) : (
                <div style={{ padding: 8, color: "var(--fa)", fontSize: 12 }}>
                  No SQL statements found in this file.
                </div>
              )}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 16,
            }}
          >
            <label style={checkboxStyle}>
              <input
                type="radio"
                name="restore-error-mode"
                checked={stopOnError}
                onChange={() => setStopOnError(true)}
                disabled={busy}
              />
              Stop on first error
            </label>
            <label style={checkboxStyle}>
              <input
                type="radio"
                name="restore-error-mode"
                checked={!stopOnError}
                onChange={() => setStopOnError(false)}
                disabled={busy}
              />
              Continue and report errors (first 100)
            </label>
          </div>

          <div
            style={{
              padding: "7px 8px",
              border: "1px solid var(--bd2)",
              borderRadius: 4,
              background: "var(--bg)",
              color: "var(--fa)",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              lineHeight: 1.5,
            }}
          >
            {noteFor(connection, stopOnError)}
          </div>

          {progress && !progress.done && (
            <div
              role="status"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "7px 8px",
                border: "1px solid var(--bd2)",
                borderRadius: 4,
                background: "var(--bg)",
                fontFamily: "var(--mono)",
                fontSize: 11.5,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <i className="icon-refresh-cw" style={{ fontSize: 12, color: "var(--ac)" }} />
                <span>
                  {progress.statements.toLocaleString("en-US")} statements ·{" "}
                  {formatBytes(progress.bytes_read)} / {formatBytes(progress.total_bytes)}
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
              <div
                style={{
                  height: 4,
                  borderRadius: 2,
                  background: "var(--bd)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${percent}%`,
                    height: "100%",
                    background: "var(--ac)",
                    transition: "width .2s linear",
                  }}
                />
              </div>
            </div>
          )}

          {summary && (
            <div
              role="status"
              style={{
                padding: "8px",
                border: "1px solid var(--bd2)",
                borderRadius: 4,
                background: "var(--bg)",
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
                <span>
                  Statements executed{" "}
                  <strong style={{ color: summary.stopped_on_error ? "var(--er)" : "var(--ok)" }}>
                    {summary.statements.toLocaleString("en-US")}
                  </strong>
                </span>
                <span>
                  Errors{" "}
                  <strong style={{ color: summary.failed > 0 ? "var(--er)" : "var(--ok)" }}>
                    {summary.failed.toLocaleString("en-US")}
                  </strong>
                </span>
                <span>
                  Duration <strong style={{ color: "var(--tx)" }}>{formatDuration(summary.duration_ms)}</strong>
                </span>
                {summary.cancelled && <span style={{ color: "var(--wn)" }}>Cancelled</span>}
              </div>
              {summary.rolled_back && (
                <div style={{ color: "var(--ok)" }}>
                  The transaction was rolled back; the database is unchanged.
                </div>
              )}
              {summary.errors.length > 0 && (
                <div style={{ maxHeight: 180, overflow: "auto", display: "flex", flexDirection: "column", gap: 5 }}>
                  {summary.errors.map((error) => (
                    <div
                      key={`${error.statement}-${error.message.slice(0, 24)}`}
                      style={{
                        border: "1px solid var(--bd)",
                        borderRadius: 4,
                        padding: "5px 6px",
                      }}
                    >
                      <div style={{ color: "var(--er)" }}>
                        Statement {error.statement}: {error.message}
                      </div>
                      {error.sql && (
                        <code
                          style={{
                            display: "block",
                            marginTop: 3,
                            color: "var(--mu)",
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {error.sql}
                        </code>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {runError && (
            <div
              role="alert"
              style={{
                padding: "7px 8px",
                border: "1px solid var(--er)",
                borderRadius: 4,
                color: "var(--er)",
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                overflowWrap: "anywhere",
              }}
            >
              {runError}
            </div>
          )}
        </div>

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
            disabled={!canRun}
          >
            {busy ? "Restoring…" : "Restore"}
          </button>
        </div>
      </div>
    </>
  );
}
