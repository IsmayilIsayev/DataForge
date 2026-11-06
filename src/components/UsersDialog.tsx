import { useCallback, useEffect, useState } from "react";
import {
  dbUserGrants,
  errorMessage,
  listDatabases,
  listDbUsers,
  manageDbUser,
  type DbUserAction,
} from "../ipc";
import { isProduction } from "../environment";
import { useAppStore } from "../store";
import type { ConnectionMeta, QueryResult } from "../types";

interface Props {
  connection: ConnectionMeta;
  onClose: () => void;
}

type Access = "read" | "write" | "all";

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

const ACCESS_LABEL: Record<Access, string> = {
  read: "Read (SELECT)",
  write: "Read + write rows",
  all: "Everything (owner)",
};

interface User {
  name: string;
  host?: string;
}

function ResultTable({ result }: { result: QueryResult }) {
  if (result.rows.length === 0) {
    return <div style={{ padding: 8, color: "var(--fa)", fontSize: 12 }}>No access in this database.</div>;
  }
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 11.5 }}>
      <thead>
        <tr style={{ textAlign: "left", color: "var(--mu)" }}>
          {result.columns.map((column) => (
            <th key={column} style={{ padding: "4px 8px", fontWeight: 500 }}>
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, index) => (
          <tr key={index} style={{ borderTop: "1px solid var(--bd)" }}>
            {row.map((value, column) => (
              <td key={column} style={{ padding: "4px 8px", overflowWrap: "anywhere" }}>
                {value === null ? "" : String(value)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function UsersDialog({ connection, onClose }: Props) {
  const mysql = connection.dialect === "mysql";
  const readOnly = connection.read_only === true;
  const [users, setUsers] = useState<User[]>([]);
  const [selected, setSelected] = useState<User | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [database, setDatabase] = useState(connection.database ?? "");
  const [grants, setGrants] = useState<QueryResult | null>(null);
  const [access, setAccess] = useState<Access>("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newHost, setNewHost] = useState("%");
  const [newPassword, setNewPassword] = useState("");

  const loadUsers = useCallback(async () => {
    const result = await listDbUsers(connection.id);
    const hostIndex = result.columns.indexOf("host");
    setUsers(
      result.rows.map((row) => ({
        name: String(row[0] ?? ""),
        host: hostIndex >= 0 ? String(row[hostIndex] ?? "") : undefined,
      })),
    );
  }, [connection.id]);

  useEffect(() => {
    loadUsers().catch((failure) => setError(errorMessage(failure)));
    listDatabases(connection.id)
      .then((names) => {
        setDatabases(names);
        setDatabase((current) => (current && names.includes(current) ? current : names[0] ?? ""));
      })
      .catch((failure) => setError(errorMessage(failure)));
  }, [connection.id, loadUsers]);

  useEffect(() => {
    setGrants(null);
    if (!selected || !database) return;
    let cancelled = false;
    dbUserGrants(connection.id, selected.name, selected.host, database)
      .then((result) => !cancelled && setGrants(result))
      .catch((failure) => !cancelled && setError(errorMessage(failure)));
    return () => {
      cancelled = true;
    };
  }, [connection.id, selected, database]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const label = (user: User) => (user.host !== undefined ? `${user.name}@${user.host}` : user.name);

  async function apply(action: DbUserAction, summary: string, done: string) {
    if (isProduction(connection)) {
      const confirmed = await useAppStore.getState().requestProdConfirm({
        connectionName: connection.name,
        databaseName: "database" in action ? action.database : "",
        statements: [
          {
            sql: summary,
            kind: "ddl",
            keyword: action.action.toUpperCase(),
            hasWhere: false,
            requiresTypedConfirm: action.action === "drop",
          },
        ],
        title: "Change users on production",
        note: summary,
      });
      if (!confirmed) return false;
    } else if (action.action === "drop" && !window.confirm(`${summary}?`)) {
      return false;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await manageDbUser(connection.id, action);
      setNote(done);
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const name = newName.trim();
    if (!name || !newPassword) {
      setError("Enter a user name and a password.");
      return;
    }
    const host = mysql ? newHost.trim() || "%" : undefined;
    const ok = await apply(
      { action: "create", name, host, password: newPassword },
      `Create user ${host !== undefined ? `${name}@${host}` : name}`,
      `Created ${name}`,
    );
    if (!ok) return;
    setNewName("");
    setNewPassword("");
    await loadUsers().catch((failure) => setError(errorMessage(failure)));
    setSelected({ name, host });
  }

  async function refreshGrants(user: User) {
    try {
      setGrants(await dbUserGrants(connection.id, user.name, user.host, database));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  return (
    <>
      <div
        onMouseDown={() => !busy && onClose()}
        style={{ position: "fixed", inset: 0, zIndex: 70, background: "var(--ov)" }}
      />
      <div
        role="dialog"
        aria-label="Users and permissions"
        style={{
          position: "fixed",
          left: "50%",
          top: "8%",
          transform: "translateX(-50%)",
          zIndex: 71,
          width: 860,
          maxWidth: "94vw",
          height: "78vh",
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
          <i className="icon-users" style={{ fontSize: 14, color: "var(--ac)" }} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Users and permissions</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fa)" }}>{connection.name}</span>
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

        {(error || note || readOnly) && (
          <div style={{ flex: "none", padding: "6px 12px", fontSize: 12.5, borderBottom: "1px solid var(--bd)" }}>
            {error ? (
              <span style={{ color: "var(--er)" }}>{error}</span>
            ) : note ? (
              <span style={{ color: "var(--ok)" }}>{note}</span>
            ) : (
              <span style={{ color: "var(--mu)" }}>Read-only connection: you can look, not change.</span>
            )}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <div style={{ width: 260, flex: "none", borderRight: "1px solid var(--bd)", display: "flex", flexDirection: "column" }}>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
              {users.map((user) => {
                const active = selected?.name === user.name && selected?.host === user.host;
                return (
                  <div
                    key={label(user)}
                    className="df2-row"
                    onClick={() => setSelected(user)}
                    style={{
                      padding: "5px 12px",
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                      cursor: "default",
                      background: active ? "var(--sel)" : "transparent",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={label(user)}
                  >
                    {label(user)}
                  </div>
                );
              })}
            </div>
            <div style={{ flex: "none", borderTop: "1px solid var(--bd)", padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 500 }}>New user</span>
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="name"
                spellCheck={false}
                disabled={readOnly || busy}
                style={inputStyle}
              />
              {mysql && (
                <input
                  value={newHost}
                  onChange={(event) => setNewHost(event.target.value)}
                  placeholder="host (% = any)"
                  spellCheck={false}
                  disabled={readOnly || busy}
                  style={inputStyle}
                />
              )}
              <input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="password"
                autoComplete="new-password"
                disabled={readOnly || busy}
                style={inputStyle}
              />
              <button type="button" className="v2-btn" disabled={readOnly || busy} onClick={() => void create()}>
                Create user
              </button>
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10, padding: "10px 12px", overflow: "auto" }}>
            {!selected ? (
              <div style={{ color: "var(--mu)", fontSize: 12.5 }}>Choose a user to see and change their access.</div>
            ) : (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, fontWeight: 500 }}>{label(selected)}</span>
                  <label style={labelStyle}>
                    Database
                    <select
                      value={database}
                      onChange={(event) => setDatabase(event.target.value)}
                      disabled={busy}
                      style={{ ...inputStyle, maxWidth: 200 }}
                    >
                      {databases.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div style={{ border: "1px solid var(--bd2)", borderRadius: 4, background: "var(--bg)", overflow: "auto", maxHeight: 280 }}>
                  {grants ? <ResultTable result={grants} /> : <div style={{ padding: 8, color: "var(--fa)", fontSize: 12 }}>loading…</div>}
                </div>
                {mysql && (
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fa)" }}>
                    MySQL lists every grant of the account, not only this database.
                  </div>
                )}

                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <select
                    value={access}
                    onChange={(event) => setAccess(event.target.value as Access)}
                    disabled={readOnly || busy}
                    style={inputStyle}
                  >
                    {(Object.keys(ACCESS_LABEL) as Access[]).map((key) => (
                      <option key={key} value={key}>
                        {ACCESS_LABEL[key]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="v2-btn"
                    disabled={readOnly || busy || !database}
                    onClick={() =>
                      void apply(
                        { action: "grant", name: selected.name, host: selected.host, database, access },
                        `Grant ${ACCESS_LABEL[access].toLowerCase()} on ${database} to ${label(selected)}`,
                        `Granted on ${database}`,
                      ).then((ok) => {
                        if (ok) void refreshGrants(selected);
                      })
                    }
                  >
                    Grant
                  </button>
                  <button
                    type="button"
                    className="v2-btn"
                    disabled={readOnly || busy || !database}
                    onClick={() =>
                      void apply(
                        { action: "revoke", name: selected.name, host: selected.host, database },
                        `Revoke all access on ${database} from ${label(selected)}`,
                        `Revoked on ${database}`,
                      ).then((ok) => {
                        if (ok) void refreshGrants(selected);
                      })
                    }
                  >
                    Revoke all
                  </button>
                  <div style={{ flex: 1 }} />
                  <button
                    type="button"
                    className="v2-btn"
                    disabled={readOnly || busy}
                    style={{ color: "var(--er)" }}
                    onClick={() =>
                      void apply(
                        { action: "drop", name: selected.name, host: selected.host },
                        `Drop user ${label(selected)}`,
                        `Dropped ${label(selected)}`,
                      ).then(async (ok) => {
                        if (!ok) return;
                        setSelected(null);
                        await loadUsers().catch((failure) => setError(errorMessage(failure)));
                      })
                    }
                  >
                    Drop user
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
