import { useEffect, useState } from "react";
import {
  compareTableData,
  connectConnection,
  errorMessage,
  listDatabases,
  saveSqlScript,
} from "../ipc";
import { copyText } from "../clipboard";
import { useAppStore } from "../store";
import type { ConnectionMeta, DataDiff } from "../types";

interface Props {
  connection: ConnectionMeta;
  database: string;
  table: string;
  onClose: () => void;
}

const COMPARABLE = new Set(["mysql", "postgres", "sqlite", "mssql", "clickhouse"]);

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

const KIND_LABEL: Record<string, string> = {
  changed: "changed",
  only_source: "only in source",
  only_target: "only in target",
};

export default function DataCompareDialog({ connection, database, table, onClose }: Props) {
  const connections = useAppStore((state) => state.connections);
  const targets = connections.filter((item) => COMPARABLE.has(item.dialect));
  const [targetId, setTargetId] = useState(
    targets.find((item) => item.id !== connection.id)?.id ?? connection.id,
  );
  const [databases, setDatabases] = useState<string[]>([]);
  const [targetDb, setTargetDb] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<DataDiff | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const target = useAppStore.getState().connections.find((item) => item.id === targetId);
    if (!target) return;
    let cancelled = false;
    setDatabases([]);
    setTargetDb("");
    setDiff(null);
    (async () => {
      if (!useAppStore.getState().connected[target.id]) {
        await connectConnection(target.id);
        useAppStore.getState().setConnected(target.id, true);
      }
      const names = await listDatabases(target.id);
      if (cancelled) return;
      setDatabases(names);
      setTargetDb(
        names.find((name) => !(target.id === connection.id && name === database) && name === target.database) ??
          names.find((name) => !(target.id === connection.id && name === database)) ??
          names[0] ??
          "",
      );
    })().catch((failure) => !cancelled && setError(errorMessage(failure)));
    return () => {
      cancelled = true;
    };
  }, [targetId, connection.id, database]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function run() {
    setBusy(true);
    setError(null);
    setNote(null);
    setDiff(null);
    try {
      setDiff(
        await compareTableData({
          sourceConn: connection.id,
          sourceDb: database,
          targetConn: targetId,
          targetDb,
          table,
        }),
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function saveScript(sql: string) {
    try {
      if (await saveSqlScript(sql, `sync-${table}.sql`)) setNote("Sync script saved");
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  const sameTable = targetId === connection.id && targetDb === database;
  const total = diff ? diff.changed + diff.only_source + diff.only_target : 0;

  return (
    <>
      <div
        onMouseDown={() => !busy && onClose()}
        style={{ position: "fixed", inset: 0, zIndex: 70, background: "var(--ov)" }}
      />
      <div
        role="dialog"
        aria-label="Compare data"
        style={{
          position: "fixed",
          left: "50%",
          top: "10%",
          transform: "translateX(-50%)",
          zIndex: 71,
          width: 760,
          maxWidth: "94vw",
          maxHeight: "78vh",
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
          <i className="icon-git-compare" style={{ fontSize: 14, color: "var(--ac)" }} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Compare data</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fa)" }}>
            {connection.name} · {database} · {table}
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

        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 10, padding: "10px 12px", overflow: "auto" }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            <label style={labelStyle}>
              With
              <select
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                disabled={busy}
                style={{ ...inputStyle, maxWidth: 220 }}
              >
                {targets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
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
            <button
              type="button"
              className="v2-btn v2-btn-primary"
              disabled={busy || !targetDb || sameTable}
              onClick={() => void run()}
            >
              {busy ? "Comparing…" : "Compare"}
            </button>
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fa)" }}>
            Rows are matched by the primary key of “{table}”. The target is the one that would
            change: the sync script makes it equal to the source. Nothing is written here.
          </div>

          {error && <div style={{ color: "var(--er)", fontSize: 12.5 }}>{error}</div>}

          {diff && (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontFamily: "var(--mono)", fontSize: 12 }}>
                <span>same {diff.same}</span>
                <span style={{ color: diff.changed ? "var(--wn)" : undefined }}>changed {diff.changed}</span>
                <span style={{ color: diff.only_source ? "var(--ok)" : undefined }}>only in source {diff.only_source}</span>
                <span style={{ color: diff.only_target ? "var(--er)" : undefined }}>only in target {diff.only_target}</span>
              </div>
              {diff.skipped_columns.length > 0 && (
                <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fa)" }}>
                  Not in the target, not compared: {diff.skipped_columns.join(", ")}
                </div>
              )}
              {total === 0 ? (
                <div style={{ color: "var(--ok)", fontSize: 12.5 }}>The tables hold the same data.</div>
              ) : (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {diff.sync_sql ? (
                      <>
                        <button
                          type="button"
                          className="v2-btn"
                          onClick={() =>
                            void copyText(diff.sync_sql ?? "").then((ok) =>
                              setNote(ok ? "Sync script copied" : "Copy failed"),
                            )
                          }
                        >
                          Copy sync SQL
                        </button>
                        <button type="button" className="v2-btn" onClick={() => void saveScript(diff.sync_sql ?? "")}>
                          Save sync SQL…
                        </button>
                      </>
                    ) : (
                      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fa)" }}>
                        Too many differences for a script ({total}); use Transfer data with “Replace rows”.
                      </span>
                    )}
                    {note && <span style={{ fontSize: 11.5, color: "var(--mu)" }}>{note}</span>}
                  </div>
                  <div style={{ border: "1px solid var(--bd2)", borderRadius: 4, background: "var(--bg)", overflow: "auto", maxHeight: 300 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 11.5 }}>
                      <thead>
                        <tr style={{ textAlign: "left", color: "var(--mu)" }}>
                          <th style={{ padding: "4px 8px", fontWeight: 500 }}>{diff.key.join(", ")}</th>
                          <th style={{ padding: "4px 8px", fontWeight: 500 }}>difference</th>
                          <th style={{ padding: "4px 8px", fontWeight: 500 }}>columns</th>
                        </tr>
                      </thead>
                      <tbody>
                        {diff.samples.map((sample, index) => (
                          <tr key={index} style={{ borderTop: "1px solid var(--bd)" }}>
                            <td style={{ padding: "4px 8px" }}>{sample.key.map((value) => String(value)).join(", ")}</td>
                            <td style={{ padding: "4px 8px" }}>{KIND_LABEL[sample.kind] ?? sample.kind}</td>
                            <td style={{ padding: "4px 8px", color: "var(--mu)" }}>{sample.columns.join(", ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {total > diff.samples.length && (
                    <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fa)" }}>
                      Showing the first {diff.samples.length} of {total} differences.
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
