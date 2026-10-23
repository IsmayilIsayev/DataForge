import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import {
  errorMessage,
  pickCaCertificateFile,
  pickSqliteFile,
  pickSshKeyFile,
  saveConnection,
  testConnection,
  updateConnection,
} from "../ipc";
import type {
  ConnectionEnvironment,
  ConnectionInput,
  ConnectionMeta,
  Dialect,
  SshAuth,
  SslMode,
} from "../types";
import { ENVIRONMENT_OPTIONS } from "../environment";

interface Props {
  open: boolean;
  connection?: ConnectionMeta | null;
  onClose: () => void;
  onSaved: (meta: ConnectionMeta) => void;
}

type DialectOption = "mysql" | "postgres" | "sqlite" | "mssql" | "clickhouse";
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
  environment: ConnectionEnvironment;
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
  sslMode: SslMode;
  sslCa: string;
  sshUse: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshAuth: SshAuth;
  sshKey: string;
  sshSecret: string;
  sshHostKey: string;
  httpUse: boolean;
  httpUrl: string;
  sqliteReadOnly: boolean;
  trustCert: boolean;
}

const initialForm: FormState = {
  name: "",
  environment: "dev",
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
  sshUse: false,
  sshHost: "",
  sshPort: "22",
  sshUser: "",
  sshAuth: "key",
  sshKey: "~/.ssh/id_ed25519",
  sshSecret: "",
  sshHostKey: "",
  httpUse: false,
  httpUrl: "",
  sqliteReadOnly: false,
  trustCert: false,
};

const ENGINE_LABELS: Array<{ id: DialectOption; label: string }> = [
  { id: "postgres", label: "PostgreSQL" },
  { id: "mysql", label: "MySQL" },
  { id: "mssql", label: "SQL Server" },
  { id: "clickhouse", label: "ClickHouse" },
  { id: "sqlite", label: "SQLite" },
];

interface Preset {
  id: string;
  label: string;
  dialect: DialectOption;
  flavor?: string;
  port: string;
  database?: string;
  hint?: string;
}

