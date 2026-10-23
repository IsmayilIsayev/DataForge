import { useState } from "react";
import type { CSSProperties } from "react";
import { copyText } from "../clipboard";
import type {
  AiActionState,
  AiExplainResult,
  AiFixResult,
  AiOptimizeResult,
} from "../types";

interface Props {
  state: AiActionState;
  onClose: () => void;
  onApply: (sql: string) => void;
  onOpenInEditor?: (sql: string) => void;
}

const panelStyle: CSSProperties = {
  position: "absolute",
  right: 12,
  bottom: 12,
  width: "min(560px, calc(100% - 24px))",
  maxHeight: "62%",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  border: "1px solid var(--bd2)",
  borderRadius: 6,
  background: "var(--sf)",
  boxShadow: "var(--sh)",
  zIndex: 20,
};

const headerStyle: CSSProperties = {
  height: 30,
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0 4px 0 10px",
  borderBottom: "1px solid var(--bd)",
};

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 12,
};

const blockStyle: CSSProperties = {
  minWidth: 0,
  border: "1px solid var(--bd)",
  borderRadius: 4,
  background: "var(--bg)",
  overflow: "hidden",
};

const labelStyle: CSSProperties = {
  padding: "4px 8px",
  borderBottom: "1px solid var(--bd)",
  fontSize: 10.5,
  letterSpacing: ".04em",
  textTransform: "uppercase",
  color: "var(--fa)",
};

const preStyle: CSSProperties = {
  margin: 0,
  padding: "8px 10px",
  overflow: "auto",
  fontFamily: "var(--mono)",
  fontSize: 12,
  lineHeight: "18px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const warningStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  fontSize: 12,
  lineHeight: 1.5,
};

const actionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
};

function WarningDot() {
  return (
    <span
      style={{
        width: 6,
        height: 6,
        flex: "none",
        borderRadius: "50%",
        background: "var(--wn)",
        transform: "translateY(-1px)",
      }}
    />
  );
}

function FixBody({
  originalSql,
  result,
  onApply,
  onClose,
}: {
  originalSql: string;
  result: AiFixResult;
  onApply: (sql: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      {result.explanation && (
        <p style={{ margin: 0, color: "var(--mu)", textWrap: "pretty" }}>
          {result.explanation}
        </p>
      )}

      {result.needs_confirmation && (
        <div style={warningStyle}>
          <WarningDot />
          <span>Review this statement before running it.</span>
        </div>
      )}

      {result.warnings.map((warning, index) => (
        <div key={index} style={warningStyle}>
          <WarningDot />
          <span>{warning}</span>
        </div>
      ))}

      {result.sql.trim() && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
            }}
          >
            <div style={blockStyle}>
              <div style={labelStyle}>Current</div>
              <pre className="allow-select" style={preStyle}>
                {originalSql}
              </pre>
            </div>
            <div style={blockStyle}>
              <div style={labelStyle}>Fixed</div>
              <pre className="allow-select" style={preStyle}>
                {result.sql}
              </pre>
            </div>
          </div>

          <div style={actionsStyle}>
            <button type="button" className="v2-btn" onClick={onClose}>
              Dismiss
            </button>
            <button
              type="button"
              className="v2-btn v2-btn-primary"
              onClick={() => onApply(result.sql)}
            >
              Apply
            </button>
          </div>
        </>
      )}
    </>
  );
}

function createIndexStatements(result: AiOptimizeResult): string[] {
  const text = [
    ...result.suggestions,
    result.rewritten_sql ?? "",
  ].join("\n");
  const matches = text.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+[^;\n]+/gi) ?? [];
  const indexes = new Map<string, string>();
  for (const match of matches) {
    const cleaned = match.trim().replace(/^`+|`+$/g, "").trim();
    if (!cleaned) continue;
    const statement = cleaned.endsWith(";") ? cleaned : `${cleaned};`;
    indexes.set(statement.toLowerCase(), statement);
  }
  return [...indexes.values()];
}

