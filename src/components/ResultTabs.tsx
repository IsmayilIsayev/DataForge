import { useRef } from "react";
import type { KeyboardEvent } from "react";
import type { RunQueryError, StatementResult } from "../types";

interface Props {
  results: StatementResult[];
  active: number;
  onChange: (index: number) => void;
}

const MESSAGES = -1;

export default function ResultTabs({ results, active, onChange }: Props) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const order = [...results.map((_, index) => index), MESSAGES];

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = order.indexOf(active);
    if (current < 0) return;
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % order.length;
    else if (event.key === "ArrowLeft")
      next = (current - 1 + order.length) % order.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = order.length - 1;
    else return;

    event.preventDefault();
    const target = order[next];
    onChange(target);
    buttons.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Query results"
      onKeyDown={move}
      style={{
        height: 30,
        flex: "none",
        display: "flex",
        alignItems: "stretch",
        gap: 2,
        padding: "0 6px",
        borderBottom: "1px solid var(--bd)",
        background: "var(--bg)",
        overflowX: "auto",
      }}
    >
      {order.map((index, position) => {
        const selected = index === active;
        const label = index === MESSAGES ? "Messages" : `Result ${index + 1}`;
        return (
          <button
            key={index}
            ref={(element) => {
              buttons.current[position] = element;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className="df2-quiet df2-hover-tx"
            onClick={() => onChange(index)}
            style={{
              height: 30,
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "0 9px",
              border: 0,
              borderBottom: `2px solid ${
                selected ? "var(--ac)" : "transparent"
              }`,
              borderRadius: 0,
              background: "transparent",
              color: selected ? "var(--tx)" : "var(--mu)",
              cursor: "default",
              fontSize: index === MESSAGES ? 11 : 11.5,
              whiteSpace: "nowrap",
            }}
          >
            <i
              className={index === MESSAGES ? "icon-list" : "icon-table"}
              style={{ fontSize: 12 }}
            />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

interface MessagesProps {
  results: StatementResult[];
  error?: RunQueryError | null;
}

interface MessageRow {
  key: string;
  number: number;
  sql: string;
  ok: boolean;
  detail: string;
  time: string;
  note?: string;
}

export function ResultMessages({ results, error }: MessagesProps) {
  const messages: MessageRow[] = results.map((entry, index) => ({
    key: `result-${index}`,
    number: index + 1,
    sql: entry.statement,
    ok: true,
    detail:
      entry.columns.length > 0 || entry.rows.length > 0
        ? `${entry.rows.length.toLocaleString("en-US")} row${
            entry.rows.length === 1 ? "" : "s"
          }${entry.truncated ? " (truncated)" : ""}`
        : `${(entry.rows_affected ?? 0).toLocaleString("en-US")} affected`,
    time: `${entry.elapsed_ms.toLocaleString("en-US")} ms`,
    note: entry.note,
  }));

  if (error) {
    messages.push({
      key: "error",
      number: error.statement + 1,
      sql: error.sql,
      ok: false,
      detail: error.message,
      time: "—",
    });
  }

  return (
    <div
      role="tabpanel"
      aria-label="Messages"
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        padding: "6px 10px 12px",
        fontFamily: "var(--mono)",
        fontSize: 11.5,
      }}
    >
      {messages.length === 0 ? (
        <div style={{ color: "var(--mu)", padding: "8px 0" }}>
          No statements.
        </div>
      ) : (
        messages.map((message) => (
          <div
            key={message.key}
            style={{
              display: "grid",
              gridTemplateColumns: "18px 24px minmax(0, 1fr) 120px 70px",
              alignItems: "center",
              gap: 8,
              minHeight: 26,
              padding: "3px 0",
              borderBottom: "1px solid var(--bd)",
              color: "var(--tx)",
            }}
          >
            <i
              className={message.ok ? "icon-check" : "icon-x"}
              title={message.ok ? "Succeeded" : "Failed"}
              aria-label={message.ok ? "Succeeded" : "Failed"}
              style={{
                fontSize: 12,
                color: message.ok ? "var(--ok)" : "var(--er)",
              }}
            />
            <span style={{ color: "var(--fa)" }}>{message.number}</span>
            <span
              title={message.sql}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: message.ok ? "var(--tx)" : "var(--er)",
              }}
            >
              {message.sql}
              {message.note && (
                <span style={{ color: "var(--wn)", marginLeft: 8 }}>
                  · {message.note}
                </span>
              )}
            </span>
            <span
              title={message.detail}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: message.ok ? "var(--mu)" : "var(--er)",
              }}
            >
              {message.detail}
            </span>
            <span style={{ color: "var(--fa)", textAlign: "right" }}>
              {message.time}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
