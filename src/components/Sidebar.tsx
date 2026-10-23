import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent,
  MouseEvent,
  ReactNode,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  connectConnection,
  deleteConnection,
  disconnectConnection,
  errorMessage,
  listColumns,
  listDatabases,
  listTables,
  runQuery,
} from "../ipc";
import { dropTableSql } from "../ddl";
import { selectAllSql } from "../sql";
import { environmentColor, isProtectedEnvironment } from "../environment";
import { guardSqlExecution } from "../prodGuard";
import EnvironmentBadge from "./EnvironmentBadge";
import CreateTableDialog from "./CreateTableDialog";
import { useAppStore } from "../store";
import type { FavoriteTable } from "../store";
import type { ColumnInfo, ConnectionMeta, Dialect, TableInfo } from "../types";

const StructureDialog = lazy(() => import("./StructureDialog"));
const ImportCsvDialog = lazy(() => import("./ImportCsvDialog"));

const dialogFallback = (
  <div style={{ position: "fixed", inset: 0 }} aria-hidden="true" />
);

interface Props {
  onNewConnection: () => void;
  onEditConnection: (connection: ConnectionMeta) => void;
  onFindInTable: (connId: string, database: string, table: string) => void;
  onOpenTable: (
    connection: ConnectionMeta,
    database: string,
    table: string,
  ) => void;
  onOpenErd: (connection: ConnectionMeta, database: string) => void;
  width: number;
}

type ContextMenu =
  | { kind: "connection"; x: number; y: number; connectionId: string }
  | {
      kind: "database";
      x: number;
      y: number;
      connectionId: string;
      database: string;
    }
  | {
      kind: "table";
      x: number;
      y: number;
      connectionId: string;
      database: string;
      table: string;
    };

const ENGINE_SHORT: Record<string, string> = {
  mysql: "mysql",
  postgres: "pg",
  sqlite: "sqlite",
  mssql: "mssql",
  mongodb: "mongo",
};

const FLAVOR_SHORT: Record<string, string> = {
  mariadb: "mariadb",
  tidb: "tidb",
  cockroachdb: "crdb",
  supabase: "supabase",
  neon: "neon",
  rds: "rds",
  azure_postgres: "azure pg",
  planetscale: "planetscale",
};

const FLAVOR_LABELS: Record<string, string> = {
  mariadb: "MariaDB",
  tidb: "TiDB",
  cockroachdb: "CockroachDB",
  supabase: "Supabase",
  neon: "Neon",
  rds: "Amazon RDS",
  azure_postgres: "Azure Postgres",
  planetscale: "PlanetScale",
};

function engineMeta(connection: ConnectionMeta) {
  if (connection.flavor) {
    return (
      FLAVOR_SHORT[connection.flavor] ??
      FLAVOR_LABELS[connection.flavor] ??
      connection.flavor
    );
  }
  return ENGINE_SHORT[connection.dialect] ?? connection.dialect;
}

function engineName(connection: ConnectionMeta) {
  if (connection.flavor) {
    return FLAVOR_LABELS[connection.flavor] ?? connection.flavor;
  }
  return connection.dialect;
}

function columnIcon(column: ColumnInfo) {
  if (column.key === "PRI") return "icon-key-round";
  if (/int|numeric/i.test(column.data_type)) return "icon-hash";
  if (/time|date/i.test(column.data_type)) return "icon-calendar";
  if (/json/i.test(column.data_type)) return "icon-braces";
  return "icon-type";
}

interface TreeRowProps {
  pad: number;
  guides: number[];
  bl?: string;
  bg?: string;
  caret?: string;
  dot?: string;
  icon?: string;
  ic?: string;
  label: string;
  color?: string;
  ff?: string;
  fs?: number;
  meta?: string;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  title?: string;
  trailing?: ReactNode;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
}

const CONN_COLORS: Array<{ name: string; value?: string }> = [
  { name: "None", value: undefined },
  { name: "Red", value: "#e5534b" },
  { name: "Amber", value: "#caa23a" },
  { name: "Green", value: "#43b581" },
  { name: "Blue", value: "#4c8bf5" },
  { name: "Purple", value: "#a371f7" },
  { name: "Gray", value: "#8b929c" },
];

function TreeRow({
  pad,
  guides,
  bl = "transparent",
  bg = "transparent",
  caret = "",
  dot,
  icon,
  ic = "var(--mu)",
  label,
  color = "var(--tx)",
  ff = "var(--ui)",
  fs = 12.5,
  meta,
  onClick,
  onDoubleClick,
  onContextMenu,
  title,
  trailing,
  draggable,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}: TreeRowProps) {
  const style = {
    position: "relative",
    height: 24,
    display: "flex",
    alignItems: "center",
    gap: 6,
    paddingLeft: pad,
    paddingRight: 10,
    borderLeft: `2px solid ${bl}`,
    cursor: "default",
    userSelect: "none",
    "--row-bg": bg,
  } as CSSProperties;

  return (
    <div
      className="df2-row"
      style={style}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={title}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {guides.map((x) => (
        <span
          key={x}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: x,
            width: 1,
            background: "var(--bd)",
          }}
        />
      ))}
      <i
        className={caret}
        style={{
          width: 12,
          flex: "none",
          fontSize: 12,
          color: "var(--fa)",
          display: "inline-flex",
          justifyContent: "center",
        }}
      />
      {dot && (
        <span
          style={{
            width: 6,
            height: 6,
            flex: "none",
            borderRadius: "50%",
            background: dot,
            margin: "0 2px",
          }}
        />
      )}
      {icon && (
        <i className={icon} style={{ flex: "none", fontSize: 14, color: ic }} />
      )}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color,
          fontFamily: ff,
          fontSize: fs,
        }}
      >
        {label}
      </span>
      {meta && (
        <span
          style={{
            flex: "none",
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--fa)",
          }}
        >
          {meta}
        </span>
      )}
      {trailing}
    </div>
  );
}

