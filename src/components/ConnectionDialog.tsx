import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import {
  errorMessage,
  pickSqliteFile,
  saveConnection,
  testConnection,
  updateConnection,
} from "../ipc";
import type {
  ConnectionInput,
  ConnectionMeta,
  Dialect,
} from "../types";

interface Props {
  open: boolean;
  connection?: ConnectionMeta | null;
  onClose: () => void;
  onSaved: (meta: ConnectionMeta) => void;
}

type DialectOption = "mysql" | "postgres" | "sqlite";
type ActiveTab =
  | "general"
  | "advanced"
  | "databases"
  | "ssl"
  | "ssh"
  | "http";
type Status = { tone: "info" | "ok" | "error"; text: string } | null;

interface FormState {
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  savePassword: boolean;
}

interface ExtraState {
  timeout: string;
  keepalive: string;
  appName: string;
  autoCommit: boolean;
  readOnly: boolean;
  showAllDbs: boolean;
  dbList: string;
  sslMode: string;
  sslCa: string;
  sslCert: string;
  sslKey: string;
  sshUse: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshAuth: string;
  sshKey: string;
  httpUse: boolean;
  httpUrl: string;
  sqliteReadOnly: boolean;
}

const initialForm: FormState = {
  name: "",
  host: "127.0.0.1",
  port: "3306",
  username: "root",
  password: "",
  database: "",
  savePassword: true,
};

const initialExtra: ExtraState = {
  timeout: "30s",
  keepalive: "60s",
  appName: "DataForge",
  autoCommit: true,
  readOnly: false,
  showAllDbs: false,
  dbList: "",
  sslMode: "prefer",
  sslCa: "",
  sslCert: "",
  sslKey: "",
  sshUse: false,
  sshHost: "",
  sshPort: "22",
  sshUser: "",
  sshAuth: "Private key",
  sshKey: "~/.ssh/id_ed25519",
  httpUse: false,
  httpUrl: "",
  sqliteReadOnly: false,
};

const ENGINE_LABELS: Array<{ id: DialectOption; label: string }> = [
  { id: "postgres", label: "PostgreSQL" },
  { id: "mysql", label: "MySQL" },
  { id: "sqlite", label: "SQLite" },
];

const MAIN_TABS: ActiveTab[] = [
  "general",
  "advanced",
  "databases",
  "ssl",
  "ssh",
  "http",
];

const TAB_LABELS: Record<ActiveTab, string> = {
  general: "General",
  advanced: "Advanced",
  databases: "Databases",
  ssl: "SSL",
  ssh: "SSH",
  http: "HTTP",
};

function isSupportedDialect(dialect: Dialect): dialect is DialectOption {
  return dialect === "mysql" || dialect === "postgres" || dialect === "sqlite";
}

function defaultPort(dialect: DialectOption) {
  if (dialect === "mysql") return "3306";
  if (dialect === "postgres") return "5432";
  return "";
}

