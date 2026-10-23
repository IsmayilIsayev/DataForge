import { useEffect, useState } from "react";
import { useAppStore } from "../store";

const KIND_LABEL: Record<string, string> = {
  write: "WRITE",
  ddl: "DDL",
  read: "READ",
};

export default function ProdConfirmDialog() {
  const request = useAppStore((state) => state.prodConfirm);
  const resolve = useAppStore((state) => state.resolveProdConfirm);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    setTyped("");
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") resolve(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, resolve]);

  if (!request) return null;

  const needsTyped = request.statements.some(
    (statement) => statement.requiresTypedConfirm,
  );
  const canConfirm =
    !needsTyped || typed.trim() === request.databaseName.trim();
  const sql = request.previewSql;

  return (
    <>
      <div
        onMouseDown={() => resolve(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 80,
          background: "var(--scrim)",
        }}
      />
      <section
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirm production changes"
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          position: "fixed",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 81,
          width: 500,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "82vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--sf)",
          border: "1px solid var(--env-prod)",
          borderRadius: 6,
          boxShadow: "var(--sh)",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "11px 12px",
            borderBottom: "1px solid var(--bd)",
            background: "var(--env-prod-bg)",
          }}
        >
          <i
            className="icon-triangle-alert"
            style={{ fontSize: 15, color: "var(--env-prod)" }}
          />
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {request.title ?? "Confirm changes on production"}
          </span>
        </header>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55 }}>
            {request.note ? (
              request.note
            ) : (
              <>
                You are about to change{" "}
                <strong style={{ color: "var(--env-prod)" }}>
                  {request.connectionName}
                </strong>
                .
                {needsTyped
                  ? " Type the database name to confirm."
                  : " This cannot be undone."}
              </>
            )}
          </p>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {sql ? (
              <div
                style={{
                  border: "1px solid var(--bd)",
                  borderRadius: 4,
                  background: "var(--bg)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "4px 8px",
                    borderBottom: "1px solid var(--bd)",
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                    letterSpacing: ".04em",
                    color: "var(--fa)",
                  }}
                >
                  PREVIEW SQL
                </div>
                <pre className="allow-select" style={preStyle}>
                  {sql}
                </pre>
              </div>
            ) : (
              request.statements.map((statement, index) => (
                <div
                  key={`${index}-${statement.sql.slice(0, 24)}`}
                  style={{
                    border: "1px solid var(--bd)",
                    borderRadius: 4,
                    background: "var(--bg)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 8px",
                      borderBottom: "1px solid var(--bd)",
                      fontFamily: "var(--mono)",
                      fontSize: 10,
                      letterSpacing: ".04em",
                      color: statement.requiresTypedConfirm
                        ? "var(--env-prod)"
                        : "var(--fa)",
                    }}
                  >
                    <span>{KIND_LABEL[statement.kind] ?? statement.kind}</span>
                    <span>·</span>
                    <span>{statement.keyword}</span>
                    {statement.kind === "write" &&
                      !statement.hasWhere &&
                      (statement.keyword === "UPDATE" ||
                        statement.keyword === "DELETE") && (
                        <>
                          <span>·</span>
                          <span>NO WHERE</span>
                        </>
                      )}
                  </div>
                  <pre className="allow-select" style={preStyle}>
                    {statement.sql}
                  </pre>
                </div>
              ))
            )}
          </div>

          {needsTyped && (
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 5,
                fontSize: 12,
                color: "var(--mu)",
              }}
            >
              <span>
                Type{" "}
                <code
                  style={{
                    fontFamily: "var(--mono)",
                    color: "var(--env-prod)",
                  }}
                >
                  {request.databaseName}
                </code>{" "}
                to confirm
              </span>
              <input
                autoFocus
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                spellCheck={false}
                autoComplete="off"
                className="v2-input"
                style={{
                  height: 28,
                  padding: "0 8px",
                  border: "1px solid var(--env-prod)",
                  borderRadius: 4,
                  background: "var(--bg)",
                  color: "var(--tx)",
                  fontFamily: "var(--mono)",
                  fontSize: 12.5,
                }}
              />
            </label>
          )}
        </div>

        <footer
          style={{
            flex: "none",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 12px",
            borderTop: "1px solid var(--bd)",
          }}
        >
          <button
            type="button"
            className="v2-btn"
            onClick={() => resolve(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="v2-btn"
            disabled={!canConfirm}
            onClick={() => resolve(true)}
            style={{
              background: "var(--env-prod)",
              borderColor: "var(--env-prod)",
              color: "#fff",
              fontWeight: 500,
              opacity: canConfirm ? 1 : 0.5,
            }}
          >
            {needsTyped ? "Change production" : "Confirm"}
          </button>
        </footer>
      </section>
    </>
  );
}

const preStyle = {
  margin: 0,
  padding: "7px 8px",
  maxHeight: 140,
  overflow: "auto",
  fontFamily: "var(--mono)",
  fontSize: 11.5,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap" as const,
  wordBreak: "break-word" as const,
};
