import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import lockupOnLight from "./assets/lockup.png";
import lockupOnDark from "./assets/lockup-light.png";
import changelogRaw from "../CHANGELOG.md?raw";
import CommandPalette from "./components/CommandPalette";
import type { CommandAction } from "./components/CommandPalette";
import DataGrid from "./components/DataGrid";
import Sidebar from "./components/Sidebar";
import SqlEditor from "./components/SqlEditor";
import type { SqlEditorHandle } from "./components/SqlEditor";
import TableDataView from "./components/TableDataView";
import EnvironmentBadge from "./components/EnvironmentBadge";
import WhatsNewDialog from "./components/WhatsNewDialog";
import { compareVersions, parseVersionSection } from "./changelog";
import {
  aiExplain,
  aiFixError,
  aiHasKey,
  aiOptimize,
  connectConnection,
  errorMessage,
  explainPlan,
  exportResultXlsx,
  listConnectionStates,
  listConnections,
  runQuery,
} from "./ipc";
import { notify } from "./notifications";
import { formatSql, selectAllSql } from "./sql";
import { environmentColor, isProtectedEnvironment } from "./environment";
import { guardSqlExecution } from "./prodGuard";
import { useAppStore } from "./store";
import type { TableTab } from "./store";
import type {
  AiActionState,
  AiTextTarget,
  ChatRequest,
  ChatResultContext,
  ConnectionMeta,
} from "./types";

const AiActionPanel = lazy(() => import("./components/AiActionPanel"));
const AiPanel = lazy(() => import("./components/AiPanel"));
const ErDiagram = lazy(() => import("./components/ErDiagram"));
const PlanView = lazy(() => import("./components/PlanView"));
const ConnectionDialog = lazy(() => import("./components/ConnectionDialog"));
const FindDialog = lazy(() => import("./components/FindDialog"));
const HistoryDialog = lazy(() => import("./components/HistoryDialog"));
const ProdConfirmDialog = lazy(() => import("./components/ProdConfirmDialog"));
const SchemaCompareDialog = lazy(
  () => import("./components/SchemaCompareDialog"),
);

const dialogFallback = (
  <div style={{ position: "fixed", inset: 0 }} aria-hidden="true" />
);

type Theme = "dark" | "light";

function detectUiLanguage(): "az" | "en" {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("dataforge-language");
  } catch {
    stored = null;
  }
  if (stored === "az" || stored === "en") return stored;
  return (navigator.language || "en").toLowerCase().startsWith("az")
    ? "az"
    : "en";
}

const UI_LANGUAGE = detectUiLanguage();

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

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

function engineShort(dialect: string, flavor?: string) {
  if (flavor && FLAVOR_SHORT[flavor]) return FLAVOR_SHORT[flavor];
  if (dialect === "postgres") return "pg";
  if (dialect === "mongodb") return "mongo";
  return dialect;
}

function engineLabel(dialect: string | undefined, flavor?: string) {
  if (flavor && FLAVOR_LABELS[flavor]) return FLAVOR_LABELS[flavor];
  if (dialect === "postgres") return "PostgreSQL";
  if (dialect === "sqlite") return "SQLite";
  if (dialect === "mssql") return "SQL Server";
  if (dialect === "mongodb") return "MongoDB";
  if (dialect === "mysql") return "MySQL";
  return "—";
}

