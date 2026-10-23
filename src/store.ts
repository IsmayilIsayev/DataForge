import { create } from "zustand";
import type { ChartConfig } from "./chartData";
import type { ColumnFilter } from "./gridFilter";
import type { ClassifiedStatement } from "./sqlGuard";
import { emptySavedQueries } from "./savedQueries";
import type {
  CellRef,
  CellValue,
  ChatMessage,
  ConnectionMeta,
  ConnectionState,
  DatabaseTable,
  ExplainPlan,
  QueryResult,
  SavedQueriesFile,
} from "./types";

export interface ConnPref {
  color?: string;
  starred?: boolean;
  hidden?: boolean;
}

const CONN_PREFS_KEY = "df-conn-prefs";

function loadConnPrefs(): Record<string, ConnPref> {
  try {
    return JSON.parse(localStorage.getItem(CONN_PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}

export interface FavoriteTable {
  connId: string;
  database: string;
  table: string;
}

export interface TableIndexCache {
  databases: string[];
  tables: DatabaseTable[];
  loadedAt: number;
}

export interface TableIndexProgress {
  done: number;
  total: number;
}

export interface RevealTarget {
  connId: string;
  database: string;
  nonce: number;
}

const FAVORITES_KEY = "df-favorites";

function loadFavorites(): FavoriteTable[] {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
  } catch {
    return [];
  }
}

const CONN_GROUPS_KEY = "df-conn-groups";

function loadConnGroups(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(CONN_GROUPS_KEY) || "{}");
  } catch {
    return {};
  }
}

const GROUP_STARS_KEY = "df-group-stars";

function loadGroupStars(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(GROUP_STARS_KEY) || "{}");
  } catch {
    return {};
  }
}

export interface ProdConfirmRequest {
  connectionName: string;
  databaseName: string;
  statements: ClassifiedStatement[];
  title?: string;
  previewSql?: string;
  note?: string;
}

export type ViewerDock = "right" | "bottom";

export interface ViewerPrefs {
  dock: ViewerDock;
  rightWidth: number;
  bottomHeight: number;
}

const VIEWER_PREFS_KEY = "df-viewer-prefs";
const DEFAULT_VIEWER_PREFS: ViewerPrefs = {
  dock: "right",
  rightWidth: 360,
  bottomHeight: 220,
};

function loadViewerPrefs(): ViewerPrefs {
  try {
    const value = JSON.parse(localStorage.getItem(VIEWER_PREFS_KEY) || "{}");
    if (!value || typeof value !== "object") {
      return { ...DEFAULT_VIEWER_PREFS };
    }
    const prefs = value as Partial<ViewerPrefs>;
    return {
      dock: prefs.dock === "bottom" ? "bottom" : "right",
      rightWidth:
        typeof prefs.rightWidth === "number" && Number.isFinite(prefs.rightWidth)
          ? Math.max(280, prefs.rightWidth)
          : DEFAULT_VIEWER_PREFS.rightWidth,
      bottomHeight:
        typeof prefs.bottomHeight === "number" &&
        Number.isFinite(prefs.bottomHeight)
          ? Math.max(120, prefs.bottomHeight)
          : DEFAULT_VIEWER_PREFS.bottomHeight,
    };
  } catch {
    return { ...DEFAULT_VIEWER_PREFS };
  }
}

const AUTO_COMMIT_KEY = "df-auto-commit-edits";

function loadAutoCommitEdits(): boolean {
  try {
    return localStorage.getItem(AUTO_COMMIT_KEY) === "true";
  } catch {
    return false;
  }
}

export type PendingChange =
  | {
      id: string;
      kind: "update";
      sourceIndex: number;
      pk: CellRef[];
      column: string;
      columnIndex: number;
      value: string | null;
      previous: CellValue;
      next: CellValue;
    }
  | {
      id: string;
      kind: "delete";
      sourceIndex: number;
      pk: CellRef[];
    }
  | {
      id: string;
      kind: "insert";
      values: CellRef[];
    };