function MenuItem({
  icon,
  iconColor = "var(--mu)",
  label,
  kbd,
  danger = false,
  onClick,
}: {
  icon: string;
  iconColor?: string;
  label: string;
  kbd?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="df2-menu-item"
      onClick={onClick}
      style={{
        width: "100%",
        height: 26,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 8px",
        border: 0,
        borderRadius: 4,
        background: "transparent",
        color: danger ? "var(--er)" : "var(--tx)",
        textAlign: "left",
        cursor: "default",
      }}
    >
      <i
        className={icon}
        style={{ width: 14, flex: "none", fontSize: 13, color: danger ? "var(--er)" : iconColor }}
      />
      <span style={{ flex: 1, whiteSpace: "nowrap" }}>{label}</span>
      {kbd && (
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--fa)",
          }}
        >
          {kbd}
        </span>
      )}
    </button>
  );
}

function MenuSeparator() {
  return (
    <div style={{ height: 1, background: "var(--bd)", margin: "4px -4px" }} />
  );
}

function TreeNotice({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "16px 14px",
        color: "var(--mu)",
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

function TreeError({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        margin: "4px 8px",
        padding: "7px 9px",
        border: "1px solid var(--er)",
        borderRadius: 6,
        background: "var(--ers)",
        color: "var(--er)",
        fontSize: 11,
        lineHeight: 1.45,
        overflowWrap: "anywhere",
      }}
    >
      {children}
    </div>
  );
}