function OptimizeBody({
  result,
  onApply,
  onClose,
  onOpenInEditor,
}: {
  result: AiOptimizeResult;
  onApply: (sql: string) => void;
  onClose: () => void;
  onOpenInEditor?: (sql: string) => void;
}) {
  const [copiedIndex, setCopiedIndex] = useState<string | null>(null);
  const rewritten = result.rewritten_sql?.trim()
    ? result.rewritten_sql
    : null;
  const indexes = createIndexStatements(result);

  const copyIndex = async (sql: string) => {
    const ok = await copyText(sql);
    setCopiedIndex(ok ? sql : null);
    window.setTimeout(() => setCopiedIndex(null), 1500);
  };

  return (
    <>
      {result.suggestions.length > 0 ? (
        <ul
          style={{
            margin: 0,
            paddingLeft: 18,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {result.suggestions.map((suggestion, index) => (
            <li
              key={index}
              style={{ fontSize: 12, lineHeight: 1.5, textWrap: "pretty" }}
            >
              {suggestion}
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ margin: 0, color: "var(--mu)" }}>No suggestions.</p>
      )}

      {indexes.length > 0 && (
        <div style={blockStyle}>
          <div style={labelStyle}>Suggested indexes</div>
          <div
            style={{
              padding: "6px 8px",
              fontSize: 11,
              color: "var(--fa)",
              borderBottom: "1px solid var(--bd)",
            }}
          >
            Review before running — nothing is executed automatically.
          </div>
          {indexes.map((indexSql) => (
            <div
              key={indexSql}
              style={{ borderTop: "1px solid var(--bd)" }}
            >
              <pre className="allow-select" style={preStyle}>
                {indexSql}
              </pre>
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                  padding: "0 8px 8px",
                }}
              >
                <button
                  type="button"
                  className="v2-btn"
                  onClick={() => void copyIndex(indexSql)}
                >
                  {copiedIndex === indexSql ? "Copied" : "Copy"}
                </button>
                {onOpenInEditor && (
                  <button
                    type="button"
                    className="v2-btn"
                    onClick={() => onOpenInEditor(indexSql)}
                  >
                    Open in editor
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {rewritten && (
        <>
          <div style={blockStyle}>
            <div style={labelStyle}>Rewritten SQL</div>
            <pre className="allow-select" style={preStyle}>
              {rewritten}
            </pre>
          </div>
          <div style={actionsStyle}>
            <button type="button" className="v2-btn" onClick={onClose}>
              Dismiss
            </button>
            <button
              type="button"
              className="v2-btn v2-btn-primary"
              onClick={() => onApply(rewritten)}
            >
              Apply
            </button>
          </div>
        </>
      )}
    </>
  );
}

function ExplainBody({ result }: { result: AiExplainResult }) {
  return (
    <p
      style={{
        margin: 0,
        color: "var(--tx)",
        fontSize: 12.5,
        lineHeight: 1.55,
        textWrap: "pretty",
      }}
    >
      {result.summary}
    </p>
  );
}

const TITLES = {
  fix: "Fix with AI",
  explain: "Explain SQL",
  optimize: "Optimize SQL",
} as const;

export default function AiActionPanel({
  state,
  onClose,
  onApply,
  onOpenInEditor,
}: Props) {
  return (
    <section style={panelStyle} aria-label={TITLES[state.kind]}>
      <header style={headerStyle}>
        <i
          className="icon-sparkles"
          style={{ fontSize: 13, color: "var(--ac)" }}
        />
        <span style={{ fontWeight: 500 }}>{TITLES[state.kind]}</span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="v2-icon-btn"
          onClick={onClose}
          aria-label="Dismiss AI panel"
          style={{
            width: 24,
            height: 24,
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
          <i className="icon-x" style={{ fontSize: 13 }} />
        </button>
      </header>

      <div style={bodyStyle}>
        {state.error && (
          <div
            style={{
              padding: "7px 8px",
              border: "1px solid var(--er)",
              borderRadius: 4,
              background: "var(--ers)",
              color: "var(--er)",
              fontSize: 11.5,
              lineHeight: 1.45,
              overflowWrap: "anywhere",
            }}
            role="alert"
          >
            {state.error}
          </div>
        )}

        {state.kind === "fix" && state.result && (
          <FixBody
            originalSql={state.originalSql}
            result={state.result}
            onApply={onApply}
            onClose={onClose}
          />
        )}

        {state.kind === "explain" && state.result && (
          <ExplainBody result={state.result} />
        )}

        {state.kind === "optimize" && state.result && (
          <OptimizeBody
            result={state.result}
            onApply={onApply}
            onClose={onClose}
            onOpenInEditor={onOpenInEditor}
          />
        )}
      </div>
    </section>
  );
}
