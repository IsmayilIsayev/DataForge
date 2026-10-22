import { create } from "zustand";
import type { ConnectionMeta, ConnectionState, QueryResult } from "./types";

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

function sameFavorite(a: FavoriteTable, b: FavoriteTable): boolean {
  return (
    a.connId === b.connId &&
    a.database === b.database &&
    a.table === b.table
  );
}

export interface TabViewState {
  result: QueryResult | null;
  error: string | null;
  running: boolean;
  connId: string | null;
  database: string | null;
  executedSql: string | null;
  resultVersion: number;
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
}

export type AppTab = QueryTab | TableTab;

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
  favorites: FavoriteTable[];
  toggleFavorite: (fav: FavoriteTable) => void;
  connGroups: Record<string, string>;
  setConnGroup: (id: string, group: string | undefined) => void;
  groupStars: Record<string, boolean>;
  toggleGroupStar: (group: string) => void;
  queryHistory: QueryHistoryEntry[];
  pushQueryHistory: (sql: string, connId?: string, database?: string) => void;
  clearQueryHistory: () => void;
  setActiveConn: (id: string | null) => void;
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
  closeTab: (id: string) => void;
  closeAllTabs: () => void;
  reorderTabs: (fromId: string, toId: string) => void;
  setActiveTab: (id: string) => void;
  setTableLimit: (id: string, limit: number) => void;
  setTableWhere: (id: string, where: string) => void;
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

export const useAppStore = create<AppStore>((set, get) => ({
  connections: [],
  connected: {},
  connPrefs: loadConnPrefs(),
  favorites: loadFavorites(),
  connGroups: loadConnGroups(),
  groupStars: loadGroupStars(),
  queryHistory: loadQueryHistory(),
  activeConnId: null,
  databases: [],
  activeDb: null,
  tabs: [initialTab],
  activeTabId: initialTab.id,
  nextTab: 2,
  tabStates: { [initialTab.id]: emptyView() },
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
  setActiveConn: (activeConnId) =>
    set({
      activeConnId,
      databases: [],
      activeDb: null,
      result: null,
      error: null,
      running: false,
    }),
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

    let tabs = state.tabs.filter((tab) => tab.id !== id);
    const tabStates = { ...state.tabStates };
    delete tabStates[id];
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
      set({ tabs, tabStates, nextTab });
      return;
    }

    const activeTab = tabs[Math.min(index, tabs.length - 1)] ?? tabs[0];
    const view = tabStates[activeTab.id] ?? emptyView();
    const matches = viewMatchesConnection(view, state.activeConnId);
    set({
      tabs,
      tabStates,
      nextTab,
      activeTabId: activeTab.id,
      sql: activeTab.type === "query" ? activeTab.sql : "",
      selection: null,
      result: matches ? view.result : null,
      error: matches ? view.error : null,
      running: matches ? view.running : false,
    });
  },
  closeAllTabs: () =>
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
        activeTabId: id,
        nextTab: state.nextTab + 1,
        sql: "",
        selection: null,
        result: null,
        error: null,
        running: false,
      };
    }),
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
}));