export default function Sidebar({
  onNewConnection,
  onEditConnection,
  onFindInTable,
  onOpenTable,
  onOpenErd,
  width,
}: Props) {
  const connections = useAppStore((state) => state.connections);
  const connected = useAppStore((state) => state.connected);
  const activeConnId = useAppStore((state) => state.activeConnId);
  const activeDb = useAppStore((state) => state.activeDb);
  const databases = useAppStore((state) => state.databases);
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const setActiveDb = useAppStore((state) => state.setActiveDb);
  const setDatabases = useAppStore((state) => state.setDatabases);
  const connPrefs = useAppStore((state) => state.connPrefs);
  const setConnPref = useAppStore((state) => state.setConnPref);
  const favorites = useAppStore((state) => state.favorites);
  const toggleFavorite = useAppStore((state) => state.toggleFavorite);
  const connGroups = useAppStore((state) => state.connGroups);
  const setConnGroup = useAppStore((state) => state.setConnGroup);
  const groupStars = useAppStore((state) => state.groupStars);
  const toggleGroupStar = useAppStore((state) => state.toggleGroupStar);

  const [localDatabases, setLocalDatabases] = useState<
    Record<string, string[]>
  >({});
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
  const [columns, setColumns] = useState<Record<string, ColumnInfo[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // DDL dialogs
  const [structureFor, setStructureFor] = useState<{
    connection: ConnectionMeta;
    database: string;
    table: string;
  } | null>(null);
  const [createFor, setCreateFor] = useState<{
    connection: ConnectionMeta;
    database: string;
  } | null>(null);
  const [dropFor, setDropFor] = useState<{
    connection: ConnectionMeta;
    database: string;
    table: string;
  } | null>(null);
  const [importFor, setImportFor] = useState<{
    connection: ConnectionMeta;
    database: string;
    table: string;
    path: string;
  } | null>(null);
  const [dropBusy, setDropBusy] = useState(false);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [showStarredOnly, setShowStarredOnly] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<
    Record<string, boolean>
  >({});
  const [groupEditFor, setGroupEditFor] = useState<string | null>(null);
  const [groupEditValue, setGroupEditValue] = useState("");
  const inFlight = useRef(new Set<string>());
  const activeConnected = activeConnId ? !!connected[activeConnId] : false;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeTableTab = activeTab?.type === "table" ? activeTab : null;

  const hiddenCount = connections.filter(
    (connection) => connPrefs[connection.id]?.hidden,
  ).length;
  const visibleConnections = connections
    .filter(
      (connection) =>
        (showHidden || !connPrefs[connection.id]?.hidden) &&
        (!showStarredOnly || connPrefs[connection.id]?.starred),
    )
    .slice()
    .sort((a, b) => {
      const ga = connGroups[a.id] ?? "";
      const gb = connGroups[b.id] ?? "";
      if (ga !== gb) {
        const ra = ga === "" ? 1 : groupStars[ga] ? 0 : 2;
        const rb = gb === "" ? 1 : groupStars[gb] ? 0 : 2;
        if (ra !== rb) return ra - rb;
        return ga < gb ? -1 : 1;
      }
      const sa = connPrefs[a.id]?.starred ? 0 : 1;
      const sb = connPrefs[b.id]?.starred ? 0 : 1;
      return sa - sb;
    });

  useEffect(() => {
    if (!activeConnId) {
      setDatabases([]);
      setActiveDb(null);
      return;
    }

    setExpanded((current) => ({ ...current, [activeConnId]: true }));
    if (!activeConnected) {
      setLoading((current) => ({
        ...current,
        [`db:${activeConnId}`]: false,
      }));
      return;
    }

    let cancelled = false;
    const key = `db:${activeConnId}`;
    setLoading((current) => ({ ...current, [key]: true }));

    listDatabases(activeConnId)
      .then((items) => {
        if (cancelled) return;
        const store = useAppStore.getState();
        store.setDatabases(items);
        setLocalDatabases((current) => ({
          ...current,
          [activeConnId]: items,
        }));

        const connection = store.connections.find(
          (item) => item.id === activeConnId,
        );
        // Don't auto-select a database the user didn't choose. Keep the current
        // selection if it's still valid; otherwise use only the connection's
        // explicit default database (if any) — never the first in the list.
        const explicit =
          connection?.database && items.includes(connection.database)
            ? connection.database
            : null;
        const current = store.activeDb;
        store.setActiveDb(
          current && items.includes(current) ? current : explicit,
        );
        setErrors((current) => {
          if (!(key in current)) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
      })
      .catch((error) => {
        if (!cancelled) {
          setErrors((current) => ({
            ...current,
            [key]: errorMessage(error),
          }));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading((current) => ({ ...current, [key]: false }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeConnId,
    activeConnected,
    connections,
    refreshTick,
    setActiveDb,
    setDatabases,
  ]);

  useEffect(() => {
    if (!activeConnId || !activeDb || !activeConnected) return;

    const dbKey = `${activeConnId}/${activeDb}`;
    setExpanded((current) => ({ ...current, [dbKey]: true }));
    void loadTablesFor(activeConnId, activeDb);
  }, [activeConnId, activeDb, activeConnected]);

  function setLoadingKey(key: string, value: boolean) {
    setLoading((current) => ({ ...current, [key]: value }));
  }

  async function loadDatabasesFor(connId: string, force = false) {
    if (!connected[connId]) return;

    const key = `db:${connId}`;
    if ((!force && localDatabases[connId]) || inFlight.current.has(key)) return;

    inFlight.current.add(key);
    setLoadingKey(key, true);
    try {
      const items = await listDatabases(connId);
      setLocalDatabases((current) => ({ ...current, [connId]: items }));
      setErrors((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    } catch (error) {
      setErrors((current) => ({ ...current, [key]: errorMessage(error) }));
    } finally {
      inFlight.current.delete(key);
      setLoadingKey(key, false);
    }
  }

  async function loadTablesFor(
    connId: string,
    database: string,
    force = false,
  ) {
    if (!connected[connId]) return;

    const key = tableKey(connId, database);
    if ((!force && tables[key]) || inFlight.current.has(key)) return;

    inFlight.current.add(key);
    setLoadingKey(key, true);
    try {
      const items = await listTables(connId, database);
      setTables((current) => ({ ...current, [key]: items }));
      setErrors((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    } catch (error) {
      setErrors((current) => ({ ...current, [key]: errorMessage(error) }));
    } finally {
      inFlight.current.delete(key);
      setLoadingKey(key, false);
    }
  }

  async function loadColumnsFor(
    connId: string,
    database: string,
    table: string,
    force = false,
  ) {
    if (!connected[connId]) return;

    const key = columnKey(connId, database, table);
    if ((!force && columns[key]) || inFlight.current.has(key)) return;

    inFlight.current.add(key);
    setLoadingKey(key, true);
    try {
      const items = await listColumns(connId, database, table);
      setColumns((current) => ({ ...current, [key]: items }));
      setErrors((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    } catch (error) {
      setErrors((current) => ({ ...current, [key]: errorMessage(error) }));
    } finally {
      inFlight.current.delete(key);
      setLoadingKey(key, false);
    }
  }

  function databasesFor(connection: ConnectionMeta) {
    return connection.id === activeConnId
      ? databases
      : (localDatabases[connection.id] ?? []);
  }

  async function connectAndSelect(connection: ConnectionMeta) {
    const store = useAppStore.getState();
    if (store.activeConnId !== connection.id) {
      store.setActiveConn(connection.id);
    }
    setExpanded((current) => ({ ...current, [connection.id]: true }));

    if (store.connected[connection.id]) {
      void loadDatabasesFor(connection.id);
      return;
    }

    try {
      await connectConnection(connection.id);
      const current = useAppStore.getState();
      current.setConnected(connection.id, true);
      current.setError(null);
      void loadDatabasesFor(connection.id);
    } catch (error) {
      useAppStore.getState().setError(errorMessage(error));
    }
  }

  async function disconnectOnly(connection: ConnectionMeta) {
    try {
      await disconnectConnection(connection.id);
      const current = useAppStore.getState();
      current.setConnected(connection.id, false);
      current.setError(null);
    } catch (error) {
      useAppStore.getState().setError(errorMessage(error));
    }
  }

  function openContextMenu(
    event: MouseEvent<HTMLDivElement>,
    connection: ConnectionMeta,
  ) {
    event.preventDefault();
    setSelected(connection.id);
    setContextMenu({
      kind: "connection",
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 240),
      connectionId: connection.id,
    });
  }

  function openDatabaseMenu(
    event: MouseEvent<HTMLDivElement>,
    connection: ConnectionMeta,
    database: string,
  ) {
    event.preventDefault();
    setSelected(`${connection.id}/${database}`);
    setContextMenu({
      kind: "database",
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 180),
      connectionId: connection.id,
      database,
    });
  }

  function openTableMenu(
    event: MouseEvent<HTMLDivElement>,
    connection: ConnectionMeta,
    database: string,
    table: string,
  ) {
    event.preventDefault();
    setSelected(`${connection.id}/${database}/table/${table}`);
    setContextMenu({
      kind: "table",
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 200),
      connectionId: connection.id,
      database,
      table,
    });
  }

  async function removeConnection(connection: ConnectionMeta) {
    const confirmed = window.confirm(
      `Delete connection "${connection.name}"? Its saved password will also be removed.`,
    );
    setContextMenu(null);
    if (!confirmed) return;

    try {
      await deleteConnection(connection.id);
      const store = useAppStore.getState();
      const remaining = store.connections.filter(
        (item) => item.id !== connection.id,
      );
      store.setConnections(remaining);
      store.removeConnectionState(connection.id);
      if (store.activeConnId === connection.id) {
        store.setActiveConn(remaining[0]?.id ?? null);
      }
      setContextMenu(null);
    } catch (error) {
      storeError(error);
    }
  }

  function storeError(error: unknown) {
    useAppStore.getState().setError(errorMessage(error));
  }

  function refreshConnection(connection: ConnectionMeta) {
    if (!connected[connection.id]) {
      storeError("Connect to the database before refreshing its schema.");
      return;
    }

    setTables((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([key]) => !key.startsWith(`t:${connection.id}/`),
        ),
      ),
    );
    setColumns((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([key]) => !key.startsWith(`c:${connection.id}/`),
        ),
      ),
    );
    setErrors({});

    if (connection.id === activeConnId) {
      setRefreshTick((tick) => tick + 1);
    } else {
      setLocalDatabases((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      void loadDatabasesFor(connection.id, true);
    }
  }

  async function activateDatabase(
    connection: ConnectionMeta,
    database: string,
  ) {
    const store = useAppStore.getState();
    if (store.activeConnId !== connection.id) {
      store.setActiveConn(connection.id);
    }
    store.setActiveDb(database);

    if (!store.connected[connection.id]) {
      try {
        await connectConnection(connection.id);
        useAppStore.getState().setConnected(connection.id, true);
      } catch (error) {
        storeError(error);
        return;
      }
    }

    setExpanded((current) => ({
      ...current,
      [connection.id]: true,
      [`${connection.id}/${database}`]: true,
    }));
    void loadTablesFor(connection.id, database);
  }

  function refreshDatabase(connection: ConnectionMeta, database: string) {
    if (!connected[connection.id]) {
      storeError("Connect to the database before refreshing its schema.");
      return;
    }

    const key = tableKey(connection.id, database);
    setTables((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setColumns((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([cachedKey]) =>
            !cachedKey.startsWith(`c:${connection.id}/${database}/`),
        ),
      ),
    );
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    void loadTablesFor(connection.id, database, true);
  }

  function refreshTable(
    connection: ConnectionMeta,
    database: string,
    table: string,
  ) {
    if (!connected[connection.id]) {
      storeError("Connect to the database before refreshing its schema.");
      return;
    }

    const key = columnKey(connection.id, database, table);
    setColumns((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    void loadColumnsFor(connection.id, database, table, true);
  }

  function openTable(
    connection: ConnectionMeta,
    database: string,
    table: string,
  ) {
    setSelected(`${connection.id}/${database}/table/${table}`);
    onOpenTable(connection, database, table);
  }

  function newQueryForTable(
    connection: ConnectionMeta,
    database: string,
    table: string,
  ) {
    // Use the table's own connection/database rather than whichever connection
    // happened to be active, and quote/qualify the identifier.
    void activateDatabase(connection, database);
    useAppStore
      .getState()
      .addQueryTab(selectAllSql(connection.dialect, database, table, 100));
  }

  function openFavorite(fav: FavoriteTable) {
    const connection = connections.find((item) => item.id === fav.connId);
    if (!connection) return;
    openTable(connection, fav.database, fav.table);
  }

  function locateActiveTab() {
    const store = useAppStore.getState();
    const tab = store.tabs.find((item) => item.id === store.activeTabId);
    if (!tab || tab.type !== "table") return;
    setShowStarredOnly(false);
    setShowHidden(true);
    setExpanded((current) => ({
      ...current,
      [tab.connectionId]: true,
      [`${tab.connectionId}/${tab.database}`]: true,
    }));
    setSelected(`${tab.connectionId}/${tab.database}/table/${tab.table}`);
    void loadTablesFor(tab.connectionId, tab.database);
  }

  const query = filter.trim().toLowerCase();

  function matchingColumns(
    connId: string,
    database: string,
    table: string,
  ) {
    const all = columns[columnKey(connId, database, table)] ?? [];
    if (!query) return all;
    return all.filter((column) => column.name.toLowerCase().includes(query));
  }

  function renderTree() {
    const rows: ReactNode[] = [];
    const guides = (depth: number) =>
      Array.from({ length: depth }, (_, index) => 15 + index * 14);

    if (favorites.length > 0 && !query) {
      const favExpanded = expanded["__favorites"] !== false;
      rows.push(
        <TreeRow
          key="__fav_header"
          pad={6}
          guides={[]}
          caret={favExpanded ? "icon-chevron-down" : "icon-chevron-right"}
          icon="icon-star"
          ic="var(--wn)"
          label="Favorites"
          color="var(--tx)"
          fs={12.5}
          onClick={() =>
            setExpanded((current) => ({
              ...current,
              __favorites: current["__favorites"] === false,
            }))
          }
        />,
      );
      if (favExpanded) {
        for (const fav of favorites) {
          const conn = connections.find((item) => item.id === fav.connId);
          rows.push(
            <TreeRow
              key={`fav-${fav.connId}-${fav.database}-${fav.table}`}
              pad={20}
              guides={guides(1)}
              icon="icon-table"
              ic="var(--mu)"
              label={fav.table}
              meta={conn ? `${conn.name}·${fav.database}` : fav.database}
              color="var(--tx)"
              fs={12.5}
              onClick={() => openFavorite(fav)}
            />,
          );
        }
      }
    }

    let lastHeaderGroup: string | null = null;
    for (const connection of visibleConnections) {
      const group = connGroups[connection.id] ?? "";
      if (!query && group && group !== lastHeaderGroup) {
        lastHeaderGroup = group;
        const collapsed = !!collapsedGroups[group];
        rows.push(
          <TreeRow
            key={`grp-${group}`}
            pad={6}
            guides={[]}
            caret={collapsed ? "icon-chevron-right" : "icon-chevron-down"}
            icon="icon-folder"
            ic="var(--mu)"
            label={group}
            color="var(--mu)"
            fs={11.5}
            onClick={() =>
              setCollapsedGroups((current) => ({
                ...current,
                [group]: !current[group],
              }))
            }
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const connId = event.dataTransfer.getData(
                "application/df-conn",
              );
              if (connId) setConnGroup(connId, group);
            }}
            trailing={
              <span
                onClick={(event) => {
                  event.stopPropagation();
                  toggleGroupStar(group);
                }}
                title="Star group"
                style={{
                  flex: "none",
                  display: "flex",
                  alignItems: "center",
                  color: groupStars[group] ? "var(--wn)" : "var(--fa)",
                  cursor: "default",
                }}
              >
                <i className="icon-star" style={{ fontSize: 12 }} />
              </span>
            }
          />,
        );
      }
      if (!query && group && collapsedGroups[group]) continue;

      const dbs = databasesFor(connection);
      const connectionKey = connection.id;
      const connectionOpen = query ? true : !!expanded[connectionKey];
      const isActive = connection.id === activeConnId;

      const dbEntries = dbs
        .map((database) => {
          const dbKey = `${connectionKey}/${database}`;
          const allTables = tables[tableKey(connection.id, database)] ?? [];
          const items = allTables
            .map((table) => {
              const nameMatch = table.name.toLowerCase().includes(query);
              const colHits = matchingColumns(
                connection.id,
                database,
                table.name,
              );
              return {
                table,
                nameMatch,
                colHits,
                show: !query || nameMatch || colHits.length > 0,
              };
            })
            .filter((item) => item.show);

          return { database, dbKey, allTables, items };
        })
        .filter((entry) => !query || entry.items.length > 0);

      if (query && dbEntries.length === 0) continue;

      rows.push(
        <TreeRow
          key={connectionKey}
          pad={6}
          guides={[]}
          bl={
            isProtectedEnvironment(connection.environment)
              ? environmentColor(connection.environment)
              : connPrefs[connection.id]?.color ??
                (isActive ? "var(--ac)" : "transparent")
          }
          caret={
            connectionOpen ? "icon-chevron-down" : "icon-chevron-right"
          }
          dot={
            connected[connection.id] ? "var(--ok)" : "var(--fa)"
          }
          label={connection.name}
          fs={12.5}
          meta={`${connPrefs[connection.id]?.starred ? "★ " : ""}${engineMeta(
            connection,
          )}`}
          trailing={<EnvironmentBadge environment={connection.environment} />}
          onClick={() => {
            if (!connected[connection.id]) {
              void connectAndSelect(connection);
              return;
            }
            if (connectionOpen && isActive) {
              setExpanded((current) => ({
                ...current,
                [connectionKey]: false,
              }));
              setSelected(connectionKey);
              return;
            }
            void connectAndSelect(connection);
          }}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/df-conn", connection.id);
          }}
          onContextMenu={(event) => openContextMenu(event, connection)}
          title={`${engineName(connection)}${
            connection.environment ? ` · ${connection.environment}` : ""
          } · ${connection.host}:${connection.port} · ${
            connected[connection.id] ? "connected" : "disconnected"
          }`}
        />,
      );

      const dbError = errors[`db:${connection.id}`];
      if (dbError) {
        rows.push(<TreeError key={`err-db-${connection.id}`}>{dbError}</TreeError>);
      }

      if (!connectionOpen) continue;

      if (loading[`db:${connection.id}`] && dbs.length === 0) {
        rows.push(
          <TreeRow
            key={`loading-db-${connection.id}`}
            pad={20}
            guides={guides(1)}
            label="Loading databases…"
            color="var(--mu)"
          />,
        );
        continue;
      }

      for (const entry of dbEntries) {
        const { database, dbKey, allTables, items } = entry;
        const dbOpen = query ? true : !!expanded[dbKey];

        rows.push(
          <TreeRow
            key={dbKey}
            pad={20}
            guides={guides(1)}
            caret={dbOpen ? "icon-chevron-down" : "icon-chevron-right"}
            icon="icon-database"
            ic="var(--mu)"
            label={database}
            color="var(--tx)"
            fs={12.5}
            onClick={() => {
              setSelected(dbKey);
              if (query) {
                void activateDatabase(connection, database);
                return;
              }
              if (dbOpen) {
                setExpanded((current) => ({ ...current, [dbKey]: false }));
                return;
              }
              void activateDatabase(connection, database);
            }}
            onContextMenu={(event) =>
              openDatabaseMenu(event, connection, database)
            }
            title={database}
          />,
        );

        if (!dbOpen) continue;

        const tablesError = errors[tableKey(connection.id, database)];
        if (tablesError) {
          rows.push(
            <TreeError key={`err-t-${dbKey}`}>{tablesError}</TreeError>,
          );
        }

        if (loading[tableKey(connection.id, database)] && allTables.length === 0) {
          rows.push(
            <TreeRow
              key={`loading-t-${dbKey}`}
              pad={34}
              guides={guides(2)}
              label="Loading tables…"
              color="var(--mu)"
            />,
          );
          continue;
        }

        for (const item of items) {
          const { table, colHits } = item;
          const tableCacheKey = columnKey(
            connection.id,
            database,
            table.name,
          );
          const tableKeyId = `${dbKey}/table/${table.name}`;
          const colHit = colHits.length > 0;
          const tableOpen = query
            ? colHit || !!expanded[tableKeyId]
            : !!expanded[tableKeyId];
          const loadedColumns = columns[tableCacheKey] ?? [];
          const columnsToShow = loadedColumns;
          const tableActivated =
            activeTableTab?.connectionId === connection.id &&
            activeTableTab.database === database &&
            activeTableTab.table === table.name;

          rows.push(
            <TreeRow
              key={tableKeyId}
              pad={34}
              guides={guides(2)}
              bg={
                selected === tableKeyId || tableActivated
                  ? "var(--sel)"
                  : "transparent"
              }
              caret={tableOpen ? "icon-chevron-down" : "icon-chevron-right"}
              icon="icon-table"
              ic="var(--mu)"
              label={table.name}
              color="var(--tx)"
              fs={12.5}
              onClick={() => {
                setSelected(tableKeyId);
                if (tableOpen) {
                  setExpanded((current) => ({
                    ...current,
                    [tableKeyId]: false,
                  }));
                  return;
                }
                setExpanded((current) => ({ ...current, [tableKeyId]: true }));
                void loadColumnsFor(connection.id, database, table.name);
              }}
              onDoubleClick={() =>
                openTable(connection, database, table.name)
              }
              onContextMenu={(event) =>
                openTableMenu(event, connection, database, table.name)
              }
              title="Double-click to open the table data"
            />,
          );

          if (!tableOpen) continue;

          const columnsError = errors[tableCacheKey];
          if (columnsError) {
            rows.push(
              <TreeError key={`err-c-${tableKeyId}`}>{columnsError}</TreeError>,
            );
            continue;
          }

          if (loading[tableCacheKey] && loadedColumns.length === 0) {
            rows.push(
              <TreeRow
                key={`loading-c-${tableKeyId}`}
                pad={48}
                guides={guides(3)}
                label="Loading columns…"
                color="var(--mu)"
              />,
            );
            continue;
          }

          for (const column of columnsToShow) {
            const columnId = `${tableKeyId}/${column.name}`;
            const hit = query && column.name.toLowerCase().includes(query);
            rows.push(
              <TreeRow
                key={columnId}
                pad={48}
                guides={guides(3)}
                icon={columnIcon(column)}
                ic={column.key === "PRI" ? "var(--wn)" : "var(--fa)"}
                label={column.name}
                color={hit ? "var(--ac)" : "var(--mu)"}
                ff="var(--mono)"
                fs={12}
                meta={column.data_type}
                onClick={() => setSelected(columnId)}
              />,
            );
          }
        }
      }
    }

    if (hiddenCount > 0 && !query) {
      rows.push(
        <TreeRow
          key="__show_hidden"
          pad={6}
          guides={[]}
          icon={showHidden ? "icon-eye-off" : "icon-eye"}
          ic="var(--fa)"
          label={
            showHidden ? "Hide hidden" : `Show hidden (${hiddenCount})`
          }
          color="var(--fa)"
          fs={11.5}
          onClick={() => setShowHidden((value) => !value)}
        />,
      );
    }

    return rows;
  }

  const rows = renderTree();
  const contextConnection = contextMenu
    ? (connections.find(
        (connection) => connection.id === contextMenu.connectionId,
      ) ?? null)
    : null;

  return (
    <aside
      style={{
        width,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        background: "var(--sf)",
        borderRight: width > 0 ? "1px solid var(--bd)" : "none",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: 32,
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 8px 0 10px",
          borderBottom: "1px solid var(--bd)",
        }}
      >
        <i className="icon-search" style={{ fontSize: 13, color: "var(--fa)" }} />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter"
          style={{
            flex: 1,
            minWidth: 0,
            height: 24,
            border: 0,
            background: "transparent",
            fontSize: 12.5,
            color: "var(--tx)",
          }}
        />
        <button
          type="button"
          className="df2-icon-btn"
          onClick={() => setShowStarredOnly((value) => !value)}
          title="Show starred only"
          style={{
            width: 22,
            height: 22,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: 0,
            borderRadius: 4,
            background: "transparent",
            color: showStarredOnly ? "var(--wn)" : "var(--mu)",
            cursor: "default",
            padding: 0,
          }}
        >
          <i className="icon-star" style={{ fontSize: 13 }} />
        </button>
        <button
          type="button"
          className="df2-icon-btn"
          onClick={locateActiveTab}
          title="Locate active tab"
          style={{
            width: 22,
            height: 22,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: 0,
            borderRadius: 4,
            background: "transparent",
            color: "var(--mu)",
            cursor: "default",
            padding: 0,
          }}
        >
          <i className="icon-crosshair" style={{ fontSize: 13 }} />
        </button>
        <button
          type="button"
          className="df2-icon-btn"
          onClick={onNewConnection}
          title="New connection"
          style={{
            width: 22,
            height: 22,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: 0,
            borderRadius: 4,
            background: "transparent",
            color: "var(--mu)",
            cursor: "default",
            padding: 0,
          }}
        >
          <i className="icon-plus" style={{ fontSize: 14 }} />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "4px 0" }}>
        {connections.length === 0 ? (
          <TreeNotice>
            No connections yet.{" "}
            <button
              type="button"
              onClick={onNewConnection}
              style={{
                padding: 0,
                border: 0,
                background: "none",
                color: "var(--ac)",
                cursor: "default",
              }}
            >
              Add one
            </button>
          </TreeNotice>
        ) : rows.length === 0 && query ? (
          <TreeNotice>
            No tables or columns match “{filter}”.
          </TreeNotice>
        ) : (
          rows
        )}
      </div>

      {contextMenu && contextConnection && (
        <>
          <div
            onMouseDown={() => setContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
            }}
            style={{ position: "fixed", inset: 0, zIndex: 50 }}
          />
          <div
            style={{
              position: "fixed",
              left: contextMenu.x,
              top: contextMenu.y,
              zIndex: 51,
              minWidth: 208,
              padding: 4,
              background: "var(--sf)",
              border: "1px solid var(--bd2)",
              borderRadius: 6,
              boxShadow: "var(--sh)",
            }}
          >
            {contextMenu.kind === "connection" && (
              <>
                <MenuItem
                  icon="icon-plug"
                  label="Connect"
                  onClick={() => {
                    setContextMenu(null);
                    void connectAndSelect(contextConnection);
                  }}
                />
                <MenuItem
                  icon="icon-unplug"
                  label="Disconnect"
                  onClick={() => {
                    setContextMenu(null);
                    void disconnectOnly(contextConnection);
                  }}
                />
                <MenuSeparator />
                <MenuItem
                  icon="icon-pencil"
                  label="Edit connection…"
                  onClick={() => {
                    setContextMenu(null);
                    onEditConnection(contextConnection);
                  }}
                />
                <MenuItem
                  icon="icon-refresh-cw"
                  label="Refresh schema"
                  onClick={() => {
                    setContextMenu(null);
                    refreshConnection(contextConnection);
                  }}
                />
                <MenuSeparator />
                <div
                  style={{ display: "flex", gap: 5, padding: "5px 8px 3px" }}
                >
                  {CONN_COLORS.map((color) => {
                    const active =
                      (connPrefs[contextConnection.id]?.color ?? undefined) ===
                      color.value;
                    return (
                      <button
                        key={color.name}
                        type="button"
                        title={color.name}
                        onClick={() => {
                          setConnPref(contextConnection.id, {
                            color: color.value,
                          });
                          setContextMenu(null);
                        }}
                        style={{
                          width: 16,
                          height: 16,
                          flex: "none",
                          borderRadius: 4,
                          border: active
                            ? "2px solid var(--tx)"
                            : "1px solid var(--bd2)",
                          background: color.value ?? "transparent",
                          cursor: "default",
                        }}
                      />
                    );
                  })}
                </div>
                <MenuItem
                  icon="icon-star"
                  label={
                    connPrefs[contextConnection.id]?.starred ? "Unstar" : "Star"
                  }
                  onClick={() => {
                    setConnPref(contextConnection.id, {
                      starred: !connPrefs[contextConnection.id]?.starred,
                    });
                    setContextMenu(null);
                  }}
                />
                <MenuItem
                  icon={
                    connPrefs[contextConnection.id]?.hidden
                      ? "icon-eye"
                      : "icon-eye-off"
                  }
                  label={
                    connPrefs[contextConnection.id]?.hidden ? "Unhide" : "Hide"
                  }
                  onClick={() => {
                    setConnPref(contextConnection.id, {
                      hidden: !connPrefs[contextConnection.id]?.hidden,
                    });
                    setContextMenu(null);
                  }}
                />
                <MenuItem
                  icon="icon-folder"
                  label="Set group…"
                  onClick={() => {
                    setGroupEditValue(
                      connGroups[contextConnection.id] ?? "",
                    );
                    setGroupEditFor(contextConnection.id);
                    setContextMenu(null);
                  }}
                />
                {connGroups[contextConnection.id] && (
                  <MenuItem
                    icon="icon-folder-minus"
                    label="Remove from group"
                    onClick={() => {
                      setConnGroup(contextConnection.id, undefined);
                      setContextMenu(null);
                    }}
                  />
                )}
                <MenuSeparator />
                <MenuItem
                  icon="icon-trash-2"
                  label="Delete connection"
                  danger
                  onClick={() => void removeConnection(contextConnection)}
                />
              </>
            )}

            {contextMenu.kind === "database" && (
              <>
                <MenuItem
                  icon="icon-check"
                  label="Set as active"
                  onClick={() => {
                    setContextMenu(null);
                    void activateDatabase(
                      contextConnection,
                      contextMenu.database,
                    );
                  }}
                />
                <MenuItem
                  icon="icon-network"
                  label="ER diagram"
                  onClick={() => {
                    const menu = contextMenu;
                    setContextMenu(null);
                    onOpenErd(contextConnection, menu.database);
                  }}
                />
                <MenuItem
                  icon="icon-table-2"
                  label="Create table…"
                  onClick={() => {
                    const menu = contextMenu;
                    setContextMenu(null);
                    setCreateFor({
                      connection: contextConnection,
                      database: menu.database,
                    });
                  }}
                />
                <MenuItem
                  icon="icon-refresh-cw"
                  label="Refresh"
                  onClick={() => {
                    setContextMenu(null);
                    refreshDatabase(contextConnection, contextMenu.database);
                  }}
                />
              </>
            )}

            {contextMenu.kind === "table" && (
              <>
                <MenuItem
                  icon="icon-table"
                  label="Open table data"
                  kbd="↵"
                  onClick={() => {
                    setContextMenu(null);
                    openTable(
                      contextConnection,
                      contextMenu.database,
                      contextMenu.table,
                    );
                  }}
                />
                <MenuItem
                  icon="icon-code"
                  label="New query"
                  onClick={() => {
                    setContextMenu(null);
                    newQueryForTable(
                      contextConnection,
                      contextMenu.database,
                      contextMenu.table,
                    );
                  }}
                />
                <MenuItem
                  icon="icon-search"
                  label="Search in this table…"
                  onClick={() => {
                    const menu = contextMenu;
                    setContextMenu(null);
                    onFindInTable(menu.connectionId, menu.database, menu.table);
                  }}
                />
                <MenuItem
                  icon="icon-upload"
                  label="Import CSV…"
                  onClick={() => {
                    const menu = contextMenu;
                    const connection = contextConnection;
                    setContextMenu(null);
                    void open({
                      multiple: false,
                      filters: [
                        { name: "CSV", extensions: ["csv", "tsv", "txt"] },
                      ],
                    })
                      .then((selected) => {
                        if (typeof selected !== "string") return;
                        setImportFor({
                          connection,
                          database: menu.database,
                          table: menu.table,
                          path: selected,
                        });
                      })
                      .catch((error) => storeError(error));
                  }}
                />
                <MenuItem
                  icon="icon-copy"
                  label="Copy name"
                  onClick={() => {
                    setContextMenu(null);
                    void navigator.clipboard
                      .writeText(contextMenu.table)
                      .catch(() => {});
                  }}
                />
                <MenuItem
                  icon="icon-star"
                  label={
                    favorites.some(
                      (fav) =>
                        fav.connId === contextConnection.id &&
                        fav.database === contextMenu.database &&
                        fav.table === contextMenu.table,
                    )
                      ? "Remove from Favorites"
                      : "Add to Favorites"
                  }
                  onClick={() => {
                    setContextMenu(null);
                    toggleFavorite({
                      connId: contextConnection.id,
                      database: contextMenu.database,
                      table: contextMenu.table,
                    });
                  }}
                />
                <MenuSeparator />
                <MenuItem
                  icon="icon-table-2"
                  label="Design table…"
                  onClick={() => {
                    const menu = contextMenu;
                    setContextMenu(null);
                    setStructureFor({
                      connection: contextConnection,
                      database: menu.database,
                      table: menu.table,
                    });
                  }}
                />
                <MenuItem
                  icon="icon-refresh-cw"
                  label="Refresh"
                  onClick={() => {
                    setContextMenu(null);
                    refreshTable(
                      contextConnection,
                      contextMenu.database,
                      contextMenu.table,
                    );
                  }}
                />
                <MenuSeparator />
                <MenuItem
                  icon="icon-trash-2"
                  label="Drop table…"
                  danger
                  onClick={() => {
                    const menu = contextMenu;
                    setContextMenu(null);
                    setDropFor({
                      connection: contextConnection,
                      database: menu.database,
                      table: menu.table,
                    });
                  }}
                />
              </>
            )}
          </div>
        </>
      )}

      {structureFor && (
        <Suspense fallback={dialogFallback}>
          <StructureDialog
            connId={structureFor.connection.id}
            database={structureFor.database}
            table={structureFor.table}
            dialect={structureFor.connection.dialect as Dialect}
            onClose={() => setStructureFor(null)}
            onApplied={() =>
              refreshTable(
                structureFor.connection,
                structureFor.database,
                structureFor.table,
              )
            }
          />
        </Suspense>
      )}

      {importFor && (
        <Suspense fallback={dialogFallback}>
          <ImportCsvDialog
            connId={importFor.connection.id}
            database={importFor.database}
            table={importFor.table}
            path={importFor.path}
            onClose={() => setImportFor(null)}
            onImported={() =>
              refreshTable(
                importFor.connection,
                importFor.database,
                importFor.table,
              )
            }
          />
        </Suspense>
      )}

      {createFor && (
        <CreateTableDialog
          connId={createFor.connection.id}
          database={createFor.database}
          dialect={createFor.connection.dialect as Dialect}
          onClose={() => setCreateFor(null)}
          onCreated={() => refreshDatabase(createFor.connection, createFor.database)}
        />
      )}

      {dropFor && (
        <>
          <div
            onMouseDown={() => !dropBusy && setDropFor(null)}
            style={{ position: "fixed", inset: 0, zIndex: 72, background: "var(--ov)" }}
          />
          <div
            style={{
              position: "fixed",
              left: "50%",
              top: "34%",
              transform: "translateX(-50%)",
              zIndex: 73,
              width: 380,
              maxWidth: "90vw",
              padding: 16,
              background: "var(--sf)",
              border: "1px solid var(--bd2)",
              borderRadius: 8,
              boxShadow: "var(--sh)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <i className="icon-trash-2" style={{ fontSize: 15, color: "var(--er)" }} />
              <span style={{ fontSize: 13, fontWeight: 500 }}>Drop table</span>
            </div>
            <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--mu)", lineHeight: 1.5 }}>
              Permanently drop{" "}
              <code style={{ fontFamily: "var(--mono)" }}>
                {dropFor.database}.{dropFor.table}
              </code>{" "}
              and all its data? This cannot be undone.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                className="v2-btn"
                disabled={dropBusy}
                onClick={() => setDropFor(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="v2-btn"
                disabled={dropBusy}
                onClick={() => {
                  const target = dropFor;
                  const sql = dropTableSql(
                    target.connection.dialect as Dialect,
                    target.database,
                    target.table,
                  );
                  void (async () => {
                    setDropBusy(true);
                    try {
                      const guard = await guardSqlExecution(
                        target.connection,
                        sql,
                        target.database,
                      );
                      if (!guard.allow) {
                        if (guard.error) storeError(guard.error);
                        return;
                      }
                      await runQuery(
                        target.connection.id,
                        sql,
                        0,
                        target.database,
                      );
                      setDropFor(null);
                      refreshDatabase(target.connection, target.database);
                    } catch (dropError) {
                      storeError(errorMessage(dropError));
                    } finally {
                      setDropBusy(false);
                    }
                  })();
                }}
                style={{ background: "var(--er)", borderColor: "var(--er)", color: "#fff" }}
              >
                {dropBusy ? "Dropping…" : "Drop table"}
              </button>
            </div>
          </div>
        </>
      )}

      {groupEditFor && (
        <>
          <div
            onMouseDown={() => setGroupEditFor(null)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 60,
              background: "var(--ov)",
            }}
          />
          <div
            style={{
              position: "fixed",
              left: "50%",
              top: "40%",
              transform: "translate(-50%, -50%)",
              zIndex: 61,
              width: 300,
              padding: 14,
              background: "var(--sf)",
              border: "1px solid var(--bd2)",
              borderRadius: 8,
              boxShadow: "var(--sh)",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 500 }}>Set group</span>
            <input
              autoFocus
              value={groupEditValue}
              onChange={(event) => setGroupEditValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setConnGroup(groupEditFor, groupEditValue);
                  setGroupEditFor(null);
                } else if (event.key === "Escape") {
                  setGroupEditFor(null);
                }
              }}
              placeholder="Group name (empty = none)"
              spellCheck={false}
              style={{
                height: 28,
                padding: "0 8px",
                border: "1px solid var(--bd2)",
                borderRadius: 4,
                background: "var(--bg)",
                color: "var(--tx)",
                fontSize: 12.5,
              }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
              }}
            >
              <button
                type="button"
                className="v2-btn"
                onClick={() => setGroupEditFor(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="v2-btn v2-btn-primary"
                onClick={() => {
                  setConnGroup(groupEditFor, groupEditValue);
                  setGroupEditFor(null);
                }}
              >
                Save
              </button>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

function tableKey(connId: string, database: string) {
  return `t:${connId}/${database}`;
}

function columnKey(connId: string, database: string, table: string) {
  return `c:${connId}/${database}/${table}`;
}