export type NewPendingChange =
  | Omit<Extract<PendingChange, { kind: "update" }>, "id">
  | Omit<Extract<PendingChange, { kind: "delete" }>, "id">
  | Omit<Extract<PendingChange, { kind: "insert" }>, "id">;

let pendingSeq = 0;

function pendingId(): string {
  pendingSeq += 1;
  return `pending-${Date.now()}-${pendingSeq}`;
}

function pendingCount(changes: Record<string, PendingChange[]>): number {
  return Object.values(changes).reduce(
    (total, list) => total + list.length,
    0,
  );
}

function confirmDiscard(count: number): boolean {
  if (count === 0) return true;
  return window.confirm(`Discard ${count} unsaved changes?`);
}

const QUERY_HISTORY_KEY = "df-query-history";
const QUERY_HISTORY_MAX = 100;
const QUERY_HISTORY_SECRET = /(IDENTIFIED\s+BY|PASSWORD|SECRET|TOKEN|API_KEY)/i;

export interface QueryHistoryEntry {
  sql: string;
  connId?: string;
  database?: string;
}

function loadQueryHistory(): QueryHistoryEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(QUERY_HISTORY_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): QueryHistoryEntry[] => {
      // Older builds stored a plain string[]; keep the SQL and leave the
      // connection/database unknown until the entry is re-recorded.
      if (typeof item === "string") return [{ sql: item }];
      if (
        item &&
        typeof item === "object" &&
        typeof (item as { sql?: unknown }).sql === "string"
      ) {
        const entry = item as {
          sql: string;
          connId?: unknown;
          database?: unknown;
        };
        return [
          {
            sql: entry.sql,
            ...(typeof entry.connId === "string"
              ? { connId: entry.connId }
              : {}),
            ...(typeof entry.database === "string"
              ? { database: entry.database }
              : {}),
          },
        ];
      }
      return [];
    });
  } catch {
    return [];
  }
}

export const CHAT_MESSAGES_MAX = 50;
const CHAT_THREADS_KEY = "df-ai-chat";

export function chatThreadKey(
  connId: string,
  database: string | null | undefined,
): string {
  return `${connId}::${database ?? ""}`;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { role?: unknown; content?: unknown };
  return (
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string"
  );
}

function loadChatThreads(): Record<string, ChatMessage[]> {
  try {
    const value = JSON.parse(localStorage.getItem(CHAT_THREADS_KEY) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(
        ([key, thread]): Array<[string, ChatMessage[]]> => {
          if (!Array.isArray(thread)) return [];
          const messages = thread
            .filter(isChatMessage)
            .filter((message) => !QUERY_HISTORY_SECRET.test(message.content))
            .slice(-CHAT_MESSAGES_MAX);
          return messages.length > 0 ? [[key, messages]] : [];
        },
      ),
    );
  } catch {
    return {};
  }
}

function persistChatThreads(threads: Record<string, ChatMessage[]>): void {
  try {
    const safe = Object.fromEntries(
      Object.entries(threads).map(([key, messages]) => [
        key,
        messages
          .filter((message) => !QUERY_HISTORY_SECRET.test(message.content))
          .slice(-CHAT_MESSAGES_MAX),
      ]),
    );
    localStorage.setItem(CHAT_THREADS_KEY, JSON.stringify(safe));
  } catch {}
}

function sameFavorite(a: FavoriteTable, b: FavoriteTable): boolean {
  return (
    a.connId === b.connId &&
    a.database === b.database &&
    a.table === b.table
  );
}

export type ResultTab = "results" | "plan";

export type ResultView = "grid" | "chart";

export interface TabViewState {
  result: QueryResult | null;
  error: string | null;
  running: boolean;
  connId: string | null;
  database: string | null;
  executedSql: string | null;
  resultVersion: number;
  plan: ExplainPlan | null;
  resultTab: ResultTab;
  resultView: ResultView;
  chartConfig: ChartConfig | null;
}