/** Parse a connection URL (postgresql://, mysql://, sqlite://) into form fields. */
function parseConnectionUrl(raw: string): {
  dialect: DialectOption;
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  sslMode?: string;
} | null {
  const text = raw.trim();
  const schemeMatch = text.match(/^([a-zA-Z][\w+.-]*):\/\//);
  if (!schemeMatch) return null;
  const scheme = schemeMatch[1].toLowerCase();

  let dialect: DialectOption | null = null;
  if (scheme === "postgres" || scheme === "postgresql") dialect = "postgres";
  else if (scheme === "mysql" || scheme === "mariadb") dialect = "mysql";
  else if (scheme === "sqlite" || scheme === "sqlite3") dialect = "sqlite";
  if (!dialect) return null;

  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  if (dialect === "sqlite") {
    return {
      dialect,
      host: "",
      port: "",
      username: "",
      password: "",
      database: decode(text.replace(/^sqlite3?:(\/\/)?/i, "")),
    };
  }

  let url: URL;
  try {
    url = new URL(text.replace(/^[a-zA-Z][\w+.-]*:\/\//, "http://"));
  } catch {
    return null;
  }

  return {
    dialect,
    host: url.hostname,
    port: url.port || defaultPort(dialect),
    username: decode(url.username),
    password: decode(url.password),
    database: decode(url.pathname.replace(/^\//, "")),
    sslMode: url.searchParams.get("sslmode") ?? undefined,
  };
}

function buildInput(
  form: FormState,
  dialect: DialectOption,
): ConnectionInput {
  if (dialect === "sqlite") {
    return {
      name: form.name.trim(),
      dialect,
      host: "",
      port: 0,
      username: "",
      database: form.database.trim() || undefined,
      password: undefined,
      save_password: false,
    };
  }

  const requestedDatabase = form.database.trim();
  const database =
    dialect === "postgres"
      ? requestedDatabase || "postgres"
      : dialect === "mysql"
        ? ""
        : requestedDatabase;

  return {
    name: form.name.trim(),
    dialect,
    host: form.host.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    database: database || undefined,
    password: form.password || undefined,
    save_password: form.savePassword,
  };
}

function validate(form: FormState, dialect: DialectOption): string | null {
  if (!form.name.trim()) return "Connection name is required.";

  if (dialect === "sqlite") {
    if (!form.database.trim()) return "Choose a SQLite database file.";
    return null;
  }

  if (!form.host.trim()) return "Host is required.";
  if (!form.username.trim()) return "User name is required.";

  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "Port must be between 1 and 65535.";
  }

  return null;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "136px minmax(0,1fr)",
        alignItems: "center",
        gap: 12,
        minHeight: 26,
      }}
    >
      <span style={{ color: "var(--mu)" }}>{label}</span>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          minWidth: 0,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Check({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      style={{
        height: 24,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: 0,
        border: 0,
        background: "transparent",
        cursor: "default",
      }}
    >
      <span
        style={{
          width: 14,
          height: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: `1px solid ${checked ? "var(--acd)" : "var(--bd2)"}`,
          borderRadius: 3,
          background: checked ? "var(--acd)" : "var(--bg)",
          color: "#fff",
        }}
      >
        {checked && <i className="icon-check" style={{ fontSize: 11 }} />}
      </span>
      <span>{label}</span>
    </button>
  );
}

function CycleButton({
  value,
  onClick,
  width = 160,
}: {
  value: string;
  onClick: () => void;
  width?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 26,
        minWidth: width,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "0 8px",
        border: "1px solid var(--bd2)",
        borderRadius: 4,
        background: "var(--bg)",
        cursor: "default",
      }}
    >
      <span>{value}</span>
      <i
        className="icon-chevrons-up-down"
        style={{ fontSize: 12, color: "var(--fa)" }}
      />
    </button>
  );
}

export default function ConnectionDialog({
  open,
  connection,
  onClose,
  onSaved,
}: Props) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("general");
  const [dialect, setDialect] = useState<DialectOption>("mysql");
  const [form, setForm] = useState<FormState>(initialForm);
  const [extra, setExtra] = useState<ExtraState>(initialExtra);

  const applyUrl = (raw: string) => {
    const parsed = parseConnectionUrl(raw);
    if (!parsed) return;
    setDialect(parsed.dialect);
    setForm((current) => ({
      ...current,
      host: parsed.host || current.host,
      port: parsed.port || current.port,
      username: parsed.username || current.username,
      password: parsed.password || current.password,
      database: parsed.database || current.database,
      name: current.name.trim() || parsed.database || parsed.host,
    }));
    if (parsed.sslMode) {
      setExtra((current) => ({ ...current, sslMode: parsed.sslMode as string }));
    }
  };
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!open) return;

    setActiveTab("general");
    setStatus(null);
    setShowPassword(false);
    setExtra(initialExtra);

    if (connection) {
      const nextDialect = isSupportedDialect(connection.dialect)
        ? connection.dialect
        : "mysql";
      setDialect(nextDialect);
      setForm({
        name: connection.name,
        host: connection.host,
        port: connection.port
          ? String(connection.port)
          : defaultPort(nextDialect),
        username: connection.username,
        password: "",
        database:
          nextDialect === "postgres"
            ? connection.database || "postgres"
            : nextDialect === "sqlite"
              ? connection.database ?? ""
              : "",
        savePassword: true,
      });
    } else {
      setDialect("postgres");
      setForm({
        ...initialForm,
        name: "staging-pg",
        host: "127.0.0.1",
        port: "5432",
        username: "postgres",
        database: "postgres",
      });
    }
  }, [open, connection]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && busy === null && !browsing) {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, browsing, onClose]);

  if (!open) return null;

  const update =
    (field: keyof FormState) => (event: ChangeEvent<HTMLInputElement>) => {
      setForm((current) => ({ ...current, [field]: event.target.value }));
      setStatus(null);
    };

  const setExtraField = <K extends keyof ExtraState>(
    field: K,
    value: ExtraState[K],
  ) => {
    setExtra((current) => ({ ...current, [field]: value }));
  };

  const changeDialect = (next: DialectOption) => {
    setDialect(next);
    setActiveTab("general");
    setStatus(null);
    setShowPassword(false);

    setForm((current) => {
      if (next === "sqlite") {
        return {
          ...current,
          host: "",
          port: "",
          username: "",
          password: "",
          database: "",
          savePassword: false,
        };
      }

      if (next === "postgres") {
        return {
          ...current,
          host: current.host || "127.0.0.1",
          port: "5432",
          username:
            !current.username || current.username === "root"
              ? "postgres"
              : current.username,
          database: current.database || "postgres",
          savePassword: true,
        };
      }

      return {
        ...current,
        host: current.host || "127.0.0.1",
        port: "3306",
        username:
          !current.username || current.username === "postgres"
            ? "root"
            : current.username,
        database: "",
        savePassword: true,
      };
    });
  };

  const handleBrowse = async () => {
    setBrowsing(true);
    setStatus(null);

    try {
      const path = await pickSqliteFile();
      if (path) {
        setForm((current) => ({ ...current, database: path }));
      }
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    } finally {
      setBrowsing(false);
    }
  };

  const handleTest = async () => {
    const problem = validate(form, dialect);
    if (problem) {
      setStatus({ tone: "error", text: problem });
      return;
    }

    setBusy("test");
    setStatus({
      tone: "info",
      text: dialect === "sqlite" ? "Opening…" : "Testing…",
    });

    try {
      const result = await testConnection(
        buildInput(form, dialect),
        connection?.id,
      );
      setStatus({
        tone: result.ok ? "ok" : "error",
        text: result.message,
      });
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();

    const problem = validate(form, dialect);
    if (problem) {
      setStatus({ tone: "error", text: problem });
      return;
    }

    setBusy("save");
    setStatus({ tone: "info", text: "Connecting and saving…" });

    try {
      const input = buildInput(form, dialect);
      const meta = connection
        ? await updateConnection(connection.id, input)
        : await saveConnection(input);
      setForm(initialForm);
      onSaved(meta);
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const tabs = dialect === "sqlite" ? MAIN_TABS.slice(0, 2) : MAIN_TABS;
  const inputClass = "v2-input";
  const mono = {
    fontFamily: "var(--mono)",
  } as const;

  const statusDot =
    status?.tone === "ok"
      ? "var(--ok)"
      : status?.tone === "error"
        ? "var(--er)"
        : "var(--wn)";

  const nextSslMode = () => {
    const modes = ["disable", "prefer", "require", "verify-ca", "verify-full"];
    const index = modes.indexOf(extra.sslMode);
    setExtraField("sslMode", modes[(index + 1) % modes.length]);
  };

  const nextSshAuth = () => {
    const modes = ["Private key", "Password", "Agent"];
    const index = modes.indexOf(extra.sshAuth);
    setExtraField("sshAuth", modes[(index + 1) % modes.length]);
  };

  return (
    <div
      onMouseDown={(event) => {
        if (
          event.target === event.currentTarget &&
          busy === null &&
          !browsing
        ) {
          onClose();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 70,
        background: "var(--scrim)",
      }}
    >
      <form
        onSubmit={handleSave}
        onClick={(event) => event.stopPropagation()}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%,-50%)",
          zIndex: 71,
          width: 600,
          maxWidth: "calc(100vw - 32px)",
          display: "flex",
          flexDirection: "column",
          background: "var(--sf)",
          border: "1px solid var(--bd2)",
          borderRadius: 6,
          boxShadow: "var(--sh)",
        }}
      >
        <div
          style={{
            height: 42,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "0 12px 0 16px",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>
            {connection ? "Edit connection" : "New connection"}
          </span>
          <div
            style={{
              display: "flex",
              border: "1px solid var(--bd2)",
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            {ENGINE_LABELS.map((engine) => {
              const active = dialect === engine.id;
              return (
                <button
                  key={engine.id}
                  type="button"
                  onClick={() => changeDialect(engine.id)}
                  style={{
                    height: 24,
                    padding: "0 10px",
                    border: 0,
                    borderRight: "1px solid var(--bd)",
                    background: active ? "var(--sel)" : "transparent",
                    color: active ? "var(--tx)" : "var(--mu)",
                    fontSize: 12,
                    cursor: "default",
                  }}
                >
                  {engine.label}
                </button>
              );
            })}
          </div>
        </div>

        <div
          style={{
            height: 30,
            display: "flex",
            alignItems: "stretch",
            gap: 2,
            padding: "0 10px",
            borderBottom: "1px solid var(--bd)",
          }}
        >
          {tabs.map((tab) => {
            const active = activeTab === tab;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: "0 8px",
                  marginBottom: -1,
                  border: 0,
                  borderBottom: `2px solid ${
                    active ? "var(--ac)" : "transparent"
                  }`,
                  background: "transparent",
                  color: active ? "var(--tx)" : "var(--mu)",
                  cursor: "default",
                }}
              >
                {TAB_LABELS[tab]}
              </button>
            );
          })}
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 16,
            minHeight: 252,
          }}
        >
          {activeTab === "general" &&
            (dialect === "sqlite" ? (
              <>
                <Row label="Connection name">
                  <input
                    autoFocus
                    value={form.name}
                    onChange={update("name")}
                    className={inputClass}
                    style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                  />
                </Row>
                <Row label="Database file">
                  <input
                    value={form.database}
                    onChange={update("database")}
                    placeholder="C:\\path\\to\\database.db"
                    className={inputClass}
                    style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                  />
                  <button
                    type="button"
                    className="v2-btn"
                    onClick={() => void handleBrowse()}
                    disabled={busy !== null || browsing}
                    style={{ height: 26, whiteSpace: "nowrap" }}
                  >
                    {browsing ? "…" : "Browse…"}
                  </button>
                </Row>
                <Row label="">
                  <Check
                    checked={extra.sqliteReadOnly}
                    label="Open read-only"
                    onChange={() =>
                      setExtraField("sqliteReadOnly", !extra.sqliteReadOnly)
                    }
                  />
                </Row>
              </>
            ) : (
              <>
                <Row label="Connection URL">
                  <input
                    onChange={(event) => applyUrl(event.target.value)}
                    placeholder="postgresql://user:pass@host:5432/db?sslmode=require"
                    spellCheck={false}
                    className={inputClass}
                    style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                  />
                </Row>
                <Row label="Connection name">
                  <input
                    autoFocus
                    value={form.name}
                    onChange={update("name")}
                    className={inputClass}
                    style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                  />
                </Row>
                <Row label="Host">
                  <input
                    value={form.host}
                    onChange={update("host")}
                    placeholder="127.0.0.1"
                    className={inputClass}
                    style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                  />
                </Row>
                <Row label="Port">
                  <input
                    value={form.port}
                    onChange={update("port")}
                    inputMode="numeric"
                    className={inputClass}
                    style={{ ...mono, height: 26, width: 96, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                  />
                </Row>
                <Row label="User">
                  <input
                    value={form.username}
                    onChange={update("username")}
                    placeholder={dialect === "postgres" ? "postgres" : "root"}
                    className={inputClass}
                    style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                  />
                </Row>
                <Row label="Password">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={form.password}
                    onChange={update("password")}
                    placeholder={
                      connection ? "Leave blank to keep saved password" : ""
                    }
                    autoComplete="current-password"
                    className={inputClass}
                    style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                  />
                  <button
                    type="button"
                    className="v2-btn"
                    onClick={() => setShowPassword((value) => !value)}
                    title="Show password"
                    style={{
                      width: 26,
                      height: 26,
                      padding: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <i
                      className={showPassword ? "icon-eye-off" : "icon-eye"}
                      style={{ fontSize: 13 }}
                    />
                  </button>
                </Row>
                <Row label="">
                  <Check
                    checked={form.savePassword}
                    label="Save password in keychain"
                    onChange={() =>
                      setForm((current) => ({
                        ...current,
                        savePassword: !current.savePassword,
                      }))
                    }
                  />
                </Row>
              </>
            ))}

          {activeTab === "advanced" && (
            <>
              <Row label="Statement timeout">
                <input
                  value={extra.timeout}
                  onChange={(event) =>
                    setExtraField("timeout", event.target.value)
                  }
                  className={inputClass}
                  style={{ ...mono, height: 26, width: 120, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                />
              </Row>
              <Row label="Keepalive interval">
                <input
                  value={extra.keepalive}
                  onChange={(event) =>
                    setExtraField("keepalive", event.target.value)
                  }
                  className={inputClass}
                  style={{ ...mono, height: 26, width: 120, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                />
              </Row>
              <Row label="Application name">
                <input
                  value={extra.appName}
                  onChange={(event) =>
                    setExtraField("appName", event.target.value)
                  }
                  className={inputClass}
                  style={{ height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                />
              </Row>
              <Row label="">
                <Check
                  checked={extra.autoCommit}
                  label="Auto-commit"
                  onChange={() =>
                    setExtraField("autoCommit", !extra.autoCommit)
                  }
                />
              </Row>
              <Row label="">
                <Check
                  checked={extra.readOnly}
                  label="Read-only session"
                  onChange={() =>
                    setExtraField("readOnly", !extra.readOnly)
                  }
                />
              </Row>
            </>
          )}

          {activeTab === "databases" && (
            <>
              <Row label="">
                <Check
                  checked={extra.showAllDbs}
                  label="Show all databases"
                  onChange={() =>
                    setExtraField("showAllDbs", !extra.showAllDbs)
                  }
                />
              </Row>
              <Row label="Databases">
                <input
                  value={extra.dbList}
                  onChange={(event) =>
                    setExtraField("dbList", event.target.value)
                  }
                  placeholder="shop, auth"
                  className={inputClass}
                  style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                />
              </Row>
            </>
          )}

          {activeTab === "ssl" && (
            <>
              <Row label="Mode">
                <CycleButton value={extra.sslMode} onClick={nextSslMode} />
              </Row>
              <Row label="CA certificate">
                <input
                  value={extra.sslCa}
                  onChange={(event) =>
                    setExtraField("sslCa", event.target.value)
                  }
                  placeholder="ca.pem"
                  className={inputClass}
                  style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                />
                <button type="button" className="v2-btn" style={{ height: 26 }}>
                  Browse…
                </button>
              </Row>
              <Row label="Client certificate">
                <input
                  value={extra.sslCert}
                  onChange={(event) =>
                    setExtraField("sslCert", event.target.value)
                  }
                  placeholder="client.crt"
                  className={inputClass}
                  style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                />
                <button type="button" className="v2-btn" style={{ height: 26 }}>
                  Browse…
                </button>
              </Row>
              <Row label="Client key">
                <input
                  value={extra.sslKey}
                  onChange={(event) =>
                    setExtraField("sslKey", event.target.value)
                  }
                  placeholder="client.key"
                  className={inputClass}
                  style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                />
                <button type="button" className="v2-btn" style={{ height: 26 }}>
                  Browse…
                </button>
              </Row>
            </>
          )}

          {activeTab === "ssh" && (
            <>
              <Row label="">
                <Check
                  checked={extra.sshUse}
                  label="Use SSH tunnel"
                  onChange={() => setExtraField("sshUse", !extra.sshUse)}
                />
              </Row>
              <Row label="SSH host">
                <input
                  value={extra.sshHost}
                  onChange={(event) =>
                    setExtraField("sshHost", event.target.value)
                  }
                  placeholder="bastion.example.com"
                  className={inputClass}
                  style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                />
              </Row>
              <Row label="Port">
                <input
                  value={extra.sshPort}
                  onChange={(event) =>
                    setExtraField("sshPort", event.target.value)
                  }
                  className={inputClass}
                  style={{ ...mono, height: 26, width: 96, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                />
              </Row>
              <Row label="User">
                <input
                  value={extra.sshUser}
                  onChange={(event) =>
                    setExtraField("sshUser", event.target.value)
                  }
                  placeholder="deploy"
                  className={inputClass}
                  style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                />
              </Row>
              <Row label="Authentication">
                <CycleButton
                  value={extra.sshAuth}
                  onClick={nextSshAuth}
                  width={160}
                />
              </Row>
              <Row label="Private key">
                <input
                  value={extra.sshKey}
                  onChange={(event) =>
                    setExtraField("sshKey", event.target.value)
                  }
                  className={inputClass}
                  style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                />
                <button type="button" className="v2-btn" style={{ height: 26 }}>
                  Browse…
                </button>
              </Row>
            </>
          )}

          {activeTab === "http" && (
            <>
              <Row label="">
                <Check
                  checked={extra.httpUse}
                  label="Use HTTP tunnel"
                  onChange={() => setExtraField("httpUse", !extra.httpUse)}
                />
              </Row>
              <Row label="Tunnel URL">
                <input
                  value={extra.httpUrl}
                  onChange={(event) =>
                    setExtraField("httpUrl", event.target.value)
                  }
                  placeholder="https://tunnel.example.com/forge.php"
                  className={inputClass}
                  style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                />
              </Row>
            </>
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px 10px 16px",
            borderTop: "1px solid var(--bd)",
          }}
        >
          {status && (
            <>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: statusDot,
                }}
              />
              <span
                style={{
                  maxWidth: 300,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: "var(--mono)",
                  fontSize: 11.5,
                  color: "var(--mu)",
                }}
                title={status.text}
              >
                {status.text}
              </span>
            </>
          )}
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="v2-btn"
            onClick={() => void handleTest()}
            disabled={busy !== null || browsing}
          >
            {busy === "test" ? "Testing…" : "Test"}
          </button>
          <button
            type="button"
            className="v2-btn"
            onClick={onClose}
            disabled={busy !== null || browsing}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="v2-btn v2-btn-primary"
            disabled={busy !== null || browsing}
            style={{ minWidth: 64 }}
          >
            {busy === "save" ? "Saving…" : "OK"}
          </button>
        </div>
      </form>
    </div>
  );
}
