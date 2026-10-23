import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  aiNl2Sql,
  cancelOperation,
  errorMessage,
  findInDatabase,
  tableRowEstimate,
} from "../ipc";
import type { FindMode, FindProgress, SearchHit } from "../ipc";
import { escapeLikePattern, quoteIdentifier, stringLiteral } from "../sql";
import type { Dialect } from "../types";

interface Props {
  connId: string;
  database: string;
  dialect: Dialect;
  /** When set, the search is scoped to just this one table. */
  onlyTable?: string;
  onClose: () => void;
  /** Opens the hit's table; `where` filters it to just the matching rows. */
  onOpenResult: (table: string, where?: string) => void;
  /** Opens AI-generated SQL in a new query tab for review. */
  onRunSql: (sql: string) => void;
}

const KIND_META: Record<SearchHit["kind"], { icon: string; label: string }> = {
  table: { icon: "icon-table", label: "TABLE" },
  column: { icon: "icon-columns-3", label: "COLUMN" },
  data: { icon: "icon-search", label: "DATA" },
};

const MODE_KEY = "dataforge-find-mode";
const MODES: { value: FindMode; label: string }[] = [
  { value: "contains", label: "Contains" },
  { value: "starts_with", label: "Starts with" },
  { value: "exact", label: "Exact" },
];

function loadMode(): FindMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    if (stored === "contains" || stored === "starts_with" || stored === "exact") {
      return stored;
    }
  } catch {
    // localStorage may be unavailable; fall back to the default.
  }
  return "contains";
}

// Build a WHERE condition (no "WHERE" keyword) that filters a data hit's table
// down to the rows that actually contain the term, in the matching column.
function filterFor(
  hit: SearchHit,
  dialect: Dialect,
  term: string,
  caseInsensitive: boolean,
  mode: FindMode,
): string | undefined {
  if (hit.kind !== "data" || !hit.column) return undefined;
  const column = quoteIdentifier(dialect, hit.column);
  if (mode === "exact") {
    return `${column} = ${stringLiteral(dialect, term)}`;
  }
  const pattern =
    mode === "starts_with"
      ? `${escapeLikePattern(term)}%`
      : `%${escapeLikePattern(term)}%`;
  const op = caseInsensitive && dialect === "postgres" ? "ILIKE" : "LIKE";
  const escape =
    dialect === "sqlite" || dialect === "mssql" ? " ESCAPE '\\'" : "";
  return `${column} ${op} ${stringLiteral(dialect, pattern)}${escape}`;
}