export interface QueryTab {
  id: string;
  type: "query";
  name: string;
  sql: string;
  dirty: boolean;
}

export interface TableTab {
  id: string;
  type: "table";
  name: string;
  connectionId: string;
  database: string;
  table: string;
  limit: number;
  where: string;
  orderBy: string;
}

export interface ErdTab {
  id: string;
  type: "erd";
  name: string;
  connectionId: string;
  database: string;
}

export type AppTab = QueryTab | TableTab | ErdTab;

interface AppStore {
  connections: ConnectionMeta[];
  connected: Record<string, boolean>;
  activeConnId: string | null;
  databases: string[];
  activeDb: string | null;
  tabs: AppTab[];
  activeTabId: string;
  nextTab: number;
  tabStates: Record<string, TabViewState>;
  clientFilters: Record<string, ColumnFilter[]>;
  sql: string;
  selection: string | null;
  result: QueryResult | null;
  error: string | null;
  running: boolean;
  setConnections: (connections: ConnectionMeta[]) => void;
  setConnectionStates: (states: ConnectionState[]) => void;
  setConnected: (id: string, connected: boolean) => void;
  removeConnectionState: (id: string) => void;
  connPrefs: Record<string, ConnPref>;
  setConnPref: (id: string, patch: Partial<ConnPref>) => void;
  viewerPrefs: ViewerPrefs;
  setViewerPref: (patch: Partial<ViewerPrefs>) => void;
  autoCommitEdits: boolean;
  setAutoCommitEdits: (value: boolean) => void;
  prodConfirm: ProdConfirmRequest | null;
  requestProdConfirm: (request: ProdConfirmRequest) => Promise<boolean>;
  resolveProdConfirm: (confirmed: boolean) => void;
  pendingChanges: Record<string, PendingChange[]>;
  addPendingChange: (tabId: string, change: NewPendingChange) => void;
  undoPendingChange: (tabId: string) => void;
  clearPendingChanges: (tabId: string) => void;
  favorites: FavoriteTable[];
  toggleFavorite: (fav: FavoriteTable) => void;
  tableIndex: Record<string, TableIndexCache>;
  indexProgress: Record<string, TableIndexProgress>;
  setTableIndex: (connId: string, entry: TableIndexCache) => void;
  setIndexProgress: (
    connId: string,
    progress: TableIndexProgress | null,
  ) => void;
  reveal: RevealTarget | null;
  revealDatabase: (connId: string, database: string) => void;
  clearReveal: () => void;
  connGroups: Record<string, string>;
  setConnGroup: (id: string, group: string | undefined) => void;
  groupStars: Record<string, boolean>;
  toggleGroupStar: (group: string) => void;
  queryHistory: QueryHistoryEntry[];
  pushQueryHistory: (sql: string, connId?: string, database?: string) => void;
  clearQueryHistory: () => void;
  savedQueries: SavedQueriesFile;
  setSavedQueries: (document: SavedQueriesFile) => void;
  chatThreads: Record<string, ChatMessage[]>;
  appendChatMessage: (
    connId: string,
    database: string | null | undefined,
    message: ChatMessage,
  ) => void;
  clearChatThread: (
    connId: string,
    database: string | null | undefined,
  ) => void;
  explainResultConsent: boolean;
  grantExplainResultConsent: () => void;
  setActiveConn: (id: string | null) => boolean;
  setDatabases: (databases: string[]) => void;
  setActiveDb: (database: string | null) => void;
  addQueryTab: (sql?: string, name?: string) => string;
  addTableTab: (
    connectionId: string,
    database: string,
    table: string,
    limit?: number,
    where?: string,
  ) => string;
  addErdTab: (connectionId: string, database: string) => string;
  closeTab: (id: string) => void;
  closeAllTabs: () => void;
  reorderTabs: (fromId: string, toId: string) => void;
  setActiveTab: (id: string) => void;
  setTableLimit: (id: string, limit: number) => void;
  setTableWhere: (id: string, where: string) => void;
  setTableOrderBy: (id: string, orderBy: string) => void;
  setClientFilters: (id: string, filters: ColumnFilter[]) => void;
  setSql: (sql: string) => void;
  setSelection: (selection: string | null) => void;
  setResult: (
    result: QueryResult | null,
    tabId?: string,
    connId?: string,
    database?: string | null,
  ) => void;
  setError: (error: string | null, tabId?: string) => void;
  setRunning: (running: boolean, tabId?: string) => void;
  setExecutedSql: (sql: string | null, tabId?: string) => void;
  setPlan: (
    plan: ExplainPlan | null,
    tabId?: string,
    connId?: string,
    database?: string | null,
  ) => void;
  setResultTab: (tab: ResultTab, tabId?: string) => void;
  setResultView: (view: ResultView, tabId?: string) => void;
  setChartConfig: (config: ChartConfig | null, tabId?: string) => void;
}

