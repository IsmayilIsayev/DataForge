import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { matchPositions, rankItems } from "../fuzzy";
import { ensureSchemaIndex } from "../schemaIndex";
import { useAppStore } from "../store";
import type { ConnectionMeta } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenConnection: (connection: ConnectionMeta) => void;
  onOpenDatabase: (connection: ConnectionMeta, database: string) => void;
  onOpenTable: (
    connection: ConnectionMeta,
    database: string,
    table: string,
  ) => void;
  onOpenTableQuery: (
    connection: ConnectionMeta,
    database: string,
    table: string,
  ) => void;
}

type ItemKind = "connection" | "database" | "table" | "view";

interface GoToItem {
  key: string;
  kind: ItemKind;
  connection: ConnectionMeta;
  database?: string;
  table?: string;
  label: string;
  path: string;
  fields: string[];
}

const SEPARATOR = " › ";

function itemIcon(kind: ItemKind) {
  if (kind === "connection") return "icon-database";
  if (kind === "database") return "icon-database";
  if (kind === "view") return "icon-eye";
  return "icon-table";
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const positions = useMemo(
    () => new Set(matchPositions(text, query)),
    [text, query],
  );
  if (positions.size === 0) return <>{text}</>;

  return (
    <>
      {text.split("").map((character, index) =>
        positions.has(index) ? (
          <span
            key={index}
            style={{ color: "var(--ac)", fontWeight: 600 }}
          >
            {character}
          </span>
        ) : (
          <span key={index}>{character}</span>
        ),
      )}
    </>
  );
}

export default function GoToPalette({
  open,
  onClose,
  onOpenConnection,
  onOpenDatabase,
  onOpenTable,
  onOpenTableQuery,
}: Props) {
  const connections = useAppStore((state) => state.connections);
  const connected = useAppStore((state) => state.connected);
  const tableIndex = useAppStore((state) => state.tableIndex);
  const indexProgress = useAppStore((state) => state.indexProgress);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    void ensureSchemaIndex(false);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const connectedIds = useMemo(
    () =>
      connections
        .filter((connection) => connected[connection.id])
        .map((connection) => connection.id),
    [connections, connected],
  );

  const items = useMemo(() => {
    const next: GoToItem[] = [];
    const seen = new Set<string>();

    for (const connection of connections) {
      if (!connected[connection.id]) continue;

      next.push({
        key: `connection:${connection.id}`,
        kind: "connection",
        connection,
        label: connection.name,
        path: connection.name,
        fields: [connection.name, connection.dialect],
      });

      const cached = tableIndex[connection.id];
      if (!cached) continue;

      for (const database of cached.databases) {
        const key = `database:${connection.id}:${database}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const path = `${connection.name}${SEPARATOR}${database}`;
        next.push({
          key,
          kind: "database",
          connection,
          database,
          label: database,
          path,
          fields: [database, connection.name, path],
        });
      }

      for (const table of cached.tables) {
        const key = `table:${connection.id}:${table.database}:${table.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const path = `${connection.name}${SEPARATOR}${table.database}${SEPARATOR}${table.name}`;
        next.push({
          key,
          kind: table.kind,
          connection,
          database: table.database,
          table: table.name,
          label: table.name,
          path,
          fields: [
            table.name,
            table.database,
            `${table.database}.${table.name}`,
            path,
          ],
        });
      }
    }

    return next;
  }, [connections, connected, tableIndex]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items.slice(0, 50);
    return rankItems(items, query, (item) => item.fields)
      .slice(0, 50)
      .map((entry) => entry.item);
  }, [items, query]);

  const current = Math.min(index, Math.max(0, filtered.length - 1));
  const totalDatabases = connectedIds.reduce(
    (sum, id) =>
      sum +
      (indexProgress[id]?.total ?? tableIndex[id]?.databases.length ?? 0),
    0,
  );
  const doneDatabases = connectedIds.reduce(
    (sum, id) =>
      sum +
      (indexProgress[id]?.done ??
        (tableIndex[id] ? tableIndex[id].databases.length : 0)),
    0,
  );
  const indexing = connectedIds.some(
    (id) => !!indexProgress[id] || !tableIndex[id],
  );
  const lastLoaded = Math.max(
    0,
    ...connectedIds.map((id) => tableIndex[id]?.loadedAt ?? 0),
  );

  const run = (item: GoToItem, newQuery: boolean) => {
    onClose();
    setTimeout(() => {
      if (item.kind === "connection") {
        onOpenConnection(item.connection);
      } else if (item.kind === "database" && item.database) {
        onOpenDatabase(item.connection, item.database);
      } else if ((item.kind === "table" || item.kind === "view") && item.table) {
        if (newQuery) {
          onOpenTableQuery(item.connection, item.database ?? "", item.table);
        } else {
          onOpenTable(item.connection, item.database ?? "", item.table);
        }
      }
    }, 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex(
        Math.min(current + 1, Math.max(0, filtered.length - 1)),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex(Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const item = filtered[current];
      if (item) run(item, event.altKey);
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
          width: 640,
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
            placeholder="Go to connection, database or table…"
            spellCheck={false}
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
          <button
            type="button"
            className="df2-icon-btn"
            onClick={() => ensureSchemaIndex(true)}
            title="Refresh index"
            style={{
              width: 24,
              height: 24,
              flex: "none",
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
            <i className="icon-refresh-cw" style={{ fontSize: 13 }} />
          </button>
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
            maxHeight: 360,
            overflow: "auto",
            padding: 4,
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: "14px 10px", color: "var(--mu)" }}>
              {indexing && query.trim()
                ? "Indexing… results will appear as they load."
                : "No matching connections, databases or tables"}
            </div>
          ) : (
            filtered.map((item, itemIndex) => (
              <div
                key={item.key}
                onClick={() => run(item, false)}
                onMouseEnter={() => setIndex(itemIndex)}
                style={{
                  minHeight: 36,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "4px 10px",
                  borderRadius: 4,
                  background:
                    itemIndex === current ? "var(--hv)" : "transparent",
                  cursor: "default",
                }}
              >
                <i
                  className={itemIcon(item.kind)}
                  style={{
                    width: 14,
                    flex: "none",
                    fontSize: 14,
                    color:
                      item.kind === "view" ? "var(--wn)" : "var(--mu)",
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 13,
                    }}
                  >
                    <Highlighted text={item.label} query={query} />
                  </div>
                  {item.path !== item.label && (
                    <div
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 10.5,
                        color: "var(--fa)",
                      }}
                    >
                      {item.path}
                    </div>
                  )}
                </div>
                <span
                  style={{
                    flex: "none",
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                    color: "var(--fa)",
                  }}
                >
                  {item.kind}
                </span>
              </div>
            ))
          )}
        </div>

        <div
          style={{
            minHeight: 28,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 12px",
            borderTop: "1px solid var(--bd)",
            color: "var(--fa)",
            fontSize: 11,
          }}
        >
          {indexing ? (
            <span>
              {totalDatabases > 0
                ? `indexing ${doneDatabases}/${totalDatabases} databases…`
                : "indexing…"}
            </span>
          ) : (
            <span>
              {items.length} items
              {lastLoaded > 0
                ? ` · updated ${new Date(lastLoaded).toLocaleTimeString()}`
                : ""}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <span>↑↓ navigate · ↵ open · Alt+↵ SELECT *</span>
        </div>
      </div>
    </>
  );
}
