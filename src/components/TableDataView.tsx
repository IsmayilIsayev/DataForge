import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import DataGrid from "./DataGrid";
import type { TableTab } from "../store";
import { useAppStore } from "../store";

interface Props {
  tab: TableTab;
  onRefresh: (where: string) => void;
  theme: "dark" | "light";
}

export default function TableDataView({ tab, onRefresh, theme }: Props) {
  const error = useAppStore((state) => state.error);
  const connections = useAppStore((state) => state.connections);
  const setTableWhere = useAppStore((state) => state.setTableWhere);
  const [where, setWhere] = useState(tab.where);

  useEffect(() => {
    setWhere(tab.where);
  }, [tab.id, tab.where]);

  const dialect =
    connections.find((connection) => connection.id === tab.connectionId)
      ?.dialect ?? "mysql";

  const refresh = () => {
    setTableWhere(tab.id, where);
    onRefresh(where);
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
        viewKey={tab.id}
        dialect={dialect}
        database={tab.database}
        table={tab.table}
        emptyText="No table data loaded"
        theme={theme}
      />
    </>
  );
}