function mergeHits(current: SearchHit[], incoming: SearchHit[]): SearchHit[] {
  const seen = new Set(
    current.map(
      (hit) => `${hit.kind}\u0000${hit.table}\u0000${hit.column ?? ""}\u0000${hit.value ?? ""}`,
    ),
  );
  const merged = [...current];
  for (const hit of incoming) {
    const key = `${hit.kind}\u0000${hit.table}\u0000${hit.column ?? ""}\u0000${hit.value ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
  }
  return merged;
}

export default function FindDialog({
  connId,
  database,
  dialect,
  onlyTable,
  onClose,
  onOpenResult,
  onRunSql,
}: Props) {
  const [term, setTerm] = useState("");
  const [caseInsensitive, setCaseInsensitive] = useState(true);
  const [includeData, setIncludeData] = useState(true);
  const [mode, setMode] = useState<FindMode>(loadMode);
  const [aiMode, setAiMode] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [results, setResults] = useState<SearchHit[] | null>(null);
  // The term the current results were produced with (so highlighting and the
  // open-filter stay correct even if the user edits the box without re-running).
  const [searchedTerm, setSearchedTerm] = useState("");
  const [searchedMode, setSearchedMode] = useState<FindMode>(mode);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [skipped, setSkipped] = useState<string[]>([]);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [tableRows, setTableRows] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const findIdRef = useRef<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<FindProgress>("find:progress", (event) => {
      const payload = event.payload;
      if (payload.id !== findIdRef.current) return;
      setProgress({ done: payload.done, total: payload.total });
      if (payload.hits.length > 0) {
        setResults((current) => [...(current ?? []), ...payload.hits]);
      }
      const table = payload.table;
      if (payload.skipped && table) {
        setSkipped((current) =>
          current.includes(table) ? current : [...current, table],
        );
      }
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // Events are unavailable outside Tauri; the final summary still works.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!onlyTable || dialect !== "postgres") {
      setTableRows(null);
      return;
    }
    let cancelled = false;
    tableRowEstimate(connId, database, onlyTable)
      .then((rows) => {
        if (!cancelled) setTableRows(rows);
      })
      .catch(() => {
        if (!cancelled) setTableRows(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connId, database, onlyTable, dialect]);

  const chooseMode = (next: FindMode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // Remembering the mode is best-effort.
    }
  };

  const run = async () => {
    const value = term.trim();
    if (!value) return;
    const id = `find-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    findIdRef.current = id;
    setLoading(true);
    setError(null);
    setResults([]);
    setSkipped([]);
    setProgress({ done: 0, total: 0 });
    setCancelRequested(false);
    setCancelled(false);
    setSearchedTerm(value);
    setSearchedMode(mode);
    try {
      const summary = await findInDatabase(
        connId,
        database,
        value,
        caseInsensitive,
        includeData,
        onlyTable,
        mode,
        id,
      );
      if (findIdRef.current !== id) return;
      setResults(summary.hits);
      setSkipped(summary.skipped);
      setProgress({ done: summary.done, total: summary.total });
      setCancelled(summary.cancelled);
    } catch (searchError) {
      if (findIdRef.current === id) setError(errorMessage(searchError));
    } finally {
      if (findIdRef.current === id) {
        findIdRef.current = null;
        setLoading(false);
        setCancelRequested(false);
      }
    }
  };

  const cancel = async () => {
    const id = findIdRef.current;
    if (!id) return;
    setCancelRequested(true);
    try {
      await cancelOperation(id);
    } catch {
      // The search may already have finished.
    }
  };

  const searchThisTable = async (table: string) => {
    const value = (searchedTerm || term).trim();
    if (!value) return;
    const id = `find-table-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const summary = await findInDatabase(
        connId,
        database,
        value,
        caseInsensitive,
        true,
        table,
        searchedMode,
        id,
        true,
      );
      const dataHits = summary.hits.filter((hit) => hit.kind === "data");
      setResults((current) => mergeHits(current ?? [], dataHits));
      setSkipped((current) => current.filter((name) => name !== table));
    } catch (searchError) {
      setError(errorMessage(searchError));
    }
  };

  // AI mode: send the natural-language question (any language) to nl2sql, which
  // already feeds the live schema to the model, then open the SQL for review.
  const ask = async () => {
    const value = term.trim();
    if (!value) return;
    setAiBusy(true);
    setError(null);
    try {
      const result = await aiNl2Sql(connId, value, true, database);
      if (result.sql && result.sql.trim()) {
        onRunSql(result.sql.trim());
        onClose();
      } else {
        setError("The AI did not return any SQL. Try rephrasing the question.");
      }
    } catch (aiError) {
      setError(errorMessage(aiError));
    } finally {
      setAiBusy(false);
    }
  };

  const submit = () => (aiMode ? void ask() : void run());

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  };

  const open = (hit: SearchHit) => {
    onOpenResult(
      hit.table,
      filterFor(hit, dialect, searchedTerm, caseInsensitive, searchedMode),
    );
    onClose();
  };

  const bigContainsHint =
    Boolean(onlyTable) &&
    dialect === "postgres" &&
    !aiMode &&
    mode === "contains" &&
    (tableRows ?? 0) > 200_000;
  const searching = loading && !aiMode;
  const progressLabel = progress
    ? progress.total > 0
      ? `Searching ${Math.min(progress.done, progress.total)}/${progress.total} tables…`
      : "Searching…"
    : "Searching…";

  return (
    <>
      <div
        onMouseDown={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 70,
          background: "var(--ov)",
        }}
      />
      <div
        style={{
          position: "fixed",
          left: "50%",
          top: "16%",
          transform: "translateX(-50%)",
          zIndex: 71,
          width: 600,
          maxWidth: "90vw",
          maxHeight: "68vh",
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
            flexDirection: "column",
            gap: 8,
            padding: 12,
            borderBottom: "1px solid var(--bd)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <i
              className="icon-search"
              style={{ fontSize: 14, color: "var(--fa)" }}
            />
            <input
              ref={inputRef}
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                aiMode
                  ? "Ask in any language, e.g. ən çox satılan 5 məhsul…"
                  : `Find in ${onlyTable ? `${database}.${onlyTable}` : database}…`
              }
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
              className="v2-btn v2-btn-primary"
              onClick={submit}
              disabled={loading || aiBusy || !term.trim()}
            >
              {aiMode
                ? aiBusy
                  ? "Asking…"
                  : "Ask AI"
                : loading
                  ? "Searching…"
                  : "Find"}
            </button>
          </div>
          <div style={{ display: "flex", gap: 16, paddingLeft: 22 }}>
            <Toggle
              checked={includeData}
              label="Search data (rows)"
              disabled={aiMode}
              onChange={() => setIncludeData((value) => !value)}
            />
            <Toggle
              checked={caseInsensitive}
              label="Case-insensitive"
              disabled={aiMode}
              onChange={() => setCaseInsensitive((value) => !value)}
            />
            <Toggle
              checked={aiMode}
              label="Ask AI (natural language)"
              onChange={() => setAiMode((value) => !value)}
            />
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              paddingLeft: 22,
            }}
          >
            <span style={{ color: "var(--mu)", fontSize: 11.5 }}>Mode</span>
            <div
              style={{
                display: "flex",
                border: "1px solid var(--bd2)",
                borderRadius: 4,
                overflow: "hidden",
                opacity: aiMode ? 0.4 : 1,
              }}
            >
              {MODES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  disabled={aiMode}
                  onClick={() => chooseMode(item.value)}
                  style={{
                    border: 0,
                    borderRight:
                      item.value === MODES[MODES.length - 1].value
                        ? 0
                        : "1px solid var(--bd2)",
                    background:
                      mode === item.value ? "var(--acd)" : "transparent",
                    color: mode === item.value ? "#fff" : "var(--mu)",
                    padding: "3px 9px",
                    fontSize: 11.5,
                    cursor: "default",
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          {bigContainsHint && (
            <div
              style={{
                paddingLeft: 22,
                color: "var(--mu)",
                fontSize: 11,
              }}
            >
              Contains-search scans the whole table. Starts with / Exact can use
              indexes.
            </div>
          )}
          {(searching || cancelRequested) && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                paddingLeft: 22,
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--fa)",
              }}
            >
              <span>{cancelRequested ? "Cancelling…" : progressLabel}</span>
              {searching && !cancelRequested && (
                <button
                  type="button"
                  className="v2-btn"
                  onClick={() => void cancel()}
                >
                  Cancel
                </button>
              )}
            </div>
          )}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {error && (
            <div
              style={{
                margin: 12,
                padding: "7px 8px",
                border: "1px solid var(--er)",
                borderRadius: 4,
                background: "var(--ers)",
                color: "var(--er)",
                fontFamily: "var(--mono)",
                fontSize: 11.5,
              }}
              role="alert"
            >
              {error}
            </div>
          )}

          {skipped.map((table) => (
            <div
              key={table}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 12px",
                fontSize: 11.5,
                color: "var(--mu)",
              }}
            >
              <i
                className="icon-triangle-alert"
                style={{ fontSize: 13, color: "var(--fa)", flex: "none" }}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontFamily: "var(--mono)" }}>{table}</span> —
                skipped (too slow)
              </span>
              <button
                type="button"
                className="v2-btn"
                onClick={() => void searchThisTable(table)}
              >
                Search this table only
              </button>
            </div>
          ))}

          {results &&
            results.length === 0 &&
            !error &&
            !loading &&
            skipped.length === 0 && (
              <div
                style={{
                  padding: 24,
                  textAlign: "center",
                  color: "var(--mu)",
                  fontSize: 12.5,
                }}
              >
                No matches for “{searchedTerm}”.
              </div>
            )}

          {results?.map((hit, index) => (
            <div
              key={index}
              className="df2-row"
              onDoubleClick={() => open(hit)}
              title="Double-click to open the table"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                height: 26,
                padding: "0 12px",
                cursor: "default",
                fontSize: 12.5,
              }}
            >
              <i
                className={KIND_META[hit.kind].icon}
                style={{ fontSize: 13, flex: "none", color: "var(--mu)" }}
              />
              <span
                style={{
                  width: 54,
                  flex: "none",
                  fontSize: 10,
                  letterSpacing: ".04em",
                  color: "var(--fa)",
                }}
              >
                {KIND_META[hit.kind].label}
              </span>
              <span
                style={{
                  fontFamily: "var(--mono)",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ color: "var(--ac)", fontWeight: 600 }}>
                  <Highlighted text={hit.table} term={searchedTerm} />
                </span>
                {hit.column ? (
                  <span style={{ color: "var(--fa)" }}>
                    .<Highlighted text={hit.column} term={searchedTerm} />
                  </span>
                ) : null}
              </span>
              {hit.value && (
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: "var(--mono)",
                    color: "var(--mu)",
                  }}
                >
                  <Highlighted text={hit.value} term={searchedTerm} />
                </span>
              )}
            </div>
          ))}
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
          <span>
            {cancelled
              ? `Search cancelled · ${results?.length ?? 0} result(s)`
              : results
                ? `${results.length} result(s)`
                : "Enter a term and press Find"}
          </span>
          <span>double-click = open</span>
        </div>
      </div>
    </>
  );
}

// Wraps every case-insensitive occurrence of `term` in an accent mark so the
// matched text is easy to spot inside a table name, column, or row snippet.
function Highlighted({ text, term }: { text: string; term: string }) {
  const needle = term.trim();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let found = lower.indexOf(target, from);
  if (found < 0) return <>{text}</>;
  let key = 0;
  while (found >= 0) {
    if (found > from) parts.push(text.slice(from, found));
    parts.push(
      <mark
        key={key++}
        style={{
          background: "var(--acs)",
          color: "var(--ac)",
          padding: "0 1px",
          borderRadius: 2,
        }}
      >
        {text.slice(found, found + needle.length)}
      </mark>,
    );
    from = found + needle.length;
    found = lower.indexOf(target, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

function Toggle({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: 0,
        border: 0,
        background: "transparent",
        color: "var(--mu)",
        fontSize: 11.5,
        cursor: "default",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <span
        style={{
          width: 14,
          height: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: `1px solid ${checked ? "var(--acd)" : "var(--bd2)"}`,
          borderRadius: 3,
          background: checked ? "var(--acd)" : "var(--bg)",
          color: "#fff",
        }}
      >
        {checked && <i className="icon-check" style={{ fontSize: 10 }} />}
      </span>
      <span>{label}</span>
    </button>
  );
}
