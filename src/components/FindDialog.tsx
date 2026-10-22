import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { errorMessage, findInDatabase } from "../ipc";
import type { SearchHit } from "../ipc";

interface Props {
  connId: string;
  database: string;
  onClose: () => void;
  onOpenResult: (table: string) => void;
}

const KIND_META: Record<SearchHit["kind"], { icon: string; label: string }> = {
  table: { icon: "icon-table", label: "TABLE" },
  column: { icon: "icon-columns-3", label: "COLUMN" },
  data: { icon: "icon-search", label: "DATA" },
};

export default function FindDialog({
  connId,
  database,
  onClose,
  onOpenResult,
}: Props) {
  const [term, setTerm] = useState("");
  const [caseInsensitive, setCaseInsensitive] = useState(true);
  const [includeData, setIncludeData] = useState(true);
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async () => {
    const value = term.trim();
    if (!value) return;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const hits = await findInDatabase(
        connId,
        database,
        value,
        caseInsensitive,
        includeData,
      );
      setResults(hits);
    } catch (searchError) {
      setError(errorMessage(searchError));
    } finally {
      setLoading(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void run();
    }
  };

  const open = (hit: SearchHit) => {
    onOpenResult(hit.table);
    onClose();
  };

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
              placeholder={`Find in ${database}…`}
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
              onClick={() => void run()}
              disabled={loading || !term.trim()}
            >
              {loading ? "Searching…" : "Find"}
            </button>
          </div>
          <div style={{ display: "flex", gap: 16, paddingLeft: 22 }}>
            <Toggle
              checked={includeData}
              label="Search data (rows)"
              onChange={() => setIncludeData((value) => !value)}
            />
            <Toggle
              checked={caseInsensitive}
              label="Case-insensitive"
              onChange={() => setCaseInsensitive((value) => !value)}
            />
          </div>
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

          {results && results.length === 0 && !error && (
            <div
              style={{
                padding: 24,
                textAlign: "center",
                color: "var(--mu)",
                fontSize: 12.5,
              }}
            >
              No matches for “{term.trim()}”.
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
                  color: "var(--tx)",
                  whiteSpace: "nowrap",
                }}
              >
                {hit.table}
                {hit.column ? (
                  <span style={{ color: "var(--fa)" }}>.{hit.column}</span>
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
                  {hit.value}
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
            {results ? `${results.length} result(s)` : "Enter a term and press Find"}
          </span>
          <span>double-click = open</span>
        </div>
      </div>
    </>
  );
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
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
