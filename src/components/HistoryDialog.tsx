import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import type { QueryHistoryEntry } from "../store";

interface Props {
  onClose: () => void;
  onPick: (entry: QueryHistoryEntry) => void;
}

export default function HistoryDialog({ onClose, onPick }: Props) {
  const history = useAppStore((state) => state.queryHistory);
  const clearQueryHistory = useAppStore((state) => state.clearQueryHistory);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? history.filter((item) => item.sql.toLowerCase().includes(needle))
    : history;

  const pick = (entry: QueryHistoryEntry) => {
    onPick(entry);
    onClose();
  };

  return (
    <>
      <div
        onMouseDown={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 70, background: "var(--ov)" }}
      />
      <div
        style={{
          position: "fixed",
          left: "50%",
          top: "14%",
          transform: "translateX(-50%)",
          zIndex: 71,
          width: 640,
          maxWidth: "92vw",
          maxHeight: "70vh",
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
            padding: "10px 12px",
            borderBottom: "1px solid var(--bd)",
          }}
        >
          <i className="icon-history" style={{ fontSize: 14, color: "var(--fa)" }} />
          <input
            autoFocus
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter query history…"
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 0,
              height: 28,
              border: "1px solid var(--bd2)",
              borderRadius: 4,
              background: "var(--bg)",
              color: "var(--tx)",
              padding: "0 8px",
              fontSize: 12.5,
            }}
          />
          <button
            type="button"
            className="v2-btn"
            onClick={clearQueryHistory}
            disabled={history.length === 0}
            title="Clear all history"
          >
            Clear
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {shown.length === 0 ? (
            <div
              style={{
                padding: 24,
                textAlign: "center",
                color: "var(--mu)",
                fontSize: 12.5,
              }}
            >
              {history.length === 0
                ? "No queries yet — run a query and it will appear here."
                : `No history matches “${filter.trim()}”.`}
            </div>
          ) : (
            shown.map((item, index) => (
              <div
                key={index}
                className="df2-row"
                onDoubleClick={() => pick(item)}
                title={
                  item.params && item.params.length > 0
                    ? `Double-click to load into the editor\n${item.params
                        .map((param) => `${param.name} = ${param.value ?? "NULL"}`)
                        .join(", ")}`
                    : "Double-click to load into the editor"
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  minHeight: 30,
                  padding: "5px 12px",
                  cursor: "default",
                  borderBottom: "1px solid var(--bd)",
                }}
              >
                <i
                  className="icon-chevron-right"
                  style={{ fontSize: 12, flex: "none", color: "var(--fa)" }}
                />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    color: "var(--tx)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {item.sql.replace(/\s+/g, " ")}
                </span>
                <button
                  type="button"
                  className="v2-btn"
                  onClick={() => pick(item)}
                  style={{ flex: "none" }}
                >
                  Load
                </button>
              </div>
            ))
          )}
        </div>

        <div
          style={{
            flex: "none",
            height: 26,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 12px",
            borderTop: "1px solid var(--bd)",
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--fa)",
          }}
        >
          <span>{history.length} in history</span>
          <span>double-click = load</span>
        </div>
      </div>
    </>
  );
}
