import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

export interface CommandAction {
  id: string;
  icon: string;
  label: string;
  group: string;
  kb?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  actions: CommandAction[];
}

function score(text: string, query: string) {
  if (!query) return 1;
  const value = text.toLowerCase();
  if (value.includes(query)) return 2;

  let index = 0;
  for (const character of value) {
    if (character === query[index]) index += 1;
    if (index === query.length) return 1;
  }
  return 0;
}

export default function CommandPalette({ open, onClose, actions }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return actions
      .map((action) => ({
        action,
        score: score(`${action.label} ${action.group}`, search),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map((item) => item.action);
  }, [actions, query]);

  const current = Math.min(index, Math.max(0, filtered.length - 1));

  const run = (action: CommandAction) => {
    onClose();
    setTimeout(() => action.run(), 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex(Math.min(current + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex(Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const action = filtered[current];
      if (action) run(action);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <>
      <div
        onMouseDown={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          background: "var(--scrim)",
        }}
      />
      <div
        style={{
          position: "fixed",
          top: "14vh",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 61,
          width: 560,
          maxWidth: "calc(100vw - 32px)",
          background: "var(--sf)",
          border: "1px solid var(--bd2)",
          borderRadius: 6,
          boxShadow: "var(--sh)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: 42,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 14px",
            borderBottom: "1px solid var(--bd)",
          }}
        >
          <i
            className="icon-search"
            style={{ fontSize: 14, color: "var(--fa)" }}
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a command or table name"
            style={{
              flex: 1,
              minWidth: 0,
              height: 30,
              border: 0,
              background: "transparent",
              fontSize: 13,
              color: "var(--tx)",
            }}
          />
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--fa)",
            }}
          >
            esc
          </span>
        </div>

        <div
          style={{
            maxHeight: 320,
            overflow: "auto",
            padding: 4,
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: "14px 10px", color: "var(--mu)" }}>
              No matching commands
            </div>
          ) : (
            filtered.map((action, itemIndex) => (
              <div
                key={action.id}
                onClick={() => run(action)}
                onMouseEnter={() => setIndex(itemIndex)}
                style={{
                  height: 30,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "0 10px",
                  borderRadius: 4,
                  background:
                    itemIndex === current ? "var(--hv)" : "transparent",
                  cursor: "default",
                }}
              >
                <i
                  className={action.icon}
                  style={{
                    width: 14,
                    fontSize: 14,
                    color: "var(--mu)",
                  }}
                />
                <span style={{ flex: 1 }}>{action.label}</span>
                {action.kb && (
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      color: "var(--fa)",
                    }}
                  >
                    {action.kb}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