const PRESETS: Preset[] = [
  { id: "mysql", label: "MySQL", dialect: "mysql", port: "3306" },
  { id: "mariadb", label: "MariaDB", dialect: "mysql", flavor: "mariadb", port: "3306" },
  { id: "tidb", label: "TiDB", dialect: "mysql", flavor: "tidb", port: "4000" },
  { id: "planetscale", label: "PlanetScale", dialect: "mysql", flavor: "planetscale", port: "3306", hint: "SSL required" },
  { id: "postgres", label: "PostgreSQL", dialect: "postgres", port: "5432" },
  { id: "cockroachdb", label: "CockroachDB", dialect: "postgres", flavor: "cockroachdb", port: "26257" },
  { id: "supabase", label: "Supabase", dialect: "postgres", flavor: "supabase", port: "5432", hint: "SSL usually required" },
  { id: "neon", label: "Neon", dialect: "postgres", flavor: "neon", port: "5432", hint: "SSL usually required" },
  { id: "rds", label: "Amazon RDS", dialect: "postgres", flavor: "rds", port: "5432", hint: "SSL usually required" },
  { id: "azure_postgres", label: "Azure Postgres", dialect: "postgres", flavor: "azure_postgres", port: "5432", hint: "SSL usually required" },
  { id: "mssql", label: "SQL Server", dialect: "mssql", port: "1433" },
  { id: "clickhouse", label: "ClickHouse", dialect: "clickhouse", port: "8123" },
  { id: "sqlite", label: "SQLite", dialect: "sqlite", port: "" },
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

const SSH_AUTH_LABELS: Record<SshAuth, string> = {
  key: "Private key",
  password: "Password",
};

const SSL_MODES: SslMode[] = [
  "disable",
  "prefer",
  "require",
  "verify_ca",
  "verify_full",
];

const SSL_MODE_LABELS: Record<SslMode, string> = {
  disable: "Disable",
  prefer: "Prefer",
  require: "Require",
  verify_ca: "Verify CA",
  verify_full: "Verify full",
};

/** Accept URL values from PostgreSQL (verify-full) and MySQL (verify_identity). */
function normalizeSslMode(value: string | null | undefined): SslMode | undefined {
  const normalized = value?.trim().toLowerCase().replace(/-/g, "_");
  if (!normalized) return undefined;
  if (normalized === "disabled") return "disable";
  if (normalized === "allow" || normalized === "preferred") return "prefer";
  if (normalized === "required") return "require";
  if (normalized === "verify_ca") return "verify_ca";
  if (normalized === "verify_full" || normalized === "verify_identity") {
    return "verify_full";
  }
  if (SSL_MODES.includes(normalized as SslMode)) return normalized as SslMode;
  return undefined;
}

function isSupportedDialect(dialect: Dialect): dialect is DialectOption {
  return (
    dialect === "mysql" ||
    dialect === "postgres" ||
    dialect === "sqlite" ||
    dialect === "mssql" ||
    dialect === "clickhouse"
  );
}

function defaultPort(dialect: DialectOption) {
  if (dialect === "mysql") return "3306";
  if (dialect === "postgres") return "5432";
  if (dialect === "mssql") return "1433";
  if (dialect === "clickhouse") return "8123";
  return "";
}

function presetFor(dialect: DialectOption, flavor?: string | null) {
  if (flavor) {
    const match = PRESETS.find(
      (preset) => preset.dialect === dialect && preset.flavor === flavor,
    );
    if (match) return match;
  }
  return PRESETS.find((preset) => preset.id === dialect);
}

/** Parse a connection URL (postgresql://, mysql://, sqlite://) into form fields. */
function parseConnectionUrl(raw: string): {
  dialect: DialectOption;
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  sslMode?: SslMode;
  flavor?: string;
} | null {
  const text = raw.trim();
  const schemeMatch = text.match(/^([a-zA-Z][\w+.-]*):\/\//);
  if (!schemeMatch) return null;
  const scheme = schemeMatch[1].toLowerCase();

  let dialect: DialectOption | null = null;
  let flavor: string | undefined;
  if (scheme === "postgres" || scheme === "postgresql") dialect = "postgres";
  else if (scheme === "mysql") dialect = "mysql";
  else if (scheme === "mariadb") {
    dialect = "mysql";
    flavor = "mariadb";
  } else if (scheme === "sqlserver" || scheme === "mssql") dialect = "mssql";
  else if (scheme === "clickhouse") dialect = "clickhouse";
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
    sslMode:
      normalizeSslMode(url.searchParams.get("sslmode")) ??
      normalizeSslMode(url.searchParams.get("ssl-mode")),
    flavor,
  };
}

function buildInput(
  form: FormState,
  dialect: DialectOption,
  extra: ExtraState,
  flavor: string | null,
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
      read_only: extra.sqliteReadOnly,
      environment: form.environment,
    };
  }

  const requestedDatabase = form.database.trim();
  const database =
    dialect === "postgres"
      ? requestedDatabase || "postgres"
      : dialect === "mssql"
        ? requestedDatabase || "master"
        : dialect === "clickhouse"
          ? requestedDatabase || "default"
          : requestedDatabase;

  const supportsSsl =
    dialect === "mysql" || dialect === "postgres" || dialect === "clickhouse";
  const ssh = extra.sshUse
    ? {
        host: extra.sshHost.trim(),
        port: Number(extra.sshPort) || 22,
        username: extra.sshUser.trim(),
        auth: extra.sshAuth,
        key_path:
          extra.sshAuth === "key"
            ? extra.sshKey.trim() || undefined
            : undefined,
        host_key: extra.sshHostKey || undefined,
      }
    : undefined;

  return {
    name: form.name.trim(),
    dialect,
    host: form.host.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    database: database || undefined,
    password: form.password || undefined,
    save_password: form.savePassword,
    read_only: extra.readOnly,
    environment: form.environment,
    flavor: flavor || undefined,
    trust_cert: dialect === "mssql" ? extra.trustCert : undefined,
    ssl_mode: supportsSsl ? extra.sslMode : undefined,
    ssl_ca_path: supportsSsl ? extra.sslCa.trim() || undefined : undefined,
    ssh,
    ssh_secret: ssh ? extra.sshSecret || undefined : undefined,
  };
}