export default function App() {
  const connections = useAppStore((state) => state.connections);
  const connected = useAppStore((state) => state.connected);
  const activeConnId = useAppStore((state) => state.activeConnId);
  const activeDb = useAppStore((state) => state.activeDb);
  const databases = useAppStore((state) => state.databases);
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const connPrefs = useAppStore((state) => state.connPrefs);
  const error = useAppStore((state) => state.error);
  const running = useAppStore((state) => state.running);
  const activeView = useAppStore((state) => state.tabStates[state.activeTabId]);
  const setActiveDb = useAppStore((state) => state.setActiveDb);
  const activePlan =
    activeView?.plan &&
    (!activeView.connId || activeView.connId === activeConnId) &&
    (!activeView.database || activeView.database === activeDb)
      ? activeView.plan
      : null;
  const showPlan =
    !!activePlan && (activeView?.resultTab ?? "results") === "plan";

  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem("dataforge-theme") === "light" ? "light" : "dark",
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConnection, setEditingConnection] =
    useState<ConnectionMeta | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiSettingsSignal, setAiSettingsSignal] = useState(0);
  const [chatRequest, setChatRequest] = useState<ChatRequest | null>(null);
  const [aiAction, setAiAction] = useState<AiActionState | null>(null);
  const [aiBusy, setAiBusy] = useState<
    "fix" | "explain" | "optimize" | null
  >(null);
  const [planBusy, setPlanBusy] = useState(false);
  const editorApiRef = useRef<SqlEditorHandle | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appVersion, setAppVersion] = useState("0.1.0");
  const [sideOpen, setSideOpen] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  const [findOpen, setFindOpen] = useState<{
    connId: string;
    database: string;
    table?: string;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState<{
    connId: string | null;
    database: string | null;
  } | null>(null);
  const [sideW, setSideW] = useState(248);
  const [aiW, setAiW] = useState(320);
  const [editorH, setEditorH] = useState(236);
  const [hoverTab, setHoverTab] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    kind: "conn" | "db";
    x: number;
    y: number;
  } | null>(null);
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    notes: string;
  } | null>(null);
  const [whatsNew, setWhatsNew] = useState<{
    version: string;
    notes: string;
  } | null>(null);
  const [updateBusy, setUpdateBusy] = useState<string | null>(null);
  // Holds the pending Update handle between "check" and "install" without
  // forcing re-renders (the object is not serialisable React state).
  const pendingUpdateRef = useRef<{
    version: string;
    body?: string;
    downloadAndInstall: () => Promise<void>;
  } | null>(null);

  // Check GitHub for a newer release. `silent` suppresses the "up to date" /
  // failure toasts used by the automatic startup check.
  const checkForUpdates = useCallback(async (silent: boolean) => {
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        pendingUpdateRef.current = update as typeof pendingUpdateRef.current;
        const notes =
          update.body?.trim() ||
          parseVersionSection(changelogRaw, update.version) ||
          "See CHANGELOG.md";
        const dismissed = localStorage.getItem("df-dismissed-update-version");
        const show = !silent || dismissed !== update.version;
        if (show) {
          setUpdateInfo({ version: update.version, notes });
          if (silent) {
            void notify("DataForge", `Update available: v${update.version}`);
          }
        }
      } else {
        pendingUpdateRef.current = null;
        if (!silent) void notify("DataForge", "You're on the latest version.");
      }
    } catch (updateError) {
      if (!silent) {
        void notify("DataForge", "Update check failed: " + String(updateError));
      }
    }
  }, []);

  const installUpdate = useCallback(async () => {
    const update = pendingUpdateRef.current;
    if (!update) return;
    setUpdateBusy("Downloading…");
    try {
      await update.downloadAndInstall();
      setUpdateBusy("Restarting…");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (installError) {
      setUpdateBusy(null);
      void notify("DataForge", "Update failed: " + String(installError));
    }
  }, []);

  const dismissUpdate = useCallback(() => {
    if (updateInfo) {
      localStorage.setItem("df-dismissed-update-version", updateInfo.version);
    }
    setUpdateInfo(null);
  }, [updateInfo]);

  useEffect(() => {
    let cancelled = false;

    getVersion()
      .then((version) => {
        if (cancelled) return;
        const lastSeen = localStorage.getItem("df-last-seen-version");
        // Builds before 0.4.0 never stored a version; any other df-* key means this
        // is an update from one of them, not a fresh install.
        const updatedFromOld =
          !lastSeen &&
          Object.keys(localStorage).some(
            (key) => key.startsWith("df-") && key !== "df-last-seen-version",
          );
        if (updatedFromOld || (lastSeen && compareVersions(version, lastSeen) > 0)) {
          const notes =
            parseVersionSection(changelogRaw, version) || "See CHANGELOG.md";
          setWhatsNew({ version, notes });
        }
        localStorage.setItem("df-last-seen-version", version);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const activeConnection =
    connections.find((connection) => connection.id === activeConnId) ?? null;
  const activeConnected = activeConnId ? !!connected[activeConnId] : false;
  const activeEnvironment = activeConnection?.environment;
  const activeEnvColor = isProtectedEnvironment(activeEnvironment)
    ? environmentColor(activeEnvironment)
    : undefined;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const dragRef = useRef<{
    kind: "side" | "split" | "ai";
    x: number;
    y: number;
    value: number;
  } | null>(null);
  // Monotonic per-tab execution id: a slow earlier run must never overwrite the
  // result of a newer run in the same tab.
  const requestIdsRef = useRef<Record<string, number>>({});

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("dataforge-theme", theme);
  }, [theme]);

  // Automatically check for a newer release shortly after launch, then once a
  // day while the app stays open. Shows the in-app banner if one is found.
  useEffect(() => {
    const first = window.setTimeout(() => void checkForUpdates(true), 4000);
    const daily = window.setInterval(
      () => void checkForUpdates(true),
      24 * 60 * 60 * 1000,
    );
    return () => {
      window.clearTimeout(first);
      window.clearInterval(daily);
    };
  }, [checkForUpdates]);

  useEffect(() => {
    let cancelled = false;

    listConnections()
      .then(async (items) => {
        if (cancelled) return;
        const store = useAppStore.getState();
        store.setConnections(items);
        if (!store.activeConnId && items.length > 0) {
          store.setActiveConn(items[0].id);
        }

        try {
          const states = await listConnectionStates();
          if (!cancelled) {
            useAppStore.getState().setConnectionStates(states);
          }
        } catch {
          if (!cancelled) {
            useAppStore.getState().setConnectionStates([]);
          }
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          useAppStore.getState().setError(errorMessage(loadError));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      if (drag.kind === "side") {
        setSideW(clamp(drag.value + event.clientX - drag.x, 180, 440));
      } else if (drag.kind === "ai") {
        setAiW(clamp(drag.value - (event.clientX - drag.x), 260, 560));
      } else {
        setEditorH(
          clamp(drag.value + event.clientY - drag.y, 80, window.innerHeight - 200),
        );
      }
    };

    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (mod && key === "k") {
        event.preventDefault();
        event.stopPropagation();
        setPaletteOpen((open) => !open);
      } else if (mod && key === "b") {
        event.preventDefault();
        event.stopPropagation();
        setSideOpen((open) => !open);
      } else if (mod && key === "i") {
        // Capture + stop so Monaco (which binds Ctrl+I to "trigger suggest") never sees it.
        event.preventDefault();
        event.stopPropagation();
        setAiOpen((open) => !open);
      } else if (event.key === "Escape") {
        setPaletteOpen(false);
        setMenu(null);
        setAboutOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const zoomKey =
        mod &&
        (key === "+" ||
          key === "=" ||
          key === "-" ||
          key === "_" ||
          key === "0" ||
          event.code === "NumpadAdd" ||
          event.code === "NumpadSubtract");
      const reloadKey = event.key === "F5" || (mod && key === "r");
      const devtoolsKey =
        !import.meta.env.DEV &&
        (event.key === "F12" || (mod && event.shiftKey && key === "i"));

      if (zoomKey || reloadKey || devtoolsKey) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
      }
    };

    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    window.addEventListener("contextmenu", onContextMenu, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    const bind = async (event: string, handler: () => void) => {
      try {
        const unlisten = await listen(event, handler);
        if (cancelled) unlisten();
        else unlisteners.push(unlisten);
      } catch {
        // The menu is only available inside Tauri.
      }
    };

    void (async () => {
      await bind("menu:new-query", () => {
        useAppStore.getState().addQueryTab("");
      });
      await bind("menu:close-tab", () => {
        const store = useAppStore.getState();
        if (store.activeTabId) store.closeTab(store.activeTabId);
      });
      await bind("menu:toggle-theme", () => {
        setTheme((current) => (current === "dark" ? "light" : "dark"));
      });
      await bind("menu:toggle-ai", () => {
        setAiOpen((open) => !open);
      });
      await bind("menu:toggle-sidebar", () => {
        setSideOpen((open) => !open);
      });
      await bind("menu:focus-mode", () => {
        setFocusMode((value) => !value);
      });
      await bind("menu:about", () => {
        setAboutOpen(true);
      });

      let zoom = 1;
      const applyZoom = (next: number) => {
        zoom = Math.min(2, Math.max(0.5, Math.round(next * 100) / 100));
        document.body.style.zoom = String(zoom);
      };
      await bind("menu:reload", () => {
        window.location.reload();
      });
      await bind("menu:close-all-tabs", () => {
        useAppStore.getState().closeAllTabs();
      });
      await bind("menu:zoom-in", () => applyZoom(zoom + 0.1));
      await bind("menu:zoom-out", () => applyZoom(zoom - 0.1));
      await bind("menu:zoom-reset", () => applyZoom(1));
      await bind("menu:check-updates", () => {
        void checkForUpdates(false);
      });
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (focusMode) {
      setSideOpen(false);
      setAiOpen(false);
    } else {
      setSideOpen(true);
    }
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setFullscreen(focusMode);
      } catch {
        // not running inside Tauri
      }
    })();
  }, [focusMode]);

  useEffect(() => {
    if (!aboutOpen) return;
    getVersion()
      .then((version) => setAppVersion(version))
      .catch(() => {});
  }, [aboutOpen]);

  const executeSql = useCallback(
    async (
      connId: string,
      query: string,
      database: string | undefined,
      tabId: string | undefined,
      maxRows = 1000,
      orderBy = "",
    ) => {
      const store = useAppStore.getState();
      const target = tabId ?? store.activeTabId;
      const queryTab = store.tabs.find((tab) => tab.id === target)?.type === "query";
      const started = performance.now();
      const requestId = (requestIdsRef.current[target] ?? 0) + 1;
      requestIdsRef.current[target] = requestId;
      const isCurrent = () => requestIdsRef.current[target] === requestId;

      const guard = await guardSqlExecution(connId, query, database);
      if (!guard.allow) {
        if (guard.error) store.setError(guard.error, target);
        return;
      }

      store.setRunning(true, target);
      store.setError(null, target);
      store.setExecutedSql(query, target);
      store.setPlan(null, target);
      store.setResultTab("results", target);

      try {
        const result = await runQuery(
          connId,
          query,
          maxRows,
          database,
          orderBy,
        );
        if (!isCurrent()) return;
        useAppStore
          .getState()
          .setResult(result, target, connId, database ?? null);
        const elapsed = Math.round(performance.now() - started);
        if (queryTab && elapsed >= 1500) {
          const rows = result.rows.length
            ? `${result.rows.length.toLocaleString("en-US")} rows`
            : `${result.rows_affected ?? 0} rows affected`;
          void notify("Query complete", `${rows} · ${elapsed} ms`);
        }
      } catch (runError) {
        if (!isCurrent()) return;
        useAppStore.getState().setResult(null, target, connId, database ?? null);
        useAppStore.getState().setError(errorMessage(runError), target);
        const elapsed = Math.round(performance.now() - started);
        if (queryTab && elapsed >= 1500) {
          void notify("Query failed", `After ${elapsed} ms — ${errorMessage(runError)}`);
        }
      } finally {
        if (isCurrent()) {
          useAppStore.getState().setRunning(false, target);
        }
      }
    },
    [],
  );

  const loadTableData = useCallback(
    async (tab: TableTab, whereOverride?: string, orderByOverride?: string) => {
      const state = useAppStore.getState();
      const connection = state.connections.find(
        (item) => item.id === tab.connectionId,
      );

      if (!connection) {
        state.setError(
          "Connection not found. Connect again from the sidebar.",
          tab.id,
        );
        return;
      }

      if (!state.connected[connection.id]) {
        try {
          await connectConnection(connection.id);
          useAppStore.getState().setConnected(connection.id, true);
        } catch (connectionError) {
          useAppStore.getState().setError(
            errorMessage(connectionError),
            tab.id,
          );
          return;
        }
      }

      const sql = selectAllSql(
        connection.dialect,
        tab.database,
        tab.table,
        tab.limit,
        whereOverride ?? tab.where,
      );
      await executeSql(
        tab.connectionId,
        sql,
        tab.database,
        tab.id,
        tab.limit,
        orderByOverride ?? tab.orderBy,
      );
    },
    [executeSql],
  );

  const handleRun = useCallback(
    async (sqlOverride?: string) => {
      const store = useAppStore.getState();
      const tab = store.tabs.find((item) => item.id === store.activeTabId);

      if (!tab || tab.type !== "query") {
        store.setError("Open a New Query tab to write and run SQL.");
        return;
      }

      const query = sqlOverride ?? store.selection ?? store.sql;

      if (store.tabStates[tab.id]?.running) {
        store.setError("A query is already running in this tab.", tab.id);
        return;
      }
      if (!store.activeConnId) {
        store.setError("Select a connection first.");
        return;
      }
      if (!store.connected[store.activeConnId]) {
        store.setError("Connect to the database first.");
        return;
      }
      if (!query.trim()) {
        store.setError("The SQL editor is empty.");
        return;
      }

      store.pushQueryHistory(query, store.activeConnId, store.activeDb ?? undefined);
      await executeSql(
        store.activeConnId,
        query,
        store.activeDb ?? undefined,
        tab.id,
      );
    },
    [executeSql],
  );

  const handleRunChatSql = useCallback(
    (sql: string) => {
      const store = useAppStore.getState();
      if (!sql.trim()) return;
      if (!store.activeConnId || !store.connected[store.activeConnId]) {
        store.setError("Connect to the database first.");
        return;
      }

      const tab = store.tabs.find((item) => item.id === store.activeTabId);
      if (tab?.type === "query" && store.tabStates[tab.id]?.running) {
        store.setError("A query is already running in this tab.", tab.id);
        return;
      }

      const tabId =
        tab?.type === "query" ? tab.id : store.addQueryTab(sql, "AI chat");
      store.pushQueryHistory(
        sql,
        store.activeConnId,
        store.activeDb ?? undefined,
      );
      void executeSql(
        store.activeConnId,
        sql,
        store.activeDb ?? undefined,
        tabId,
      );
    },
    [executeSql],
  );

  const handleExplainResult = useCallback((context: ChatResultContext) => {
    setChatRequest({
      id: Date.now(),
      content: "Explain/summarize this result",
      result: context,
    });
    setAiOpen(true);
  }, []);

  const handleOpenTable = useCallback(
    async (connection: ConnectionMeta, database: string, table: string) => {
      const store = useAppStore.getState();

      if (
        store.activeConnId !== connection.id &&
        !store.setActiveConn(connection.id)
      ) {
        return;
      }
      store.setActiveDb(database);

      if (!store.connected[connection.id]) {
        try {
          await connectConnection(connection.id);
          useAppStore.getState().setConnected(connection.id, true);
        } catch (connectError) {
          useAppStore.getState().setError(errorMessage(connectError));
          return;
        }
      }

      const tabId = useAppStore
        .getState()
        .addTableTab(connection.id, database, table, 1000);
      const tab = useAppStore
        .getState()
        .tabs.find((item) => item.id === tabId);

      if (tab?.type === "table") {
        await loadTableData(tab);
      }
    },
    [loadTableData],
  );

  const handleOpenErd = useCallback(
    async (connection: ConnectionMeta, database: string) => {
      const store = useAppStore.getState();
      if (
        store.activeConnId !== connection.id &&
        !store.setActiveConn(connection.id)
      ) {
        return;
      }
      store.setActiveDb(database);

      if (!store.connected[connection.id]) {
        try {
          await connectConnection(connection.id);
          useAppStore.getState().setConnected(connection.id, true);
        } catch (connectError) {
          useAppStore.getState().setError(errorMessage(connectError));
          return;
        }
      }

      useAppStore.getState().addErdTab(connection.id, database);
    },
    [],
  );

  const handleTableRefresh = useCallback(
    async (tab: TableTab, where: string, orderBy = "") => {
      const store = useAppStore.getState();
      const pending = store.pendingChanges[tab.id]?.length ?? 0;
      if (
        pending > 0 &&
        !window.confirm(`Discard ${pending} unsaved changes?`)
      ) {
        return;
      }
      if (pending > 0) store.clearPendingChanges(tab.id);
      store.setTableWhere(tab.id, where);
      store.setTableOrderBy(tab.id, orderBy);
      const latest = store.tabs.find((item) => item.id === tab.id);
      if (latest?.type === "table") {
        await loadTableData(latest, where, orderBy);
      }
    },
    [loadTableData],
  );

  const handleTopRun = useCallback(() => {
    const store = useAppStore.getState();
    const tab = store.tabs.find((item) => item.id === store.activeTabId);
    if (tab && store.tabStates[tab.id]?.running) return;
    if (tab?.type === "table") {
      void handleTableRefresh(tab, tab.where, tab.orderBy);
      return;
    }
    void handleRun();
  }, [handleRun, handleTableRefresh]);

  const handleFormat = useCallback(() => {
      const store = useAppStore.getState();
      const tab = store.tabs.find((item) => item.id === store.activeTabId);
      if (!tab || tab.type !== "query") return;
      const dialect =
        store.connections.find((item) => item.id === store.activeConnId)
          ?.dialect ?? "mysql";
      store.setSql(formatSql(store.sql, dialect));
    }, []);

  const ensureAiKey = useCallback(async () => {
    try {
      if (await aiHasKey()) return true;
      setAiOpen(true);
      setAiSettingsSignal((value) => value + 1);
      return false;
    } catch (keyError) {
      setAiOpen(true);
      setAiSettingsSignal((value) => value + 1);
      useAppStore.getState().setError(errorMessage(keyError));
      return false;
    }
  }, []);

  const startAiAction = useCallback(
    async (kind: "explain" | "optimize", target: AiTextTarget) => {
      const store = useAppStore.getState();
      if (!target.sql.trim()) {
        store.setError("Select a statement or place the cursor in one.");
        return;
      }
      if (kind === "optimize" && !store.activeConnId) {
        store.setError("Select a connection first.");
        return;
      }
      if (!(await ensureAiKey())) return;

      setAiAction(null);
      setAiBusy(kind);
      try {
        if (kind === "explain") {
          const result = await aiExplain(target.sql, UI_LANGUAGE);
          setAiAction({
            kind,
            originalSql: target.sql,
            target,
            result,
            error: null,
          });
        } else {
          const result = await aiOptimize(
            store.activeConnId!,
            store.activeDb ?? undefined,
            target.sql,
          );
          setAiAction({
            kind,
            originalSql: target.sql,
            target,
            result,
            error: null,
          });
        }
      } catch (actionError) {
        setAiAction({
          kind,
          originalSql: target.sql,
          target,
          result: null,
          error: errorMessage(actionError),
        });
      } finally {
        setAiBusy(null);
      }
    },
    [ensureAiKey],
  );

  const handleEditorAiAction = useCallback(
    (kind: "explain" | "optimize") => {
      const editor = editorApiRef.current;
      if (!editor) return;
      const target = editor.getAiTarget();
      if (!target) {
        useAppStore
          .getState()
          .setError("Select a statement or place the cursor in one.");
        return;
      }
      void startAiAction(kind, target);
    },
    [startAiAction],
  );

  const handleFixWithAi = useCallback(async () => {
    const store = useAppStore.getState();
    const view = store.tabStates[store.activeTabId];
    const sql = view?.executedSql ?? store.sql;
    const database = view?.database ?? store.activeDb ?? undefined;
    const connId = view?.connId ?? store.activeConnId;
    const message = view?.error ?? store.error;

    if (!connId || !message || !sql.trim()) return;
    if (!(await ensureAiKey())) return;

    setAiAction(null);
    setAiBusy("fix");
    try {
      const result = await aiFixError(connId, database, sql, message);
      setAiAction({
        kind: "fix",
        originalSql: sql,
        target: null,
        result,
        error: null,
      });
    } catch (actionError) {
      setAiAction({
        kind: "fix",
        originalSql: sql,
        target: null,
        result: null,
        error: errorMessage(actionError),
      });
    } finally {
      setAiBusy(null);
    }
  }, [ensureAiKey]);

  const openSqlInEditor = useCallback((sql: string) => {
    useAppStore.getState().addQueryTab(sql, "Index suggestion");
  }, []);

  const handleExplainPlan = useCallback(
    async (analyze: boolean, sqlOverride?: string) => {
      const store = useAppStore.getState();
      const target = sqlOverride
        ? { sql: sqlOverride, start: 0, end: 0 }
        : editorApiRef.current?.getAiTarget();
      if (!target || !target.sql.trim()) {
        store.setError("Select a statement or place the cursor in one.");
        return;
      }
      if (!store.activeConnId) {
        store.setError("Select a connection first.");
        return;
      }

      const tabId = store.activeTabId;
      const connId = store.activeConnId;
      const database = store.activeDb ?? undefined;
      if (analyze) {
        const connection = store.connections.find(
          (item) => item.id === connId,
        );
        const guard = await guardSqlExecution(connId, target.sql, database, {
          title: "Run EXPLAIN ANALYZE on production",
          previewSql: target.sql,
          note: `EXPLAIN ANALYZE executes this query on “${
            connection?.name ?? "production"
          }”. The result is discarded, but the query still runs.`,
          forceProductionConfirm: true,
        });
        if (!guard.allow) {
          if (guard.error) store.setError(guard.error);
          return;
        }
      }

      setPlanBusy(true);
      store.setError(null);
      try {
        const plan = await explainPlan(connId, database, target.sql, analyze);
        useAppStore
          .getState()
          .setPlan(plan, tabId, connId, database ?? null);
      } catch (planError) {
        useAppStore.getState().setError(errorMessage(planError), tabId);
      } finally {
        setPlanBusy(false);
      }
    },
    [],
  );

  const handleAskAiIndexes = useCallback(async () => {
    const store = useAppStore.getState();
    const view = store.tabStates[store.activeTabId];
    const plan = view?.plan;
    if (!plan) return;
    if (!(await ensureAiKey())) return;

    const connId = view.connId ?? store.activeConnId;
    const database = view.database ?? store.activeDb ?? undefined;
    if (!connId) {
      store.setError("Select a connection first.");
      return;
    }

    setAiAction(null);
    setAiBusy("optimize");
    try {
      const result = await aiOptimize(
        connId,
        database,
        plan.sql,
        plan.raw,
      );
      setAiAction({
        kind: "optimize",
        originalSql: plan.sql,
        target: null,
        result,
        error: null,
      });
    } catch (actionError) {
      setAiAction({
        kind: "optimize",
        originalSql: plan.sql,
        target: null,
        result: null,
        error: errorMessage(actionError),
      });
    } finally {
      setAiBusy(null);
    }
  }, [ensureAiKey]);

  const applyAiReplacement = useCallback(
    (replacement: string) => {
      if (!aiAction) return;
      const editor = editorApiRef.current;
      if (!editor) return;

      let applied = false;
      if (aiAction.target) {
        editor.applyTarget(aiAction.target, replacement);
        applied = true;
      } else {
        applied = editor.replaceStatement(aiAction.originalSql, replacement);
      }

      if (!applied) {
        useAppStore
          .getState()
          .setError(
            "Could not find the original statement in the editor; it may have changed.",
          );
        return;
      }
      setAiAction(null);
    },
    [aiAction],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || !event.shiftKey) return;

      const key = event.key.toLowerCase();
      if (key !== "e" && key !== "o" && key !== "p") return;
      event.preventDefault();
      event.stopPropagation();
      if (key === "p") {
        void handleExplainPlan(false);
      } else {
        handleEditorAiAction(key === "e" ? "explain" : "optimize");
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [handleEditorAiAction, handleExplainPlan]);

  useEffect(() => {
    setAiAction(null);
  }, [activeTabId, activeConnId]);

  const handleNewQuery = useCallback(() => {
    useAppStore.getState().addQueryTab("");
  }, []);

  const handleSaved = useCallback((meta: ConnectionMeta) => {
    const store = useAppStore.getState();
    store.setConnections([
      ...store.connections.filter((connection) => connection.id !== meta.id),
      meta,
    ]);
    store.setConnected(meta.id, true);
    store.setActiveConn(meta.id);
    setEditingConnection(null);
    setDialogOpen(false);
  }, []);

  const openNewConnection = useCallback(() => {
    setEditingConnection(null);
    setDialogOpen(true);
  }, []);

  const openEditConnection = useCallback((connection: ConnectionMeta) => {
    setEditingConnection(connection);
    setDialogOpen(true);
  }, []);

  const closeConnectionDialog = useCallback(() => {
    setDialogOpen(false);
    setEditingConnection(null);
  }, []);

  const selectConnection = useCallback(async (id: string) => {
    const store = useAppStore.getState();
    if (store.activeConnId !== id && !store.setActiveConn(id)) return;
    setMenu(null);

    if (store.connected[id]) return;

    try {
      await connectConnection(id);
      useAppStore.getState().setConnected(id, true);
    } catch (error) {
      useAppStore.getState().setError(errorMessage(error));
    }
  }, []);

  const openCompareSchemas = useCallback(
    (connection: ConnectionMeta | null, database: string | null) => {
      setCompareOpen({
        connId: connection?.id ?? useAppStore.getState().activeConnId,
        database: database ?? useAppStore.getState().activeDb,
      });
    },
    [],
  );

  const openCompareSqlInEditor = useCallback(
    async (sql: string, connId: string, database: string) => {
      const store = useAppStore.getState();
      if (store.activeConnId !== connId && !store.setActiveConn(connId)) {
        return;
      }
      store.setActiveDb(database);

      if (!store.connected[connId]) {
        try {
          await connectConnection(connId);
          useAppStore.getState().setConnected(connId, true);
        } catch (connectError) {
          useAppStore.getState().setError(errorMessage(connectError));
          return;
        }
      }

      useAppStore.getState().addQueryTab(sql, "Schema migration");
      setCompareOpen(null);
    },
    [],
  );

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  const startSideDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = {
      kind: "side",
      x: event.clientX,
      y: 0,
      value: sideW,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const startSplitDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = {
      kind: "split",
      x: 0,
      y: event.clientY,
      value: editorH,
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };

  const startAiDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = {
      kind: "ai",
      x: event.clientX,
      y: 0,
      value: aiW,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const paletteActions: CommandAction[] = [
    {
      id: "new",
      icon: "icon-plus",
      label: "New query tab",
      group: "Query",
      kb: "Ctrl T",
      run: handleNewQuery,
    },
    {
      id: "run",
      icon: "icon-play",
      label: "Run query",
      group: "Query",
      kb: "Ctrl ↵",
      run: handleTopRun,
    },
    {
      id: "format",
      icon: "icon-align-left",
      label: "Format SQL",
      group: "Query",
      kb: "⇧⌥F",
      run: handleFormat,
    },
    {
      id: "ai",
      icon: "icon-panel-right",
      label: aiOpen ? "Close AI panel" : "Open AI panel",
      group: "View",
      kb: "Ctrl I",
      run: () => setAiOpen((open) => !open),
    },
    {
      id: "theme",
      icon: theme === "dark" ? "icon-sun" : "icon-moon",
      label: `Switch to ${theme === "dark" ? "light" : "dark"} theme`,
      group: "View",
      run: toggleTheme,
    },
    {
      id: "sidebar",
      icon: "icon-panel-left",
      label: sideOpen ? "Hide sidebar" : "Show sidebar",
      group: "View",
      kb: "Ctrl B",
      run: () => setSideOpen((open) => !open),
    },
    {
      id: "find-in-db",
      icon: "icon-search",
      label: "Find in database…",
      group: "View",
      run: () => {
        const store = useAppStore.getState();
        if (store.activeConnId && store.activeDb) {
          setFindOpen({ connId: store.activeConnId, database: store.activeDb });
        } else {
          void notify(
            "DataForge",
            "Select a connection and database first.",
          );
        }
      },
    },
    {
      id: "compare-schemas",
      icon: "icon-git-compare",
      label: "Compare schemas…",
      group: "Schema",
      run: () => openCompareSchemas(null, null),
    },
    {
      id: "query-history",
      icon: "icon-history",
      label: "Query history…",
      group: "View",
      run: () => setHistoryOpen(true),
    },
    {
      id: "export-excel",
      icon: "icon-sheet",
      label: "Export result to Excel…",
      group: "View",
      run: () => {
        const store = useAppStore.getState();
        const result = store.result;
        if (!result || result.columns.length === 0) {
          void notify("DataForge", "No result to export — run a query first.");
          return;
        }
        const active = store.tabs.find((item) => item.id === store.activeTabId);
        const base =
          active?.type === "table" ? active.table : "query-result";
        void exportResultXlsx(result.columns, result.rows, `${base}.xlsx`)
          .then((saved) => {
            if (saved) void notify("DataForge", "Exported to Excel.");
          })
          .catch((error) =>
            void notify("DataForge", "Export failed: " + errorMessage(error)),
          );
      },
    },
    {
      id: "add",
      icon: "icon-plus",
      label: "Add connection…",
      group: "Connections",
      run: openNewConnection,
    },
    ...connections
      .filter((connection) => connection.id !== activeConnId)
      .map((connection) => ({
        id: `switch-${connection.id}`,
        icon: "icon-database",
        label: `Switch to ${connection.name}`,
        group: "Connections",
        run: () => void selectConnection(connection.id),
      })),
    {
      id: "close",
      icon: "icon-x",
      label: "Close tab",
      group: "View",
      kb: "Ctrl W",
      run: () => {
        if (activeTabId) useAppStore.getState().closeTab(activeTabId);
      },
    },
  ];

  return (
    <div
      className="df-app"
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--tx)",
        fontFamily: "var(--ui)",
        fontSize: 12.5,
        lineHeight: 1.35,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: 32,
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "0 8px",
          background: "var(--sf)",
          borderBottom: "1px solid var(--bd)",
        }}
      >
        <button
          type="button"
          className="df2-quiet"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ kind: "conn", x: rect.left, y: rect.bottom + 4 });
          }}
          style={{
            height: 24,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 8px",
            border: 0,
            borderRadius: 4,
            cursor: "default",
            borderLeft: activeEnvColor
              ? `2px solid ${activeEnvColor}`
              : "2px solid transparent",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: activeConnected ? "var(--ok)" : "var(--fa)",
            }}
          />
          <span style={{ fontWeight: 500 }}>
            {activeConnection?.name ?? "No connection"}
          </span>
          <EnvironmentBadge environment={activeEnvironment} />
          <i
            className="icon-chevron-down"
            style={{ fontSize: 12, color: "var(--fa)" }}
          />
        </button>
        <span style={{ color: "var(--fa)" }}>/</span>
        <button
          type="button"
          className="df2-quiet"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ kind: "db", x: rect.left, y: rect.bottom + 4 });
          }}
          style={{
            height: 24,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 8px",
            border: 0,
            borderRadius: 4,
            cursor: "default",
          }}
        >
          <span>{activeDb ?? "select db"}</span>
          <i
            className="icon-chevron-down"
            style={{ fontSize: 12, color: "var(--fa)" }}
          />
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="df2-run"
          onClick={handleTopRun}
          disabled={running}
          title="Run (⌘↵)"
          style={{
            height: 24,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 10px",
            border: 0,
            borderRadius: 4,
            color: "#fff",
            fontWeight: 500,
            cursor: running ? "not-allowed" : "default",
            opacity: running ? 0.6 : 1,
          }}
        >
          <i className="icon-play" style={{ fontSize: 12 }} />
          <span>Run</span>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              opacity: 0.7,
            }}
          >
            ⌘↵
          </span>
        </button>
        <div
          style={{
            width: 1,
            height: 16,
            background: "var(--bd)",
            margin: "0 6px",
          }}
        />
        <button
          type="button"
          className="df2-icon-btn"
          onClick={() => setPaletteOpen(true)}
          title="Command palette (⌘K)"
          style={{
            width: 26,
            height: 26,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: 0,
            borderRadius: 4,
            color: "var(--mu)",
            cursor: "default",
            padding: 0,
          }}
        >
          <i className="icon-command" style={{ fontSize: 15 }} />
        </button>
        <button
          type="button"
          className="df2-icon-btn"
          onClick={() => setAiOpen((open) => !open)}
          title="Assistant (⌘I)"
          style={{
            width: 26,
            height: 26,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: 0,
            borderRadius: 4,
            color: aiOpen ? "var(--ac)" : "var(--mu)",
            cursor: "default",
            padding: 0,
          }}
        >
          <i className="icon-panel-right" style={{ fontSize: 15 }} />
        </button>
        <button
          type="button"
          className="df2-icon-btn"
          onClick={toggleTheme}
          title="Toggle theme"
          style={{
            width: 26,
            height: 26,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: 0,
            borderRadius: 4,
            color: "var(--mu)",
            cursor: "default",
            padding: 0,
          }}
        >
          <i
            className={theme === "dark" ? "icon-moon" : "icon-sun"}
            style={{ fontSize: 15 }}
          />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <Sidebar
          onNewConnection={openNewConnection}
          onEditConnection={openEditConnection}
          onOpenTable={handleOpenTable}
          onOpenErd={handleOpenErd}
          onFindInTable={(connId, database, table) =>
            setFindOpen({ connId, database, table })
          }
          onCompareSchemas={(connection, database) =>
            openCompareSchemas(connection, database)
          }
          width={sideOpen ? sideW : 0}
        />

        {sideOpen && (
          <div
            className="df2-resize-col"
            onMouseDown={startSideDrag}
            style={{
              width: 5,
              margin: "0 -3px 0 -2px",
              flex: "none",
              cursor: "col-resize",
              position: "relative",
              zIndex: 5,
            }}
          />
        )}

        <main
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            position: "relative",
          }}
        >
          <div
            style={{
              height: 32,
              flex: "none",
              display: "flex",
              alignItems: "stretch",
              padding: "0 4px",
              borderBottom: "1px solid var(--bd)",
              background: "var(--bg)",
              overflowX: "auto",
            }}
          >
            {tabs.map((tab) => {
              const active = tab.id === activeTabId;
              const tabConnection =
                tab.type === "table" || tab.type === "erd"
                  ? connections.find(
                      (connection) => connection.id === tab.connectionId,
                    )
                  : activeConnection;
              const tabEnvironment = tabConnection?.environment;
              const tabEnvColor = isProtectedEnvironment(tabEnvironment)
                ? environmentColor(tabEnvironment)
                : undefined;
              const tabColor =
                tabEnvColor ??
                (tab.type === "table" || tab.type === "erd"
                  ? connPrefs[tab.connectionId]?.color
                  : undefined);
              return (
                <div
                  key={tab.id}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", tab.id);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const fromId = event.dataTransfer.getData("text/plain");
                    if (fromId && fromId !== tab.id) {
                      useAppStore.getState().reorderTabs(fromId, tab.id);
                    }
                  }}
                  onClick={() =>
                    useAppStore.getState().setActiveTab(tab.id)
                  }
                  onMouseEnter={() => setHoverTab(tab.id)}
                  onMouseLeave={() => setHoverTab(null)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 6px 0 7px",
                    marginBottom: -1,
                    borderLeft: tabColor
                      ? `3px solid ${tabColor}`
                      : "3px solid transparent",
                    borderBottom: `2px solid ${
                      active ? "var(--ac)" : "transparent"
                    }`,
                    color: active ? "var(--tx)" : "var(--mu)",
                    cursor: "default",
                    whiteSpace: "nowrap",
                    userSelect: "none",
                  }}
                >
                  <i
                    className={
                      tab.type === "query"
                        ? "icon-code"
                        : tab.type === "erd"
                          ? "icon-network"
                          : "icon-table"
                    }
                    style={{ fontSize: 13, color: "var(--fa)" }}
                  />
                  <span>{tab.name}</span>
                  <EnvironmentBadge environment={tabEnvironment} />
                  <span
                    onClick={(event) => {
                      event.stopPropagation();
                      useAppStore.getState().closeTab(tab.id);
                    }}
                    style={{
                      width: 16,
                      height: 16,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 3,
                      opacity: hoverTab === tab.id ? 1 : 0,
                      color: "var(--mu)",
                      cursor: "default",
                    }}
                    title="Close tab"
                  >
                    <i className="icon-x" style={{ fontSize: 12 }} />
                  </span>
                </div>
              );
            })}
            <button
              type="button"
              className="v2-icon-btn"
              onClick={handleNewQuery}
              title="New query (Ctrl+T)"
              style={{
                width: 28,
                margin: "4px 0 4px 2px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: 0,
                borderRadius: 4,
                background: "transparent",
                color: "var(--fa)",
                cursor: "default",
                padding: 0,
              }}
            >
              <i className="icon-plus" style={{ fontSize: 14 }} />
            </button>
          </div>

          {activeTab?.type === "query" && (
            <>
              <div
                style={{
                  height: 30,
                  flex: "none",
                  display: "flex",
                  alignItems: "center",
                  gap: 2,
                  padding: "0 6px",
                  borderBottom: "1px solid var(--bd)",
                  background: "var(--bg)",
                }}
              >
                <button
                  type="button"
                  className="df2-quiet"
                  onClick={() => void handleRun()}
                  disabled={running}
                  style={{
                    height: 24,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 8px",
                    border: 0,
                    borderRadius: 4,
                    cursor: running ? "not-allowed" : "default",
                    opacity: running ? 0.6 : 1,
                  }}
                >
                  <i
                    className="icon-play"
                    style={{ fontSize: 12, color: "var(--ac)" }}
                  />
                  <span>Run</span>
                </button>
                <button
                  type="button"
                  className="df2-quiet df2-hover-tx"
                  onClick={handleFormat}
                  style={{
                    height: 24,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 8px",
                    border: 0,
                    borderRadius: 4,
                    color: "var(--mu)",
                    cursor: "default",
                  }}
                >
                  <i className="icon-align-left" style={{ fontSize: 13 }} />
                  <span>Format</span>
                </button>
                <button
                  type="button"
                  className="df2-quiet df2-hover-tx"
                  onClick={() => handleEditorAiAction("explain")}
                  disabled={aiBusy !== null}
                  title="Explain with AI (Ctrl+Shift+E)"
                  style={{
                    height: 24,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 8px",
                    border: 0,
                    borderRadius: 4,
                    color: "var(--mu)",
                    cursor: aiBusy ? "not-allowed" : "default",
                    opacity: aiBusy ? 0.6 : 1,
                  }}
                >
                  <i className="icon-eye" style={{ fontSize: 13 }} />
                  <span>
                    {aiBusy === "explain" ? "Explaining…" : "Explain"}
                  </span>
                </button>
                <button
                  type="button"
                  className="df2-quiet df2-hover-tx"
                  onClick={() => handleEditorAiAction("optimize")}
                  disabled={aiBusy !== null}
                  title="Optimize with AI (Ctrl+Shift+O)"
                  style={{
                    height: 24,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 8px",
                    border: 0,
                    borderRadius: 4,
                    color: "var(--mu)",
                    cursor: aiBusy ? "not-allowed" : "default",
                    opacity: aiBusy ? 0.6 : 1,
                  }}
                >
                  <i className="icon-crosshair" style={{ fontSize: 13 }} />
                  <span>
                    {aiBusy === "optimize" ? "Optimizing…" : "Optimize"}
                  </span>
                </button>
                <button
                  type="button"
                  className="df2-quiet df2-hover-tx"
                  onClick={() => void handleExplainPlan(false)}
                  disabled={planBusy || aiBusy !== null}
                  title="Execution plan (Ctrl+Shift+P)"
                  style={{
                    height: 24,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 8px",
                    border: 0,
                    borderRadius: 4,
                    color: "var(--mu)",
                    cursor: planBusy ? "not-allowed" : "default",
                    opacity: planBusy ? 0.6 : 1,
                  }}
                >
                  <i className="icon-list-tree" style={{ fontSize: 13 }} />
                  <span>{planBusy ? "Planning…" : "Plan"}</span>
                </button>
                <div style={{ flex: 1 }} />
                <span
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    color: "var(--fa)",
                    paddingRight: 6,
                  }}
                >
                  {activeConnection?.name ?? "No connection"} ·{" "}
                  {activeDb ?? "no database"}
                </span>
              </div>

              <div
                style={{
                  height: editorH,
                  flex: "none",
                  display: "flex",
                  minHeight: 0,
                  background: "var(--bg)",
                  overflow: "hidden",
                  fontFamily: "var(--mono)",
                  fontSize: 13,
                  lineHeight: "20px",
                }}
              >
                <SqlEditor
                  ref={editorApiRef}
                  onRun={handleRun}
                  theme={theme}
                />
              </div>

              <div
                className="df2-resize-row"
                onMouseDown={startSplitDrag}
                style={{
                  height: 5,
                  margin: "-2px 0 -3px",
                  flex: "none",
                  cursor: "row-resize",
                  position: "relative",
                  zIndex: 5,
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <div
                  style={{
                    height: 1,
                    width: "100%",
                    background: "var(--bd)",
                  }}
                />
              </div>
            </>
          )}

          {activeTab?.type === "erd" ? (
            <Suspense fallback={<div style={{ flex: 1 }} />}>
              <ErDiagram
                connId={activeTab.connectionId}
                database={activeTab.database}
                theme={theme}
                onOpenTable={(table) => {
                  if (activeTab.type !== "erd") return;
                  const connection = connections.find(
                    (item) => item.id === activeTab.connectionId,
                  );
                  if (connection) {
                    void handleOpenTable(
                      connection,
                      activeTab.database,
                      table,
                    );
                  }
                }}
              />
            </Suspense>
          ) : activeTab?.type === "table" ? (
            <TableDataView
              tab={activeTab}
              theme={theme}
              onRefresh={(where, orderBy) =>
                void handleTableRefresh(activeTab, where, orderBy)
              }
            />
          ) : activeTab?.type === "query" ? (
            <>
              {error && (
                <div
                  style={{
                    height: 26,
                    flex: "none",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "0 10px",
                    background: "var(--ers)",
                    borderBottom: "1px solid var(--bd)",
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                  }}
                  role="alert"
                >
                  <i
                    className="icon-circle-alert"
                    style={{ fontSize: 13, color: "var(--er)" }}
                  />
                  <span style={{ color: "var(--er)" }}>ERROR</span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {error}
                  </span>
                  <button
                    type="button"
                    className="v2-btn"
                    onClick={() => void handleFixWithAi()}
                    disabled={aiBusy !== null}
                    title="Fix with AI"
                    style={{
                      height: 20,
                      flex: "none",
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "0 8px",
                      fontSize: 11.5,
                    }}
                  >
                    <i className="icon-sparkles" style={{ fontSize: 11 }} />
                    <span>{aiBusy === "fix" ? "Fixing…" : "Fix with AI"}</span>
                  </button>
                </div>
              )}
              {activePlan && (
                <div
                  style={{
                    height: 30,
                    flex: "none",
                    display: "flex",
                    alignItems: "stretch",
                    gap: 2,
                    padding: "0 6px",
                    borderBottom: "1px solid var(--bd)",
                    background: "var(--bg)",
                  }}
                >
                  {(
                    [
                      ["results", "Results"],
                      ["plan", "Plan"],
                    ] as const
                  ).map(([id, label]) => {
                    const active =
                      (activeView?.resultTab ?? "results") === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        className="df2-quiet df2-hover-tx"
                        onClick={() =>
                          useAppStore
                            .getState()
                            .setResultTab(id, activeTab.id)
                        }
                        style={{
                          height: 30,
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          padding: "0 9px",
                          border: 0,
                          borderBottom: `2px solid ${
                            active ? "var(--ac)" : "transparent"
                          }`,
                          borderRadius: 0,
                          background: "transparent",
                          color: active ? "var(--tx)" : "var(--mu)",
                          cursor: "default",
                          fontSize: 11.5,
                        }}
                      >
                        <i
                          className={
                            id === "plan" ? "icon-list-tree" : "icon-table"
                          }
                          style={{ fontSize: 12 }}
                        />
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {showPlan && activePlan ? (
                <Suspense fallback={<div style={{ flex: 1 }} />}>
                  <PlanView
                    plan={activePlan}
                    busy={planBusy}
                    aiBusy={aiBusy === "optimize"}
                    onAnalyzeChange={(analyze) =>
                      void handleExplainPlan(analyze, activePlan.sql)
                    }
                    onAskAi={() => void handleAskAiIndexes()}
                  />
                </Suspense>
              ) : (
                <DataGrid
                  key={activeTab.id}
                  tabId={activeTab.id}
                  viewKey={`${activeTab.id}:${activeView?.resultVersion ?? 0}`}
                  dialect={activeConnection?.dialect ?? "mysql"}
                  database={activeDb}
                  connId={activeView?.connId ?? activeConnId ?? undefined}
                  sql={activeView?.executedSql ?? undefined}
                  theme={theme}
                  onExplainResult={handleExplainResult}
                />
              )}
            </>
          ) : null}

          {aiAction && (
            <Suspense fallback={null}>
              <AiActionPanel
                state={aiAction}
                onClose={() => setAiAction(null)}
                onApply={applyAiReplacement}
                onOpenInEditor={openSqlInEditor}
              />
            </Suspense>
          )}
        </main>

        {aiOpen && (
          <>
            <div
              className="df2-resize-col"
              onMouseDown={startAiDrag}
              style={{
                width: 5,
                margin: "0 -2px 0 -3px",
                flex: "none",
                cursor: "col-resize",
                position: "relative",
                zIndex: 5,
              }}
            />
            <aside
              style={{
                width: aiW,
                flex: "none",
                display: "flex",
                flexDirection: "column",
                background: "var(--sf)",
                borderLeft: "1px solid var(--bd)",
                minHeight: 0,
              }}
            >
              <Suspense fallback={<div style={{ flex: 1 }} />}>
                <AiPanel
                  onClose={() => setAiOpen(false)}
                  settingsSignal={aiSettingsSignal}
                  chatRequest={chatRequest}
                  onChatRequestHandled={() => setChatRequest(null)}
                  onRunSql={handleRunChatSql}
                  uiLanguage={UI_LANGUAGE}
                />
              </Suspense>
            </aside>
          </>
        )}
      </div>

      <div
        style={{
          height: 22,
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 10px",
          background: "var(--sf)",
          borderTop: "1px solid var(--bd)",
          fontSize: 11.5,
          color: "var(--mu)",
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: activeConnected ? "var(--ok)" : "var(--fa)",
          }}
        />
        <span style={{ color: "var(--tx)" }}>
          {activeConnected ? "Connected" : "Disconnected"}
        </span>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontFamily: "var(--mono)",
            fontSize: 11,
          }}
        >
          <span>{activeConnection?.name ?? "No connection"}</span>
          <EnvironmentBadge environment={activeEnvironment} />
          <span>
            · {engineLabel(activeConnection?.dialect, activeConnection?.flavor)}{" "}
            · {activeDb ?? "no database"}
          </span>
        </span>
        <div style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--fa)",
          }}
        >
          UTF-8 · auto-commit
        </span>
      </div>

      {menu && (
        <>
          <div
            onMouseDown={() => setMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu(null);
            }}
            style={{ position: "fixed", inset: 0, zIndex: 50 }}
          />
          <div
            style={{
              position: "fixed",
              left: menu.x,
              top: menu.y,
              zIndex: 51,
              minWidth: 208,
              maxHeight: "min(70vh, 440px)",
              overflowY: "auto",
              padding: 4,
              background: "var(--sf)",
              border: "1px solid var(--bd2)",
              borderRadius: 6,
              boxShadow: "var(--sh)",
            }}
          >
            {menu.kind === "conn" ? (
              <>
                {connections.length === 0 && (
                  <div
                    style={{ padding: "6px 8px", color: "var(--fa)", fontSize: 11.5 }}
                  >
                    No connections yet
                  </div>
                )}
                {connections.map((connection) => (
                  <button
                    key={connection.id}
                    type="button"
                    className="df2-menu-item"
                    onClick={() => {
                      setMenu(null);
                      void selectConnection(connection.id);
                    }}
                    style={{
                      width: "100%",
                      height: 26,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "0 8px",
                      border: 0,
                      borderRadius: 4,
                      color: "var(--tx)",
                      textAlign: "left",
                      cursor: "default",
                    }}
                  >
                    <i
                      className={
                        connection.id === activeConnId ? "icon-check" : ""
                      }
                      style={{
                        width: 14,
                        flex: "none",
                        fontSize: 13,
                        color: "var(--ac)",
                      }}
                    />
                    <span style={{ flex: 1, whiteSpace: "nowrap" }}>
                      {connection.name}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 11,
                        color: "var(--fa)",
                      }}
                    >
                      {engineShort(connection.dialect, connection.flavor)}
                    </span>
                  </button>
                ))}
                <div
                  style={{
                    height: 1,
                    background: "var(--bd)",
                    margin: "4px -4px",
                  }}
                />
                <button
                  type="button"
                  className="df2-menu-item"
                  onClick={() => {
                    setMenu(null);
                    openNewConnection();
                  }}
                  style={{
                    width: "100%",
                    height: 26,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "0 8px",
                    border: 0,
                    borderRadius: 4,
                    color: "var(--tx)",
                    textAlign: "left",
                    cursor: "default",
                  }}
                >
                  <i
                    className="icon-plus"
                    style={{
                      width: 14,
                      flex: "none",
                      fontSize: 13,
                      color: "var(--mu)",
                    }}
                  />
                  <span style={{ flex: 1, whiteSpace: "nowrap" }}>
                    New connection…
                  </span>
                </button>
              </>
            ) : databases.length === 0 ? (
              <div style={{ padding: "6px 8px", color: "var(--fa)", fontSize: 11.5 }}>
                No databases
              </div>
            ) : (
              databases.map((database) => (
                <button
                  key={database}
                  type="button"
                  className="df2-menu-item"
                  onClick={() => {
                    setActiveDb(database);
                    setMenu(null);
                  }}
                  style={{
                    width: "100%",
                    height: 26,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "0 8px",
                    border: 0,
                    borderRadius: 4,
                    color: "var(--tx)",
                    textAlign: "left",
                    cursor: "default",
                  }}
                >
                  <i
                    className={database === activeDb ? "icon-check" : ""}
                    style={{
                      width: 14,
                      flex: "none",
                      fontSize: 13,
                      color: "var(--ac)",
                    }}
                  />
                  <span style={{ flex: 1, whiteSpace: "nowrap" }}>
                    {database}
                  </span>
                </button>
              ))
            )}
          </div>
        </>
      )}

      {aboutOpen && (
        <>
          <div
            onMouseDown={() => setAboutOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 90,
              background: "var(--scrim)",
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%,-50%)",
              zIndex: 91,
              width: 420,
              maxWidth: "calc(100vw - 32px)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              padding: 16,
              background: "var(--sf)",
              border: "1px solid var(--bd2)",
              borderRadius: 6,
              boxShadow: "var(--sh)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <img
                src={theme === "dark" ? lockupOnDark : lockupOnLight}
                alt="DataForge"
                style={{ height: 22, width: "auto", display: "block" }}
              />
              <div style={{ flex: 1 }} />
              <button
                type="button"
                className="v2-icon-btn"
                onClick={() => setAboutOpen(false)}
                aria-label="Close about"
                style={{
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
                }}
              >
                <i className="icon-x" style={{ fontSize: 13 }} />
              </button>
            </div>
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--fa)",
              }}
            >
              Version {appVersion}
            </span>
            <p
              style={{
                margin: 0,
                color: "var(--mu)",
                lineHeight: 1.55,
                textWrap: "pretty",
              }}
            >
              An AI-native database workspace. Connect, browse schemas, write
              SQL, and generate queries in plain language.
            </p>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                paddingTop: 4,
              }}
            >
              <button
                type="button"
                className="v2-btn"
                onClick={() => setAboutOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </>
      )}

      {whatsNew && (
        <WhatsNewDialog
          kind="whats-new"
          version={whatsNew.version}
          notes={whatsNew.notes}
          onClose={() => setWhatsNew(null)}
        />
      )}

      {updateInfo && (
        <WhatsNewDialog
          version={updateInfo.version}
          notes={updateInfo.notes}
          busy={updateBusy}
          onInstall={() => void installUpdate()}
          onClose={dismissUpdate}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
      />

      {dialogOpen && (
        <Suspense fallback={dialogFallback}>
          <ConnectionDialog
            open={dialogOpen}
            connection={editingConnection}
            onClose={closeConnectionDialog}
            onSaved={handleSaved}
          />
        </Suspense>
      )}

      <Suspense fallback={dialogFallback}>
        <ProdConfirmDialog />
      </Suspense>

      {findOpen && (
        <Suspense fallback={dialogFallback}>
          <FindDialog
            connId={findOpen.connId}
            database={findOpen.database}
            dialect={
              connections.find((c) => c.id === findOpen.connId)?.dialect ??
              "mysql"
            }
            onlyTable={findOpen.table}
            onClose={() => setFindOpen(null)}
            onOpenResult={(table, where) => {
              const store = useAppStore.getState();
              const tabId = store.addTableTab(
                findOpen.connId,
                findOpen.database,
                table,
                1000,
                where ?? "",
              );
              const tab = useAppStore
                .getState()
                .tabs.find((item) => item.id === tabId);
              if (tab?.type === "table") void loadTableData(tab);
            }}
            onRunSql={(sql) => {
              const store = useAppStore.getState();
              if (!store.setActiveConn(findOpen.connId)) return;
              if (findOpen.database) store.setActiveDb(findOpen.database);
              store.addQueryTab(sql, "AI search");
            }}
          />
        </Suspense>
      )}

      {historyOpen && (
        <Suspense fallback={dialogFallback}>
          <HistoryDialog
            onClose={() => setHistoryOpen(false)}
            onPick={(entry) => {
              const store = useAppStore.getState();
              const origin = entry.connId
                ? store.connections.find((item) => item.id === entry.connId)
                : null;

              if (entry.connId && entry.connId !== store.activeConnId) {
                const target = origin?.name ?? entry.connId;
                const label = entry.database
                  ? `${target} / ${entry.database}`
                  : target;
                if (
                  !window.confirm(
                    `This query was run on ${label}. Switch to that connection and load it?`,
                  )
                ) {
                  return;
                }
                if (!store.setActiveConn(entry.connId)) return;
                if (entry.database) store.setActiveDb(entry.database);
              } else if (entry.database && entry.database !== store.activeDb) {
                if (
                  !window.confirm(
                    `This query was run on database ${entry.database}. Switch to it and load the query?`,
                  )
                ) {
                  return;
                }
                store.setActiveDb(entry.database);
              }

              const active = store.tabs.find(
                (item) => item.id === store.activeTabId,
              );
              if (active?.type === "query") {
                store.setSql(entry.sql);
              } else {
                store.addQueryTab(entry.sql);
              }
            }}
          />
        </Suspense>
      )}

      {compareOpen && (
        <Suspense fallback={dialogFallback}>
          <SchemaCompareDialog
            defaultConnId={compareOpen.connId}
            defaultDatabase={compareOpen.database}
            theme={theme}
            onClose={() => setCompareOpen(null)}
            onOpenInEditor={(sql, connId, database) => {
              void openCompareSqlInEditor(sql, connId, database);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

