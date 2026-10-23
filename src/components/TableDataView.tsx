import { lazy, Suspense, useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import DataGrid from "./DataGrid";
import { listColumns } from "../ipc";
import type { ColumnInfo } from "../types";
import type { TableTab } from "../store";
import { useAppStore } from "../store";

const InsertRowDialog = lazy(() => import("./InsertRowDialog"));

const dialogFallback = (
  <div style={{ position: "fixed", inset: 0 }} aria-hidden="true" />
);

interface Props {
  tab: TableTab;
  onRefresh: (where: string, orderBy?: string) => void;
  theme: "dark" | "light";
}

export default function TableDataView({ tab, onRefresh, theme }: Props) {
  const error = useAppStore((state) => state.error);
  const connections = useAppStore((state) => state.connections);
  const setTableWhere = useAppStore((state) => state.setTableWhere);
  const autoCommitEdits = useAppStore((state) => state.autoCommitEdits);
  const setAutoCommitEdits = useAppStore(
    (state) => state.setAutoCommitEdits,
  );
  const addPendingChange = useAppStore((state) => state.addPendingChange);
  const clearPendingChanges = useAppStore(
    (state) => state.clearPendingChanges,
  );
  const [where, setWhere] = useState(tab.where);
  const [orderBy, setOrderBy] = useState(tab.orderBy);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [insertOpen, setInsertOpen] = useState(false);
  const resultVersion = useAppStore(
    (state) => state.tabStates[tab.id]?.resultVersion ?? 0,
  );

  const pkColumns = columns.filter((c) => c.key === "PRI").map((c) => c.name);

  useEffect(() => {
    setWhere(tab.where);
    setOrderBy(tab.orderBy);
  }, [tab.id, tab.where, tab.orderBy]);

  useEffect(() => {
    let cancelled = false;
    listColumns(tab.connectionId, tab.database, tab.table)
      .then((cols) => {
        if (!cancelled) setColumns(cols);
      })
      .catch(() => {
        if (!cancelled) setColumns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tab.connectionId, tab.database, tab.table]);

  const connection = connections.find(
    (item) => item.id === tab.connectionId,
  );
  const dialect = connection?.dialect ?? "mysql";
  const isProd = connection?.environment === "prod";
  const isClickHouse = dialect === "clickhouse";
  const readOnlyReason = isClickHouse
    ? "ClickHouse has no transactional UPDATE/DELETE, so table data is read-only here. Use the SQL editor to run mutations."
    : null;
  const autoCommitActive = autoCommitEdits && !isProd;

  const refresh = () => {
    setTableWhere(tab.id, where);
    onRefresh(where, orderBy);
  };

  const applyServerQuery = (nextWhere: string, nextOrderBy: string) => {
    const pending =
      useAppStore.getState().pendingChanges[tab.id]?.length ?? 0;
    if (
      pending > 0 &&
      !window.confirm(`Discard ${pending} unsaved changes?`)
    ) {
      return;
    }
    if (pending > 0) clearPendingChanges(tab.id);
    setWhere(nextWhere);
    setOrderBy(nextOrderBy);
    setTableWhere(tab.id, nextWhere);
    onRefresh(nextWhere, nextOrderBy);
  };

  const onWhereKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      refresh();
    }
  };

  return (
    <>
      <div
        style={{
          height: 30,
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 6px 0 10px",
          borderBottom: "1px solid var(--bd)",
        }}
      >
        <i
          className="icon-table"
          style={{ fontSize: 13, color: "var(--fa)" }}
        />
        <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
          {tab.database}.{tab.table}
        </span>
        <span
          title={readOnlyReason ?? undefined}
          style={{ fontSize: 11, color: "var(--fa)" }}
        >
          {isClickHouse
            ? "· read-only (no transactional UPDATE/DELETE)"
            : pkColumns.length > 0
              ? "· double-click to edit"
              : "· read-only (no primary key)"}
        </span>
        <div
          style={{ width: 1, height: 14, background: "var(--bd)" }}
        />
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--fa)",
          }}
        >
          WHERE
        </span>
        <input
          value={where}
          onChange={(event) => {
            setWhere(event.target.value);
            setTableWhere(tab.id, event.target.value);
          }}
          onKeyDown={onWhereKey}
          placeholder="status = 'paid'"
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: 0,
            height: 22,
            border: 0,
            background: "transparent",
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "var(--tx)",
          }}
        />
        <label
          title={
            readOnlyReason ??
            (isProd
              ? "Auto-commit is disabled for production connections. Save batches changes through the production confirmation."
              : "ON writes every edit immediately; OFF batches changes until Save")
          }
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11,
            color: "var(--mu)",
            whiteSpace: "nowrap",
            userSelect: "none",
            opacity: isProd ? 0.55 : 1,
          }}
        >
          <input
            type="checkbox"
            checked={autoCommitActive && !isClickHouse}
            disabled={isProd || isClickHouse}
            onChange={(event) => setAutoCommitEdits(event.target.checked)}
            style={{ margin: 0, accentColor: "var(--ac)" }}
          />
          <span>Auto-commit edits</span>
        </label>
        <button
          type="button"
          className="v2-icon-btn"
          onClick={() => setInsertOpen(true)}
          disabled={columns.length === 0 || isClickHouse}
          title={readOnlyReason ?? "Add row"}
          style={{
            height: 24,
            display: "flex",
            alignItems: "center",
            gap: 4,
            border: 0,
            borderRadius: 4,
            background: "transparent",
            color:
              columns.length === 0 || isClickHouse ? "var(--fa)" : "var(--mu)",
            cursor: "default",
            padding: "0 6px",
            fontSize: 12,
          }}
        >
          <i className="icon-plus" style={{ fontSize: 13 }} />
          <span>Add row</span>
        </button>
        <button
          type="button"
          className="v2-icon-btn"
          onClick={refresh}
          title="Refresh"
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
          <i className="icon-refresh-cw" style={{ fontSize: 13 }} />
        </button>
      </div>

      {insertOpen && (
        <Suspense fallback={dialogFallback}>
          <InsertRowDialog
            connId={tab.connectionId}
            database={tab.database}
            table={tab.table}
            dialect={dialect}
            columns={columns}
            batch={!autoCommitActive}
            onClose={() => setInsertOpen(false)}
            onInserted={refresh}
            onQueued={(values) =>
              addPendingChange(tab.id, { kind: "insert", values })
            }
          />
        </Suspense>
      )}

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
        </div>
      )}

      <DataGrid
        key={tab.id}
        tabId={tab.id}
        viewKey={`${tab.id}:${resultVersion}`}
        dialect={dialect}
        database={tab.database}
        table={tab.table}
        connId={tab.connectionId}
        editable={!isClickHouse && pkColumns.length > 0}
        pkColumns={pkColumns}
        emptyText="No table data loaded"
        theme={theme}
        serverSide
        where={where}
        onServerQuery={applyServerQuery}
        onReload={refresh}
      />
    </>
  );
}
