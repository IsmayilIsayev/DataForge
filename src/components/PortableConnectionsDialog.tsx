import { useEffect, useState } from "react";
import {
  applyConnectionsImport,
  errorMessage,
  exportConnections,
  previewConnectionsImport,
} from "../ipc";
import { notify } from "../notifications";
import { useAppStore } from "../store";
import type {
  ConnectionImportDecision,
  ConnectionImportPreview,
} from "../types";

type Props = {
  mode: "export" | "import";
  onClose: () => void;
  onImported?: () => void | Promise<void>;
};

type Action = "new" | "skip" | "replace";

export default function PortableConnectionsDialog({
  mode,
  onClose,
  onImported,
}: Props) {
  const connections = useAppStore((state) => state.connections);
  const savedQueryCount = useAppStore(
    (state) => state.savedQueries.queries.length,
  );

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(connections.map((connection) => connection.id)),
  );
  const [includeSaved, setIncludeSaved] = useState(true);
  const [preview, setPreview] = useState<ConnectionImportPreview | null>(null);
  const [actions, setActions] = useState<Record<number, Action>>({});
  const [loading, setLoading] = useState(mode === "import");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "import") return;
    let cancelled = false;

    previewConnectionsImport()
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          onClose();
          return;
        }
        setPreview(result);
        setActions(
          Object.fromEntries(
            result.connections.map((item) => [
              item.index,
              item.conflict ? "skip" : "new",
            ]),
          ),
        );
      })
      .catch((loadError) => {
        if (!cancelled) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // The native file picker must run once per open, not whenever App re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runExport = async () => {
    if (selected.size === 0) {
      setError("Select at least one connection to export.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const path = await exportConnections([...selected], includeSaved);
      if (path) {
        void notify("DataForge", "Connections exported.");
        onClose();
      }
    } catch (exportError) {
      setError(errorMessage(exportError));
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const decisions: ConnectionImportDecision[] = preview.connections.map(
        (item) => ({
          index: item.index,
          action: actions[item.index] ?? "skip",
        }),
      );
      const result = await applyConnectionsImport(
        preview.path,
        decisions,
        includeSaved && preview.saved_query_count > 0,
      );
      const parts = [`${result.imported} imported`];
      if (result.replaced) parts.push(`${result.replaced} replaced`);
      if (result.skipped) parts.push(`${result.skipped} skipped`);
      if (result.saved_queries) {
        parts.push(`${result.saved_queries} saved queries`);
      }
      void notify("DataForge", `Connections: ${parts.join(", ")}.`);
      await onImported?.();
      onClose();
    } catch (importError) {
      setError(errorMessage(importError));
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
          top: "12%",
          transform: "translateX(-50%)",
          zIndex: 71,
          width: 620,
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
            padding: "10px 14px",
            borderBottom: "1px solid var(--bd)",
          }}
        >
          <i
            className={mode === "export" ? "icon-download" : "icon-upload"}
            style={{ fontSize: 15, color: "var(--ac)" }}
          />
          <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>
            {mode === "export"
              ? "Export connections"
              : "Import connections"}
          </span>
          <button
            type="button"
            className="df2-icon-btn"
            onClick={onClose}
            disabled={busy}
            title="Close"
            style={iconButtonStyle}
          >
            <i className="icon-x" style={{ fontSize: 14 }} />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 14 }}>
          {mode === "export" ? (
            <>
              <p style={noteStyle}>
                Connection metadata only. Passwords, SSH secrets and AI keys
                are never included. Read-only/SSL/SSH settings are preserved.
              </p>
              {connections.length === 0 ? (
                <div style={emptyStyle}>No connections to export.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {connections.map((connection) => (
                    <label
                      key={connection.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        minHeight: 30,
                        padding: "4px 6px",
                        borderRadius: 4,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(connection.id)}
                        onChange={() => toggle(connection.id)}
                      />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        {connection.name}
                      </span>
                      <span style={metaStyle}>
                        {connection.dialect} · {connection.host}
                        {connection.port ? `:${connection.port}` : ""}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <label style={checkRowStyle}>
                <input
                  type="checkbox"
                  checked={includeSaved}
                  onChange={(event) => setIncludeSaved(event.target.checked)}
                />
                <span>
                  Include saved queries
                  {savedQueryCount > 0 ? ` (${savedQueryCount})` : ""}
                </span>
              </label>
            </>
          ) : loading ? (
            <div style={emptyStyle}>Reading connections file…</div>
          ) : preview ? (
            <>
              <p style={noteStyle}>{preview.header}</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {preview.connections.map((item) => {
                  const connection = item.connection;
                  return (
                    <div
                      key={item.index}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        minHeight: 36,
                        padding: "5px 7px",
                        border: "1px solid var(--bd)",
                        borderRadius: 5,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 500,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {connection.name}
                          </span>
                          <span style={metaStyle}>{connection.dialect}</span>
                          {item.conflict && (
                            <span
                              style={{
                                fontSize: 10.5,
                                color: "var(--wn)",
                                border: "1px solid var(--wn)",
                                borderRadius: 3,
                                padding: "0 4px",
                              }}
                              title={
                                item.conflict_with
                                  ? `Conflicts with ${item.conflict_with}`
                                  : undefined
                              }
                            >
                              {item.conflict === "both"
                                ? "name + endpoint"
                                : item.conflict}
                            </span>
                          )}
                        </div>
                        <div style={metaStyle}>
                          {connection.host}
                          {connection.port ? `:${connection.port}` : ""} ·{" "}
                          {connection.username || "—"} ·{" "}
                          {connection.database || "—"}
                        </div>
                      </div>
                      <select
                        value={actions[item.index] ?? "skip"}
                        onChange={(event) =>
                          setActions((current) => ({
                            ...current,
                            [item.index]: event.target.value as Action,
                          }))
                        }
                        style={smallInputStyle}
                      >
                        <option value="new">Import as new</option>
                        <option value="skip">Skip</option>
                        <option value="replace" disabled={!item.conflict}>
                          Replace
                        </option>
                      </select>
                    </div>
                  );
                })}
              </div>
              {preview.saved_query_count > 0 && (
                <label style={checkRowStyle}>
                  <input
                    type="checkbox"
                    checked={includeSaved}
                    onChange={(event) => setIncludeSaved(event.target.checked)}
                  />
                  <span>
                    Include {preview.saved_query_count} saved queries
                  </span>
                </label>
              )}
            </>
          ) : (
            <div style={emptyStyle}>No file selected.</div>
          )}

          {error && (
            <div
              style={{
                marginTop: 10,
                padding: "7px 9px",
                borderRadius: 4,
                background: "var(--ers)",
                color: "var(--er)",
                fontSize: 11.5,
                lineHeight: 1.45,
              }}
            >
              {error}
            </div>
          )}
        </div>

        <div
          style={{
            flex: "none",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 14px",
            borderTop: "1px solid var(--bd)",
          }}
        >
          <button
            type="button"
            className="v2-btn"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          {mode === "export" ? (
            <button
              type="button"
              className="v2-btn v2-btn-primary"
              onClick={() => void runExport()}
              disabled={busy || connections.length === 0}
            >
              {busy ? "Exporting…" : "Export…"}
            </button>
          ) : (
            <button
              type="button"
              className="v2-btn v2-btn-primary"
              onClick={() => void runImport()}
              disabled={busy || !preview}
            >
              {busy ? "Importing…" : "Import selected"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

const noteStyle = {
  margin: "0 0 10px",
  fontSize: 11.5,
  color: "var(--mu)",
  lineHeight: 1.5,
};

const emptyStyle = {
  padding: "24px 8px",
  textAlign: "center" as const,
  color: "var(--mu)",
  fontSize: 12.5,
};

const metaStyle = {
  fontFamily: "var(--mono)",
  fontSize: 10.5,
  color: "var(--fa)",
  whiteSpace: "nowrap" as const,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const checkRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 12,
  padding: "6px 4px",
  fontSize: 12,
};

const smallInputStyle = {
  width: 132,
  height: 26,
  padding: "0 6px",
  border: "1px solid var(--bd2)",
  borderRadius: 4,
  background: "var(--bg)",
  color: "var(--tx)",
  fontSize: 12,
  flex: "none" as const,
};

const iconButtonStyle = {
  width: 24,
  height: 24,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: 0,
  borderRadius: 4,
  background: "transparent",
  color: "var(--mu)",
  cursor: "default",
  padding: 0,
};