function emptyView(): TabViewState {
  return {
    result: null,
    error: null,
    running: false,
    connId: null,
    database: null,
    executedSql: null,
    resultVersion: 0,
    plan: null,
    resultTab: "results",
    resultView: "grid",
    chartConfig: null,
  };
}

function viewMatchesConnection(
  view: TabViewState,
  activeConnId: string | null,
): boolean {
  return view.connId === null || view.connId === activeConnId;
}

const initialTab: QueryTab = {
  id: "tab-1",
  type: "query",
  name: "Query 1",
  sql: "SELECT 1;",
  dirty: false,
};

let prodConfirmResolve: ((confirmed: boolean) => void) | null = null;

export const useAppStore = create<AppStore>((set, get) => ({
  connections: [],
  connected: {},
  connPrefs: loadConnPrefs(),
  viewerPrefs: loadViewerPrefs(),
  autoCommitEdits: loadAutoCommitEdits(),
  prodConfirm: null,
  pendingChanges: {},
  favorites: loadFavorites(),
  tableIndex: {},
  indexProgress: {},
  reveal: null,
  connGroups: loadConnGroups(),
  groupStars: loadGroupStars(),
  queryHistory: loadQueryHistory(),
  savedQueries: emptySavedQueries(),
  chatThreads: loadChatThreads(),
  explainResultConsent: false,
  activeConnId: null,
  databases: [],
  activeDb: null,
  tabs: [initialTab],
  activeTabId: initialTab.id,
  nextTab: 2,
  tabStates: { [initialTab.id]: emptyView() },
  clientFilters: {},
  sql: initialTab.sql,
  selection: null,
  result: null,
  error: null,
  running: false,
  setConnections: (connections) => set({ connections }),
  setConnectionStates: (states) =>
    set({
      connected: Object.fromEntries(
        states.map((state) => [state.id, state.connected]),
      ),
    }),
  setConnected: (id, connected) =>
    set((state) => ({
      connected: { ...state.connected, [id]: connected },
    })),
  removeConnectionState: (id) =>
    set((state) => {
      const next = { ...state.connected };
      delete next[id];
      return { connected: next };
    }),
  setConnPref: (id, patch) =>
    set((state) => {
      const next = {
        ...state.connPrefs,
        [id]: { ...state.connPrefs[id], ...patch },
      };
      try {
        localStorage.setItem(CONN_PREFS_KEY, JSON.stringify(next));
      } catch {
        // storage may be unavailable; prefs stay in memory for this session
      }
      return { connPrefs: next };
    }),
  setViewerPref: (patch) =>
    set((state) => {
      const next = { ...state.viewerPrefs, ...patch };
      try {
        localStorage.setItem(VIEWER_PREFS_KEY, JSON.stringify(next));
      } catch {
        // storage may be unavailable; prefs stay in memory for this session
      }
      return { viewerPrefs: next };
    }),
  setAutoCommitEdits: (value) => {
    try {
      localStorage.setItem(AUTO_COMMIT_KEY, String(value));
    } catch {
      // storage may be unavailable; the pref stays in memory for this session
    }
    set({ autoCommitEdits: value });
  },
  requestProdConfirm: (request) => {
    prodConfirmResolve?.(false);
    return new Promise<boolean>((resolve) => {
      prodConfirmResolve = resolve;
      set({ prodConfirm: request });
    });
  },
  resolveProdConfirm: (confirmed) => {
    const resolve = prodConfirmResolve;
    prodConfirmResolve = null;
    set({ prodConfirm: null });
    resolve?.(confirmed);
  },
  addPendingChange: (tabId, change) =>
    set((state) => {
      const existing = state.pendingChanges[tabId] ?? [];
      const withId = { ...change, id: pendingId() } as PendingChange;

      if (change.kind === "delete") {
        if (
          existing.some(
            (item) =>
              item.kind === "delete" &&
              item.sourceIndex === change.sourceIndex,
          )
        ) {
          return {};
        }
      }

      return {
        pendingChanges: {
          ...state.pendingChanges,
          [tabId]: [...existing, withId],
        },
      };
    }),
  undoPendingChange: (tabId) =>
    set((state) => {
      const existing = state.pendingChanges[tabId] ?? [];
      if (existing.length === 0) return {};
      return {
        pendingChanges: {
          ...state.pendingChanges,
          [tabId]: existing.slice(0, -1),
        },
      };
    }),
  clearPendingChanges: (tabId) =>
    set((state) => {
      if (!state.pendingChanges[tabId]?.length) return {};
      const pendingChanges = { ...state.pendingChanges };
      delete pendingChanges[tabId];
      return { pendingChanges };
    }),
  toggleFavorite: (fav) =>
    set((state) => {
      const exists = state.favorites.some((item) => sameFavorite(item, fav));
      const next = exists
        ? state.favorites.filter((item) => !sameFavorite(item, fav))
        : [...state.favorites, fav];
      try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      } catch {
        // storage may be unavailable
      }
      return { favorites: next };
    }),
  setTableIndex: (connId, entry) =>
    set((state) => ({
      tableIndex: { ...state.tableIndex, [connId]: entry },
    })),
  setIndexProgress: (connId, progress) =>
    set((state) => {
      const next = { ...state.indexProgress };
      if (progress) {
        next[connId] = progress;
      } else {
        delete next[connId];
      }
      return { indexProgress: next };
    }),
  revealDatabase: (connId, database) =>
    set({ reveal: { connId, database, nonce: Date.now() } }),
  clearReveal: () => set({ reveal: null }),
  setConnGroup: (id, group) =>
    set((state) => {
      const next = { ...state.connGroups };
      if (group && group.trim()) {
        next[id] = group.trim();
      } else {
        delete next[id];
      }
      try {
        localStorage.setItem(CONN_GROUPS_KEY, JSON.stringify(next));
      } catch {
        // storage may be unavailable
      }
      return { connGroups: next };
    }),
  toggleGroupStar: (group) =>
    set((state) => {
      const next = { ...state.groupStars };
      if (next[group]) {
        delete next[group];
      } else {
        next[group] = true;
      }
      try {
        localStorage.setItem(GROUP_STARS_KEY, JSON.stringify(next));
      } catch {
        // storage may be unavailable
      }
      return { groupStars: next };
    }),
  pushQueryHistory: (sql, connId, database) =>
    set((state) => {
      const trimmed = sql.trim();
      if (!trimmed || QUERY_HISTORY_SECRET.test(trimmed)) return {};
      const entry: QueryHistoryEntry = {
        sql: trimmed,
        ...(connId ? { connId } : {}),
        ...(database ? { database } : {}),
      };
      // Newest first, no earlier duplicate of the same SQL, capped.
      const next = [
        entry,
        ...state.queryHistory.filter((item) => item.sql !== trimmed),
      ].slice(0, QUERY_HISTORY_MAX);
      try {
        localStorage.setItem(QUERY_HISTORY_KEY, JSON.stringify(next));
      } catch {
        // storage may be unavailable
      }
      return { queryHistory: next };
    }),
  clearQueryHistory: () => {
    try {
      localStorage.removeItem(QUERY_HISTORY_KEY);
    } catch {
      // storage may be unavailable
    }
    set({ queryHistory: [] });
  },
  setSavedQueries: (savedQueries) => set({ savedQueries }),
  appendChatMessage: (connId, database, message) =>
    set((state) => {
      const key = chatThreadKey(connId, database);
      const nextThread = [
        ...(state.chatThreads[key] ?? []),
        message,
      ].slice(-CHAT_MESSAGES_MAX);
      const chatThreads = { ...state.chatThreads, [key]: nextThread };
      persistChatThreads(chatThreads);
      return { chatThreads };
    }),
  clearChatThread: (connId, database) =>
    set((state) => {
      const key = chatThreadKey(connId, database);
      if (!state.chatThreads[key]) return {};
      const chatThreads = { ...state.chatThreads };
      delete chatThreads[key];
      persistChatThreads(chatThreads);
      return { chatThreads };
    }),
  grantExplainResultConsent: () => set({ explainResultConsent: true }),
  setActiveConn: (activeConnId) => {
    const state = get();
    const switching = activeConnId !== state.activeConnId;
    const count = pendingCount(state.pendingChanges);
    if (switching && !confirmDiscard(count)) return false;

    set({
      activeConnId,
      databases: [],
      activeDb: null,
      result: null,
      error: null,
      running: false,
      ...(switching && count > 0 ? { pendingChanges: {} } : {}),
    });
    return true;
  },
  setDatabases: (databases) => set({ databases }),
  setActiveDb: (activeDb) => set({ activeDb }),
  addQueryTab: (sql = "", name) => {
    const state = get();
    const id = `tab-${state.nextTab}`;
    const tab: QueryTab = {
      id,
      type: "query",
      name: name ?? `Query ${state.nextTab}`,
      sql,
      dirty: false,
    };

    set({
      tabs: [...state.tabs, tab],
      tabStates: { ...state.tabStates, [id]: emptyView() },
      activeTabId: id,
      nextTab: state.nextTab + 1,
      sql,
      selection: null,
      result: null,
      error: null,
      running: false,
    });

    return id;
  },
  addTableTab: (connectionId, database, table, limit = 1000, where = "") => {
    const state = get();
    const id = `tab-${state.nextTab}`;
    const tab: TableTab = {
      id,
      type: "table",
      name: table,
      connectionId,
      database,
      table,
      limit,
      where,
      orderBy: "",
    };

    set({
      tabs: [...state.tabs, tab],
      tabStates: { ...state.tabStates, [id]: emptyView() },
      activeTabId: id,
      nextTab: state.nextTab + 1,
      sql: "",
      selection: null,
      result: null,
      error: null,
      running: false,
    });

    return id;
  },
  addErdTab: (connectionId, database) => {
    const state = get();
    const existing = state.tabs.find(
      (tab) =>
        tab.type === "erd" &&
        tab.connectionId === connectionId &&
        tab.database === database,
    );
    if (existing) {
      set({ activeTabId: existing.id, sql: "", selection: null });
      return existing.id;
    }

    const id = `tab-${state.nextTab}`;
    const tab: ErdTab = {
      id,
      type: "erd",
      name: `${database} ERD`,
      connectionId,
      database,
    };

    set({
      tabs: [...state.tabs, tab],
      tabStates: { ...state.tabStates, [id]: emptyView() },
      activeTabId: id,
      nextTab: state.nextTab + 1,
      sql: "",
      selection: null,
      result: null,
      error: null,
      running: false,
    });

    return id;
  },
  closeTab: (id) => {
    const state = get();
    const index = state.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    if (!confirmDiscard(state.pendingChanges[id]?.length ?? 0)) return;

    let tabs = state.tabs.filter((tab) => tab.id !== id);
    const tabStates = { ...state.tabStates };
    delete tabStates[id];
    const clientFilters = { ...state.clientFilters };
    delete clientFilters[id];
    const pendingChanges = { ...state.pendingChanges };
    delete pendingChanges[id];
    let nextTab = state.nextTab;

    if (tabs.length === 0) {
      const newId = `tab-${nextTab}`;
      const newTab: QueryTab = {
        id: newId,
        type: "query",
        name: `Query ${nextTab}`,
        sql: "",
        dirty: false,
      };
      tabs = [newTab];
      tabStates[newId] = emptyView();
      nextTab += 1;
    }

    if (state.activeTabId !== id) {
      set({ tabs, tabStates, clientFilters, pendingChanges, nextTab });
      return;
    }

    const activeTab = tabs[Math.min(index, tabs.length - 1)] ?? tabs[0];
    const view = tabStates[activeTab.id] ?? emptyView();
    const matches = viewMatchesConnection(view, state.activeConnId);
    set({
      tabs,
      tabStates,
      clientFilters,
      pendingChanges,
      nextTab,
      activeTabId: activeTab.id,
      sql: activeTab.type === "query" ? activeTab.sql : "",
      selection: null,
      result: matches ? view.result : null,
      error: matches ? view.error : null,
      running: matches ? view.running : false,
    });
  },
  closeAllTabs: () => {
    const current = get();
    if (!confirmDiscard(pendingCount(current.pendingChanges))) return;
    set((state) => {
      const id = `tab-${state.nextTab}`;
      const tab: QueryTab = {
        id,
        type: "query",
        name: `Query ${state.nextTab}`,
        sql: "",
        dirty: false,
      };
      return {
        tabs: [tab],
        tabStates: { [id]: emptyView() },
        clientFilters: {},
        pendingChanges: {},
        activeTabId: id,
        nextTab: state.nextTab + 1,
        sql: "",
        selection: null,
        result: null,
        error: null,
        running: false,
      };
    });
  },
  reorderTabs: (fromId, toId) =>
    set((state) => {
      const tabs = [...state.tabs];
      const from = tabs.findIndex((tab) => tab.id === fromId);
      const to = tabs.findIndex((tab) => tab.id === toId);
      if (from === -1 || to === -1 || from === to) return {};
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      return { tabs };
    }),
  setActiveTab: (id) => {
    const state = get();
    const tab = state.tabs.find((item) => item.id === id);
    if (!tab || state.activeTabId === id) return;

    const view = state.tabStates[id] ?? emptyView();
    const matches = viewMatchesConnection(view, state.activeConnId);
    set({
      activeTabId: id,
      sql: tab.type === "query" ? tab.sql : "",
      selection: null,
      result: matches ? view.result : null,
      error: matches ? view.error : null,
      running: matches ? view.running : false,
    });
  },
  setTableLimit: (id, limit) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && tab.type === "table"
          ? { ...tab, limit }
          : tab,
      ),
    })),
  setTableWhere: (id, where) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && tab.type === "table"
          ? { ...tab, where }
          : tab,
      ),
    })),
  setTableOrderBy: (id, orderBy) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && tab.type === "table"
          ? { ...tab, orderBy }
          : tab,
      ),
    })),
  setClientFilters: (id, filters) =>
    set((state) => ({
      clientFilters: { ...state.clientFilters, [id]: filters },
    })),
  setSql: (sql) => {
    const state = get();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);

    if (active?.type === "query") {
      set({
        sql,
        selection: null,
        tabs: state.tabs.map((tab) =>
          tab.id === active.id && tab.type === "query"
            ? { ...tab, sql, dirty: true }
            : tab,
        ),
      });
      return;
    }

    const id = `tab-${state.nextTab}`;
    const tab: QueryTab = {
      id,
      type: "query",
      name: `Query ${state.nextTab}`,
      sql,
      dirty: true,
    };

    set({
      tabs: [...state.tabs, tab],
      tabStates: { ...state.tabStates, [id]: emptyView() },
      activeTabId: id,
      nextTab: state.nextTab + 1,
      sql,
      selection: null,
      result: null,
      error: null,
      running: false,
    });
  },
  setSelection: (selection) => set({ selection }),
  setResult: (result, tabId, connId, database) =>
    set((state) => {
      const target = tabId ?? state.activeTabId;
      const view = state.tabStates[target] ?? emptyView();
      // Only executions (which pass connId) start a new result "version".
      // In-place row edits/deletes call setResult without it, so the grid can
      // keep its sort, column order and selection.
      const isExecution = connId !== undefined;
      const nextView: TabViewState = {
        ...view,
        result,
        ...(isExecution
          ? {
              connId,
              database: database ?? null,
              resultVersion: view.resultVersion + 1,
            }
          : {}),
      };
      return {
        tabStates: {
          ...state.tabStates,
          [target]: nextView,
        },
        ...(target === state.activeTabId ? { result } : {}),
      };
    }),
  setError: (error, tabId) =>
    set((state) => {
      const target = tabId ?? state.activeTabId;
      const view = state.tabStates[target] ?? emptyView();
      return {
        tabStates: {
          ...state.tabStates,
          [target]: { ...view, error },
        },
        ...(target === state.activeTabId ? { error } : {}),
      };
    }),
  setRunning: (running, tabId) =>
    set((state) => {
      const target = tabId ?? state.activeTabId;
      const view = state.tabStates[target] ?? emptyView();
      return {
        tabStates: {
          ...state.tabStates,
          [target]: { ...view, running },
        },
        ...(target === state.activeTabId ? { running } : {}),
      };
    }),
  setExecutedSql: (sql, tabId) =>
    set((state) => {
      const target = tabId ?? state.activeTabId;
      const view = state.tabStates[target] ?? emptyView();
      return {
        tabStates: {
          ...state.tabStates,
          [target]: { ...view, executedSql: sql },
        },
      };
    }),
  setPlan: (plan, tabId, connId, database) =>
    set((state) => {
      const target = tabId ?? state.activeTabId;
      const view = state.tabStates[target] ?? emptyView();
      return {
        tabStates: {
          ...state.tabStates,
          [target]: {
            ...view,
            plan,
            ...(plan
              ? {
                  resultTab: "plan" as const,
                  connId: connId ?? view.connId,
                  database:
                    database === undefined ? view.database : database,
                }
              : {}),
          },
        },
      };
    }),
  setResultTab: (resultTab, tabId) =>
    set((state) => {
      const target = tabId ?? state.activeTabId;
      const view = state.tabStates[target] ?? emptyView();
      return {
        tabStates: {
          ...state.tabStates,
          [target]: { ...view, resultTab },
        },
      };
    }),
  setResultView: (resultView, tabId) =>
    set((state) => {
      const target = tabId ?? state.activeTabId;
      const view = state.tabStates[target] ?? emptyView();
      return {
        tabStates: {
          ...state.tabStates,
          [target]: { ...view, resultView },
        },
      };
    }),
  setChartConfig: (chartConfig, tabId) =>
    set((state) => {
      const target = tabId ?? state.activeTabId;
      const view = state.tabStates[target] ?? emptyView();
      return {
        tabStates: {
          ...state.tabStates,
          [target]: { ...view, chartConfig },
        },
      };
    }),
}));