function validate(
  form: FormState,
  dialect: DialectOption,
  extra: ExtraState,
): string | null {
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

  if (extra.sshUse) {
    if (!extra.sshHost.trim()) return "SSH host is required.";
    if (!extra.sshUser.trim()) return "SSH user is required.";

    const sshPort = Number(extra.sshPort);
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
      return "SSH port must be between 1 and 65535.";
    }

    if (extra.sshAuth === "key" && !extra.sshKey.trim()) {
      return "SSH private key file is required.";
    }
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

function EnvironmentControl({
  value,
  onChange,
}: {
  value: ConnectionEnvironment;
  onChange: (value: ConnectionEnvironment) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Environment"
      style={{
        display: "flex",
        border: "1px solid var(--bd2)",
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      {ENVIRONMENT_OPTIONS.map((option) => {
        const active = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.id)}
            title={`${option.label} environment`}
            style={{
              height: 24,
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "0 9px",
              border: 0,
              borderRight: "1px solid var(--bd)",
              background: active ? option.background : "transparent",
              color: active ? option.color : "var(--mu)",
              fontWeight: active ? 600 : 400,
              boxShadow: active
                ? `inset 0 -2px 0 ${option.color}`
                : undefined,
              cursor: "default",
              fontSize: 12,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: option.color,
              }}
            />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function ComingSoonNote() {
  return (
    <p style={{ margin: 0, color: "var(--fa)", fontSize: 11 }}>
      Coming soon — this option is not used by the backend yet.
    </p>
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
  const [flavor, setFlavor] = useState<string | null>(null);
  const [presetId, setPresetId] = useState("mysql");
  const [form, setForm] = useState<FormState>(initialForm);
  const [extra, setExtra] = useState<ExtraState>(initialExtra);

  const applyUrl = (raw: string) => {
    const parsed = parseConnectionUrl(raw);
    if (!parsed) return;
    setDialect(parsed.dialect);
    setFlavor(parsed.flavor ?? null);
    setPresetId(parsed.flavor ?? parsed.dialect);
    setForm((current) => ({
      ...current,
      host: parsed.host || current.host,
      port: parsed.port || current.port,
      username: parsed.username || current.username,
      password: parsed.password || current.password,
      database:
        parsed.database ||
        (parsed.dialect === "postgres"
          ? "postgres"
          : parsed.dialect === "mssql"
            ? "master"
            : parsed.dialect === "clickhouse"
              ? "default"
              : current.database),
      name: current.name.trim() || parsed.database || parsed.host,
    }));
    const sslMode = parsed.sslMode;
    if (sslMode) {
      setExtra((current) => ({ ...current, sslMode }));
    } else if (parsed.dialect === "clickhouse") {
      setExtra((current) => ({ ...current, sslMode: "disable" }));
    }
  };
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showSshSecret, setShowSshSecret] = useState(false);

  useEffect(() => {
    if (!open) return;

    setActiveTab("general");
    setStatus(null);
    setShowPassword(false);
    setShowSshSecret(false);
    setExtra({
      ...initialExtra,
      readOnly: connection?.read_only ?? false,
      sqliteReadOnly: connection?.read_only ?? false,
      trustCert: connection?.trust_cert ?? false,
      sslMode:
        connection?.ssl_mode ??
        (connection?.dialect === "clickhouse"
          ? "disable"
          : initialExtra.sslMode),
      sslCa: connection?.ssl_ca_path ?? "",
      sshUse: Boolean(connection?.ssh),
      sshHost: connection?.ssh?.host ?? "",
      sshPort: connection?.ssh?.port ? String(connection.ssh.port) : "22",
      sshUser: connection?.ssh?.username ?? "",
      sshAuth: connection?.ssh?.auth ?? "key",
      sshKey: connection?.ssh?.key_path ?? initialExtra.sshKey,
      sshHostKey: connection?.ssh?.host_key ?? "",
    });

    if (connection) {
      const nextDialect = isSupportedDialect(connection.dialect)
        ? connection.dialect
        : "mysql";
      setDialect(nextDialect);
      setFlavor(connection.flavor ?? null);
      setPresetId(
        presetFor(nextDialect, connection.flavor)?.id ?? nextDialect,
      );
      setForm({
        name: connection.name,
        environment: connection.environment ?? "dev",
        host: connection.host,
        port: connection.port
          ? String(connection.port)
          : defaultPort(nextDialect),
        username: connection.username,
        password: "",
        database:
          nextDialect === "postgres"
            ? connection.database || "postgres"
            : nextDialect === "mssql"
              ? connection.database || "master"
              : nextDialect === "clickhouse"
                ? connection.database || "default"
                : connection.database ?? "",
        savePassword: true,
      });
    } else {
      setDialect("postgres");
      setFlavor(null);
      setPresetId("postgres");
      setForm({
        ...initialForm,
        name: "staging-pg",
        environment: "dev",
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

  const applyPreset = (nextId: string) => {
    const preset = PRESETS.find((item) => item.id === nextId);
    if (!preset) return;

    setPresetId(preset.id);
    setFlavor(preset.flavor ?? null);
    setDialect(preset.dialect);
    setActiveTab("general");
    setStatus(null);
    setShowPassword(false);
    setExtra((current) => ({
      ...current,
      sslMode:
        preset.dialect === "clickhouse"
          ? "disable"
          : current.sslMode === "disable"
            ? "prefer"
            : current.sslMode,
    }));

    setForm((current) => {
      if (preset.dialect === "sqlite") {
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

      const username =
        preset.dialect === "postgres"
          ? current.username && current.username !== "root"
            ? current.username
            : "postgres"
          : preset.dialect === "mssql"
            ? current.username &&
              current.username !== "root" &&
              current.username !== "postgres"
              ? current.username
              : "sa"
            : preset.dialect === "clickhouse"
              ? current.username &&
                current.username !== "postgres" &&
                current.username !== "root"
                ? current.username
                : "default"
              : current.username && current.username !== "postgres"
                ? current.username
                : "root";

      const database =
        preset.database ??
        (preset.dialect === "postgres"
          ? "postgres"
          : preset.dialect === "mssql"
            ? "master"
            : preset.dialect === "clickhouse"
              ? "default"
              : "");

      return {
        ...current,
        host: current.host || "127.0.0.1",
        port: preset.port,
        username,
        database,
        savePassword: true,
      };
    });
  };

  const changeDialect = (next: DialectOption) => {
    setDialect(next);
    setFlavor(null);
    setPresetId(next);
    setActiveTab("general");
    setStatus(null);
    setShowPassword(false);
    setExtra((current) => ({
      ...current,
      sslMode:
        next === "clickhouse"
          ? "disable"
          : current.sslMode === "disable"
            ? "prefer"
            : current.sslMode,
    }));

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

      if (next === "mssql") {
        return {
          ...current,
          host: current.host || "127.0.0.1",
          port: "1433",
          username:
            !current.username ||
            current.username === "root" ||
            current.username === "postgres"
              ? "sa"
              : current.username,
          database: current.database || "master",
          savePassword: true,
        };
      }

      if (next === "clickhouse") {
        return {
          ...current,
          host: current.host || "127.0.0.1",
          port: "8123",
          username:
            !current.username ||
            current.username === "root" ||
            current.username === "postgres"
              ? "default"
              : current.username,
          database: current.database || "default",
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

  const handleBrowseSshKey = async () => {
    setBrowsing(true);
    setStatus(null);

    try {
      const path = await pickSshKeyFile();
      if (path) {
        setExtraField("sshKey", path);
      }
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    } finally {
      setBrowsing(false);
    }
  };

  const handleBrowseCa = async () => {
    setBrowsing(true);
    setStatus(null);

    try {
      const path = await pickCaCertificateFile();
      if (path) {
        setExtraField("sslCa", path);
      }
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    } finally {
      setBrowsing(false);
    }
  };

  const handleTest = async () => {
    const problem = validate(form, dialect, extra);
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
        buildInput(form, dialect, extra, flavor),
        connection?.id,
      );
      if (result.ssh_host_key) {
        setExtraField("sshHostKey", result.ssh_host_key);
      }
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

    const problem = validate(form, dialect, extra);
    if (problem) {
      setStatus({ tone: "error", text: problem });
      return;
    }

    setBusy("save");
    setStatus({ tone: "info", text: "Connecting and saving…" });

    try {
      const input = buildInput(form, dialect, extra, flavor);
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

  const tabs =
    dialect === "sqlite"
      ? MAIN_TABS.slice(0, 2)
      : dialect === "mssql"
        ? MAIN_TABS.filter((tab) => tab !== "ssl")
        : MAIN_TABS;
  const currentPreset = PRESETS.find((preset) => preset.id === presetId);
  const inputClass = "v2-input";
  const mono = {
    fontFamily: "var(--mono)",
  } as const;
  const disabledGroup = {
    border: 0,
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
    opacity: 0.55,
  };

  const statusDot =
    status?.tone === "ok"
      ? "var(--ok)"
      : status?.tone === "error"
        ? "var(--er)"
        : "var(--wn)";

  const nextSslMode = () => {
    const index = SSL_MODES.indexOf(extra.sslMode);
    setExtraField("sslMode", SSL_MODES[(index + 1) % SSL_MODES.length]);
  };

  const nextSshAuth = () => {
    const modes: SshAuth[] = ["key", "password"];
    const index = modes.indexOf(extra.sshAuth);
    setExtraField("sshAuth", modes[(index + 1) % modes.length]);
  };

  const toggleClickHouseHttps = () => {
    const secure = extra.sslMode === "disable";
    setExtraField("sslMode", secure ? "require" : "disable");
    setForm((current) => ({
      ...current,
      port: secure
        ? current.port === "8123"
          ? "8443"
          : current.port
        : current.port === "8443"
          ? "8123"
          : current.port,
    }));
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
                <Row label="Environment">
                  <EnvironmentControl
                    value={form.environment}
                    onChange={(environment) =>
                      setForm((current) => ({ ...current, environment }))
                    }
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
                <Row label="Preset">
                  <select
                    value={presetId}
                    onChange={(event) => applyPreset(event.target.value)}
                    className={inputClass}
                    style={{ ...mono, height: 26, minWidth: 170, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                  >
                    {PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                  {currentPreset?.hint && (
                    <span style={{ color: "var(--wn)", fontSize: 11 }}>
                      {currentPreset.hint}
                    </span>
                  )}
                </Row>
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
                <Row label="Environment">
                  <EnvironmentControl
                    value={form.environment}
                    onChange={(environment) =>
                      setForm((current) => ({ ...current, environment }))
                    }
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
                {dialect === "clickhouse" && (
                  <Row label="Database">
                    <input
                      value={form.database}
                      onChange={update("database")}
                      placeholder="default"
                      className={inputClass}
                      style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                    />
                  </Row>
                )}
                <Row label="User">
                  <input
                    value={form.username}
                    onChange={update("username")}
                    placeholder={
                      dialect === "postgres"
                        ? "postgres"
                        : dialect === "mssql"
                          ? "sa"
                          : dialect === "clickhouse"
                            ? "default"
                            : "root"
                    }
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
                <Row label="">
                  <Check
                    checked={extra.readOnly}
                    label="Read-only connection"
                    onChange={() =>
                      setExtraField("readOnly", !extra.readOnly)
                    }
                  />
                </Row>
                {dialect === "clickhouse" && (
                  <Row label="">
                    <Check
                      checked={extra.sslMode !== "disable"}
                      label="HTTPS (TLS)"
                      onChange={toggleClickHouseHttps}
                    />
                  </Row>
                )}
                {dialect === "mssql" && extra.readOnly && (
                  <p
                    style={{
                      margin: 0,
                      color: "var(--wn)",
                      fontSize: 11,
                      lineHeight: 1.45,
                    }}
                  >
                    SQL Server has no server-side read-only session here; writes
                    and DDL are blocked in the app only.
                  </p>
                )}
                {dialect === "mssql" && (
                  <Row label="">
                    <Check
                      checked={extra.trustCert}
                      label="Trust server certificate"
                      onChange={() =>
                        setExtraField("trustCert", !extra.trustCert)
                      }
                    />
                  </Row>
                )}
              </>
            ))}

          {activeTab === "advanced" && (
            <>
              <ComingSoonNote />
              <fieldset disabled style={disabledGroup}>
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
              </fieldset>
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
                <CycleButton
                  value={SSL_MODE_LABELS[extra.sslMode]}
                  onClick={nextSslMode}
                />
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
                <button
                  type="button"
                  className="v2-btn"
                  onClick={() => void handleBrowseCa()}
                  disabled={busy !== null || browsing}
                  style={{ height: 26, whiteSpace: "nowrap" }}
                >
                  {browsing ? "…" : "Browse…"}
                </button>
              </Row>
              <p
                style={{
                  margin: 0,
                  color: "var(--fa)",
                  fontSize: 11,
                  lineHeight: 1.45,
                }}
              >
                Verify CA and Verify full check the server certificate. Without
                a CA file, the system / webpki root certificates are used.
              </p>
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
              <fieldset
                disabled={!extra.sshUse}
                style={{ ...disabledGroup, opacity: extra.sshUse ? 1 : 0.55 }}
              >
                <Row label="SSH host">
                  <input
                    value={extra.sshHost}
                    onChange={(event) =>
                      setExtra((current) => ({
                        ...current,
                        sshHost: event.target.value,
                        sshHostKey: "",
                      }))
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
                      setExtra((current) => ({
                        ...current,
                        sshPort: event.target.value,
                        sshHostKey: "",
                      }))
                    }
                    inputMode="numeric"
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
                    value={SSH_AUTH_LABELS[extra.sshAuth]}
                    onClick={nextSshAuth}
                    width={160}
                  />
                </Row>
                {extra.sshAuth === "key" ? (
                  <>
                    <Row label="Private key">
                      <input
                        value={extra.sshKey}
                        onChange={(event) =>
                          setExtraField("sshKey", event.target.value)
                        }
                        placeholder="~/.ssh/id_ed25519"
                        className={inputClass}
                        style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                      />
                      <button
                        type="button"
                        className="v2-btn"
                        onClick={() => void handleBrowseSshKey()}
                        disabled={busy !== null || browsing}
                        style={{ height: 26, whiteSpace: "nowrap" }}
                      >
                        {browsing ? "…" : "Browse…"}
                      </button>
                    </Row>
                    <Row label="Passphrase">
                      <input
                        type={showSshSecret ? "text" : "password"}
                        value={extra.sshSecret}
                        onChange={(event) =>
                          setExtraField("sshSecret", event.target.value)
                        }
                        placeholder={
                          connection
                            ? "Leave blank to keep saved passphrase"
                            : "Optional for unencrypted keys"
                        }
                        autoComplete="new-password"
                        className={inputClass}
                        style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                      />
                      <button
                        type="button"
                        className="v2-btn"
                        onClick={() => setShowSshSecret((value) => !value)}
                        title="Show passphrase"
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
                          className={showSshSecret ? "icon-eye-off" : "icon-eye"}
                          style={{ fontSize: 13 }}
                        />
                      </button>
                    </Row>
                  </>
                ) : (
                  <Row label="SSH password">
                    <input
                      type={showSshSecret ? "text" : "password"}
                      value={extra.sshSecret}
                      onChange={(event) =>
                        setExtraField("sshSecret", event.target.value)
                      }
                      placeholder={
                        connection
                          ? "Leave blank to keep saved SSH password"
                          : ""
                      }
                      autoComplete="new-password"
                      className={inputClass}
                      style={{ ...mono, height: 26, flex: 1, minWidth: 0, padding: "0 8px", background: "var(--bg)", border: "1px solid var(--bd2)", borderRadius: 4, color: "var(--tx)", fontSize: 12.5 }}
                    />
                    <button
                      type="button"
                      className="v2-btn"
                      onClick={() => setShowSshSecret((value) => !value)}
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
                        className={showSshSecret ? "icon-eye-off" : "icon-eye"}
                        style={{ fontSize: 13 }}
                      />
                    </button>
                  </Row>
                )}
                {extra.sshHostKey && (
                  <Row label="Host key">
                    <span
                      title={extra.sshHostKey}
                      style={{
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: "var(--fa)",
                        fontFamily: "var(--mono)",
                        fontSize: 11,
                      }}
                    >
                      {extra.sshHostKey}
                    </span>
                  </Row>
                )}
              </fieldset>
            </>
          )}

          {activeTab === "http" && (
            <>
              <ComingSoonNote />
              <fieldset disabled style={disabledGroup}>
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
              </fieldset>
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
