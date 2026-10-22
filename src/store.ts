import { create } from "zustand";
import type { ConnectionMeta, ConnectionState, QueryResult } from "./types";

export interface TabViewState {
  result: QueryResult | null;
  error: string | null;
  running: boolean;
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
  setActiveConn: (id: string | null) => void;
  setDatabases: (databases: string[]) => void;
  setActiveDb: (database: string | null) => void;
  addQueryTab: (sql?: string, name?: string) => string;
  addTableTab: (
    connectionId: string,
    database: string,
    table: string,
    limit?: number,
  ) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setTableLimit: (id: string, limit: number) => void;
  setTableWhere: (id: string, where: string) => void;
  setSql: (sql: string) => void;
  setSelection: (selection: string | null) => void;
  setResult: (result: QueryResult | null, tabId?: string) => void;
  setError: (error: string | null, tabId?: string) => void;
  setRunning: (running: boolean, tabId?: string) => void;
}

function emptyView(): TabViewState {
  return { result: null, error: null, running: false };
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
  addTableTab: (connectionId, database, table, limit = 1000) => {
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
      where: "",
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
    set({
      tabs,
      tabStates,
      nextTab,
      activeTabId: activeTab.id,
      sql: activeTab.type === "query" ? activeTab.sql : "",
      selection: null,
      result: view.result,
      error: view.error,
      running: view.running,
    });
  },
  setActiveTab: (id) => {
    const state = get();
    const tab = state.tabs.find((item) => item.id === id);
    if (!tab || state.activeTabId === id) return;

    const view = state.tabStates[id] ?? emptyView();
    set({
      activeTabId: id,
      sql: tab.type === "query" ? tab.sql : "",
      selection: null,
      result: view.result,
      error: view.error,
      running: view.running,
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
  setResult: (result, tabId) =>
    set((state) => {
      const target = tabId ?? state.activeTabId;
      const view = state.tabStates[target] ?? emptyView();
      return {
        tabStates: {
          ...state.tabStates,
          [target]: { ...view, result },
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
}));
