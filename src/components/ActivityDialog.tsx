import { useCallback, useEffect, useState } from "react";
import { errorMessage, listRunningQueries, stopRunningQuery } from "../ipc";
import type { ConnectionMeta, QueryResult } from "../types";

interface Props {
  connection: ConnectionMeta;
  onClose: () => void;
}

const REFRESH_MS = 2000;

export default function ActivityDialog({ connection, onClose }: Props) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [stopping, setStopping] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setResult(await listRunningQueries(connection.id));
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [connection.id]);

  useEffect(() => {
    void load();
    if (!auto) return;
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [auto, load]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const stop = async (id: string) => {
    const warning =
      connection.dialect === "mssql"
        ? `End session ${id}? SQL Server stops the whole session and rolls back its open transaction.`
        : `Stop query ${id}?`;
    if (!window.confirm(warning)) return;
    setStopping(id);
    try {
      await stopRunningQuery(connection.id, id);
      setError(null);
      await load();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setStopping(null);
    }
  };

  const rows = result?.rows ?? [];
  const cell = { padding: "5px 8px", borderBottom: "1px solid var(--bd)", whiteSpace: "nowrap" as const };

  return (
    <>
      <div
        onMouseDown={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 70, background: "var(--ov)" }}
      />
      <div
        role="dialog"
        aria-label="Running queries"
        style={{
          position: "fixed",
          left: "50%",
          top: "10%",
          transform: "translateX(-50%)",
          zIndex: 71,
          width: 900,
          maxWidth: "94vw",
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
            padding: "10px 12px",
            borderBottom: "1px solid var(--bd)",
          }}
        >
          <i className="icon-activity" style={{ fontSize: 14, color: "var(--ac)" }} />
          <span style={{ flex: 1, fontSize: 13, color: "var(--tx)" }}>
            Running queries · {connection.name}
          </span>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--mu)" }}>
            <input type="checkbox" checked={auto} onChange={() => setAuto((value) => !value)} />
            Auto-refresh
          </label>
          <button type="button" className="v2-btn" onClick={() => void load()}>
            Refresh
          </button>
          <button type="button" className="v2-btn" onClick={onClose}>
            Close
          </button>
        </div>

        {error && (
          <div style={{ padding: "8px 12px", color: "var(--er)", fontSize: 12.5, borderBottom: "1px solid var(--bd)" }}>
            {error}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {result && rows.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--mu)", fontSize: 12.5 }}>
              Nothing is running right now.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "var(--mono)" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--mu)" }}>
                  {(result?.columns ?? []).map((column) => (
                    <th key={column} style={{ ...cell, fontWeight: 500 }}>
                      {column}
                    </th>
                  ))}
                  <th style={cell} />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const id = String(row[0] ?? "");
                  return (
                    <tr key={`${id}-${index}`} style={{ color: "var(--tx)" }}>
                      {row.map((value, column) => (
                        <td
                          key={column}
                          title={value === null ? "" : String(value)}
                          style={{
                            ...cell,
                            maxWidth: column === row.length - 1 ? 420 : 160,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {value === null ? "" : String(value).replace(/\s+/g, " ")}
                        </td>
                      ))}
                      <td style={{ ...cell, textAlign: "right" }}>
                        <button
                          type="button"
                          className="v2-btn"
                          disabled={connection.read_only === true || stopping !== null}
                          title={connection.read_only ? "Read-only connection" : undefined}
                          onClick={() => void stop(id)}
                        >
                          {stopping === id ? "Stopping…" : "Stop"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div
          style={{
            flex: "none",
            height: 26,
            display: "flex",
            alignItems: "center",
            padding: "0 12px",
            borderTop: "1px solid var(--bd)",
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--fa)",
          }}
        >
          {rows.length} running · seconds = time since the statement started
        </div>
      </div>
    </>
  );
}
