import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelOperation,
  errorMessage,
  importCsv,
  listColumns,
  previewCsv,
} from "../ipc";
import type { ImportSummary, TransferProgress } from "../ipc";
import { guardSqlExecution } from "../prodGuard";
import type { ColumnInfo } from "../types";

interface Props {
  connId: string;
  database: string;
  table: string;
  path: string;
  onClose: () => void;
  onImported: () => void;
}

const DELIMITER_OPTIONS = [
  { value: "auto", label: "Auto-detect" },
  { value: ",", label: "Comma (,)" },
  { value: ";", label: "Semicolon (;)" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe (|)" },
];

function delimiterLabel(value: string): string {
  if (value === "\t") return "Tab";
  if (value === ",") return "Comma";
  if (value === ";") return "Semicolon";
  if (value === "|") return "Pipe";
  return value;
}

export default function ImportCsvDialog({
  connId,
  database,
  table,
  path,
  onClose,
  onImported,
}: Props) {
  const [delimiter, setDelimiter] = useState("auto");
  const [detected, setDetected] = useState(",");
  const [rows, setRows] = useState<string[][]>([]);
  const [previewing, setPreviewing] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [columnsError, setColumnsError] = useState<string | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState<Array<string | null>>([]);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [skipBadRows, setSkipBadRows] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{
    id: string;
    processed: number;
    cancelRequested: boolean;
  } | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listColumns(connId, database, table)
      .then((items) => {
        if (!cancelled) setColumns(items);
      })
      .catch((loadError) => {
        if (!cancelled) setColumnsError(errorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, [connId, database, table]);

  useEffect(() => {
    let cancelled = false;
    setPreviewing(true);
    setPreviewError(null);
    previewCsv(path, delimiter === "auto" ? null : delimiter)
      .then((preview) => {
        if (cancelled) return;
        setDetected(preview.delimiter);
        setRows(preview.rows);
      })
      .catch((previewFailure) => {
        if (!cancelled) setPreviewError(errorMessage(previewFailure));
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, delimiter]);

  useEffect(() => {
    const first = rows[0] ?? [];
    const names = hasHeader
      ? first
      : first.map((_, index) => `Column ${index + 1}`);
    const used = new Set<string>();
    const next = names.map((name) => {
      const normalized = name.trim().toLowerCase();
      const match = columns.find(
        (column) =>
          !used.has(column.name) &&
          column.name.toLowerCase() === normalized,
      );
      if (match) {
        used.add(match.name);
        return match.name;
      }
      return null;
    });
    setMapping(next);
  }, [rows, columns, hasHeader]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<TransferProgress>("import:progress", (event) => {
      const update = event.payload;
      setProgress((current) =>
        current && current.id === update.id && !update.done
          ? { ...current, processed: update.processed ?? current.processed }
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
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const firstRow = rows[0] ?? [];
  const columnCount = Math.max(firstRow.length, mapping.length);
  const csvColumns = Array.from({ length: columnCount }, (_, index) =>
    hasHeader ? firstRow[index] ?? `Column ${index + 1}` : `Column ${index + 1}`,
  );
  const previewRows = (hasHeader ? rows.slice(1) : rows).slice(0, 20);
  const canImport =
    !busy &&
    !previewing &&
    csvColumns.length > 0 &&
    mapping.some((column) => column !== null);

  const cancel = async () => {
    if (!progress) return;
    setProgress({ ...progress, cancelRequested: true });
    try {
      await cancelOperation(progress.id);
    } catch {
      // The import may already have finished.
    }
  };

  const run = async () => {
    if (!canImport) return;
    const guard = await guardSqlExecution(
      connId,
      `INSERT INTO ${table} VALUES (...)`,
      database,
      { title: "Import CSV" },
    );
    if (!guard.allow) {
      if (guard.error) setError(guard.error);
      return;
    }

    const id = `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setBusy(true);
    setError(null);
    setSummary(null);
    setProgress({ id, processed: 0, cancelRequested: false });
    try {
      const result = await importCsv({
        connId,
        database,
        table,
        path,
        delimiter: delimiter === "auto" ? null : delimiter,
        hasHeader,
        mapping: mapping.map((column, index) => ({
          csv_index: index,
          column,
        })),
        emptyAsNull,
        skipBadRows,
        importId: id,
      });
      setSummary(result);
      if (!result.cancelled) onImported();
    } catch (importError) {
      setError(errorMessage(importError));
    } finally {
      setBusy(false);
      setProgress(null);
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
          top: "5%",
          transform: "translateX(-50%)",
          zIndex: 71,
          width: 820,
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
          <i className="icon-upload" style={{ fontSize: 14, color: "var(--fa)" }} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Import CSV</span>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              color: "var(--fa)",
            }}
          >
            {database}.{table}
          </span>
          <div style={{ flex: 1 }} />
          <span
            style={{
              maxWidth: 320,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              color: "var(--fa)",
            }}
            title={path}
          >
            {path}
          </span>
        </div>

        <div
          style={{
            flex: "none",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 14,
            padding: "8px 12px",
            borderBottom: "1px solid var(--bd)",
            fontFamily: "var(--mono)",
            fontSize: 11,
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            Delimiter
            <select
              value={delimiter}
              onChange={(event) => setDelimiter(event.target.value)}
              disabled={busy}
              style={{
                height: 24,
                border: "1px solid var(--bd2)",
                borderRadius: 4,
                background: "var(--bg)",
                color: "var(--tx)",
                fontSize: 11,
                padding: "0 6px",
              }}
            >
              {DELIMITER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value === "auto"
                    ? `${option.label} (${delimiterLabel(detected)})`
                    : option.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={hasHeader}
              disabled={busy}
              onChange={(event) => setHasHeader(event.target.checked)}
              style={{ margin: 0, accentColor: "var(--ac)" }}
            />
            First row is header
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={emptyAsNull}
              disabled={busy}
              onChange={(event) => setEmptyAsNull(event.target.checked)}
              style={{ margin: 0, accentColor: "var(--ac)" }}
            />
            Empty string = NULL
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={skipBadRows}
              disabled={busy}
              onChange={(event) => setSkipBadRows(event.target.checked)}
              style={{ margin: 0, accentColor: "var(--ac)" }}
            />
            Skip bad rows (otherwise stop)
          </label>
        </div>

        {(previewError || columnsError) && (
          <div
            role="alert"
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
          >
            {previewError ?? columnsError}
          </div>
        )}

        <div
          style={{
            flex: "none",
            maxHeight: 170,
            overflow: "auto",
            margin: "8px 12px 0",
            border: "1px solid var(--bd)",
            borderRadius: 4,
          }}
        >
          {previewing ? (
            <div
              style={{
                padding: 12,
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                color: "var(--fa)",
              }}
            >
              Reading preview…
            </div>
          ) : (
            <table
              style={{
                borderCollapse: "collapse",
                width: "100%",
                fontFamily: "var(--mono)",
                fontSize: 11,
                whiteSpace: "nowrap",
              }}
            >
              <thead>
                <tr>
                  {csvColumns.map((name, index) => (
                    <th
                      key={index}
                      style={{
                        position: "sticky",
                        top: 0,
                        padding: "4px 8px",
                        textAlign: "left",
                        background: "var(--sf2)",
                        borderBottom: "1px solid var(--bd2)",
                        color: "var(--tx)",
                        fontWeight: 500,
                      }}
                    >
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {csvColumns.map((_, columnIndex) => (
                      <td
                        key={columnIndex}
                        style={{
                          padding: "3px 8px",
                          borderBottom: "1px solid var(--bd)",
                          color: "var(--mu)",
                        }}
                      >
                        {row[columnIndex] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 90,
            overflow: "auto",
            margin: "8px 12px 0",
          }}
        >
          <div
            style={{
              padding: "0 0 4px",
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              color: "var(--fa)",
              textTransform: "uppercase",
              letterSpacing: ".04em",
            }}
          >
            Column mapping ({csvColumns.length} CSV → {columns.length} table)
          </div>
          {csvColumns.map((name, index) => (
            <div
              key={index}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "3px 0",
                fontFamily: "var(--mono)",
                fontSize: 11.5,
              }}
            >
              <div
                style={{
                  width: 230,
                  flex: "none",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--tx)",
                }}
                title={name}
              >
                {name}
              </div>
              <span style={{ color: "var(--fa)" }}>→</span>
              <select
                value={mapping[index] ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  setMapping((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? value || null : item,
                    ),
                  );
                }}
                disabled={busy}
                style={{
                  width: 220,
                  height: 24,
                  border: "1px solid var(--bd2)",
                  borderRadius: 4,
                  background: "var(--bg)",
                  color: "var(--tx)",
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  padding: "0 6px",
                }}
              >
                <option value="">— Skip —</option>
                {columns.map((column) => (
                  <option key={column.name} value={column.name}>
                    {column.name}
                  </option>
                ))}
              </select>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--fa)",
                }}
                title={previewRows[0]?.[index] ?? ""}
              >
                {previewRows[0]?.[index] ?? ""}
              </span>
            </div>
          ))}
        </div>

        {busy && progress && (
          <div
            role="status"
            style={{
              flex: "none",
              display: "flex",
              alignItems: "center",
              gap: 8,
              margin: "8px 12px 0",
              padding: "7px 8px",
              border: "1px solid var(--bd2)",
              borderRadius: 4,
              background: "var(--bg)",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
            }}
          >
            <i className="icon-upload" style={{ fontSize: 12, color: "var(--ac)" }} />
            <span>
              Importing… {progress.processed.toLocaleString("en-US")} rows
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
          <div
            role="status"
            style={{
              flex: "none",
              margin: "8px 12px 0",
              padding: "8px 9px",
              border: "1px solid var(--bd2)",
              borderRadius: 4,
              background: "var(--bg)",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              lineHeight: 1.55,
            }}
          >
            {summary.cancelled ? (
              <div style={{ color: "var(--wn)" }}>
                Import cancelled — the transaction was rolled back.
              </div>
            ) : (
              <div style={{ color: "var(--ok)" }}>
                Inserted {summary.inserted.toLocaleString("en-US")} rows
                {summary.skipped > 0 &&
                  ` · skipped ${summary.skipped.toLocaleString("en-US")}`}
              </div>
            )}
            {summary.errors.length > 0 && (
              <ol
                style={{
                  margin: "5px 0 0",
                  paddingLeft: 18,
                  color: "var(--er)",
                  maxHeight: 90,
                  overflow: "auto",
                }}
              >
                {summary.errors.map((message, index) => (
                  <li key={index}>{message}</li>
                ))}
              </ol>
            )}
          </div>
        )}

        {error && (
          <div
            role="alert"
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
            disabled={busy}
          >
            Close
          </button>
          <button
            type="button"
            className="v2-btn v2-btn-primary"
            onClick={() => void run()}
            disabled={!canImport}
          >
            {busy ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </>
  );
}
