import { useMemo, useState } from "react";
import { copyText } from "../clipboard";
import type { ExplainPlan, PlanNode } from "../types";

interface Props {
  plan: ExplainPlan;
  busy: boolean;
  aiBusy: boolean;
  onAnalyzeChange: (analyze: boolean) => void;
  onAskAi: () => void;
}

interface FlatNode {
  node: PlanNode;
  path: string;
  depth: number;
}

function flatten(root: PlanNode): FlatNode[] {
  const rows: FlatNode[] = [];
  const visit = (node: PlanNode, path: string, depth: number) => {
    rows.push({ node, path, depth });
    node.children.forEach((child, index) =>
      visit(child, `${path}.${index}`, depth + 1),
    );
  };
  visit(root, "0", 0);
  return rows;
}

function formatNumber(value: number, digits = 0): string {
  if (Math.abs(value) >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 10_000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
  });
}

function formatTime(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  if (value >= 1) return `${value.toFixed(1)} ms`;
  return `${value.toFixed(2)} ms`;
}

function shareOf(node: PlanNode, totalCost: number, totalTime: number): number {
  const cost =
    totalCost > 0 && node.cost != null ? node.cost / totalCost : 0;
  const time =
    totalTime > 0 && node.time_ms != null ? node.time_ms / totalTime : 0;
  return Math.max(0, Math.min(1, Math.max(cost, time)));
}

export default function PlanView({
  plan,
  busy,
  aiBusy,
  onAnalyzeChange,
  onAskAi,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [rawOpen, setRawOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const entries = useMemo(() => flatten(plan.root), [plan.root]);
  const parentByPath = useMemo(() => {
    const parents = new Map<string, string | null>();
    for (const entry of entries) {
      const dot = entry.path.lastIndexOf(".");
      parents.set(entry.path, dot === -1 ? null : entry.path.slice(0, dot));
    }
    return parents;
  }, [entries]);

  const warnings = useMemo(
    () =>
      entries.flatMap((entry) =>
        entry.node.warnings.map((message) => ({
          message,
          path: entry.path,
          label: entry.node.label,
        })),
      ),
    [entries],
  );

  const costliestPath = useMemo(() => {
    let best: FlatNode | null = null;
    let bestValue = -1;
    for (const entry of entries) {
      if (entry.path === "0" && entries.length > 1) continue;
      const value = entry.node.cost ?? entry.node.time_ms ?? -1;
      if (value > bestValue) {
        bestValue = value;
        best = entry;
      }
    }
    return best?.path ?? entries[0]?.path ?? null;
  }, [entries]);

  const totalCost = plan.root.cost ?? 0;
  const totalTime = plan.root.time_ms ?? 0;

  const isHidden = (path: string): boolean => {
    let parent = parentByPath.get(path) ?? null;
    while (parent) {
      if (collapsed.has(parent)) return true;
      parent = parentByPath.get(parent) ?? null;
    }
    return false;
  };

  const toggle = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const reveal = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      let parent = parentByPath.get(path) ?? null;
      while (parent) {
        next.delete(parent);
        parent = parentByPath.get(parent) ?? null;
      }
      return next;
    });
    window.requestAnimationFrame(() => {
      document
        .getElementById(`plan-node-${path}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  };

  const copyRaw = async () => {
    const ok = await copyText(plan.raw || "");
    setCopied(ok);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          flex: "none",
          minHeight: 34,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "3px 10px",
          borderBottom: "1px solid var(--bd)",
          background: "var(--sf)",
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 500 }}>Execution plan</span>
        <span
          style={{
            fontSize: 11.5,
            color: plan.analyzed ? "var(--wn)" : "var(--fa)",
          }}
        >
          {plan.dialect} ·{" "}
          {plan.analyzed
            ? "ANALYZE — the query was executed"
            : "estimated — the query was not run"}
        </span>
        <div style={{ flex: 1 }} />
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: plan.analyzed ? "var(--wn)" : "var(--mu)",
            cursor: busy ? "not-allowed" : "default",
          }}
        >
          <input
            type="checkbox"
            checked={plan.analyzed}
            disabled={busy}
            onChange={(event) => onAnalyzeChange(event.target.checked)}
            style={{ margin: 0 }}
          />
          <span>Analyze (runs the query)</span>
        </label>
        <button
          type="button"
          className="v2-btn"
          onClick={onAskAi}
          disabled={busy || aiBusy}
          title="Ask AI for indexes based on this plan"
          style={{
            height: 24,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 10px",
            fontSize: 11.5,
          }}
        >
          <i className="icon-lightbulb" style={{ fontSize: 12 }} />
          <span>{aiBusy ? "Asking AI…" : "Ask AI for indexes"}</span>
        </button>
      </div>

      {busy && (
        <div
          style={{
            flex: "none",
            padding: "5px 10px",
            borderBottom: "1px solid var(--bd)",
            background: "var(--acs)",
            color: "var(--ac)",
            fontSize: 11.5,
          }}
        >
          Running EXPLAIN{plan.analyzed ? " ANALYZE" : ""}…
        </div>
      )}

      {warnings.length > 0 && (
        <div
          style={{
            flex: "none",
            maxHeight: 140,
            overflow: "auto",
            padding: "7px 10px",
            borderBottom: "1px solid var(--bd)",
            background: "var(--env-test-bg)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              letterSpacing: ".04em",
              textTransform: "uppercase",
              color: "var(--wn)",
            }}
          >
            Warnings
          </div>
          {warnings.map((warning, index) => (
            <button
              key={`${warning.path}-${index}`}
              type="button"
              className="df2-quiet"
              onClick={() => reveal(warning.path)}
              title="Go to this node"
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 7,
                padding: "2px 4px",
                border: 0,
                borderRadius: 4,
                background: "transparent",
                color: "var(--tx)",
                textAlign: "left",
                fontSize: 11.5,
                lineHeight: 1.45,
                cursor: "default",
              }}
            >
              <i
                className="icon-triangle-alert"
                style={{ fontSize: 11, color: "var(--wn)", flex: "none" }}
              />
              <span>
                <strong style={{ fontWeight: 500 }}>{warning.label}</strong>
                {" — "}
                {warning.message}
              </span>
            </button>
          ))}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {entries
          .filter((entry) => !isHidden(entry.path))
          .map((entry) => {
            const { node, path, depth } = entry;
            const hasChildren = node.children.length > 0;
            const isCollapsed = collapsed.has(path);
            const isCostliest = path === costliestPath;
            const share = shareOf(node, totalCost, totalTime);
            return (
              <div
                key={path}
                id={`plan-node-${path}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  minHeight: 26,
                  padding: "2px 10px 2px 0",
                  paddingLeft: 8 + depth * 16,
                  borderBottom: "1px solid var(--bd)",
                  background: isCostliest ? "var(--acs)" : "transparent",
                  fontFamily: "var(--mono)",
                  fontSize: 11.5,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                }}
                title={node.warnings.join("\n")}
              >
                <button
                  type="button"
                  onClick={() => hasChildren && toggle(path)}
                  disabled={!hasChildren}
                  aria-label={isCollapsed ? "Expand node" : "Collapse node"}
                  style={{
                    width: 16,
                    height: 16,
                    flex: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: 0,
                    background: "transparent",
                    color: "var(--fa)",
                    cursor: "default",
                    visibility: hasChildren ? "visible" : "hidden",
                  }}
                >
                  <i
                    className={
                      isCollapsed
                        ? "icon-chevron-right"
                        : "icon-chevron-down"
                    }
                    style={{ fontSize: 11 }}
                  />
                </button>

                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 7,
                    minWidth: 0,
                    flex: 1,
                    overflow: "hidden",
                  }}
                >
                  <span
                    style={{
                      fontWeight: isCostliest ? 600 : 400,
                      color: "var(--tx)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {node.label}
                  </span>
                  {node.relation && (
                    <span style={{ color: "var(--mu)", fontSize: 11 }}>
                      on {node.relation}
                    </span>
                  )}
                  {node.index && (
                    <span style={{ color: "var(--fa)", fontSize: 11 }}>
                      using {node.index}
                    </span>
                  )}
                  {node.warnings.length > 0 && (
                    <i
                      className="icon-triangle-alert"
                      style={{ fontSize: 11, color: "var(--wn)" }}
                    />
                  )}
                </div>

                <span
                  title="Estimated rows"
                  style={{
                    width: 78,
                    flex: "none",
                    textAlign: "right",
                    color: "var(--mu)",
                    fontSize: 11,
                  }}
                >
                  {node.rows_estimated != null
                    ? `~${formatNumber(node.rows_estimated)}`
                    : ""}
                </span>
                <span
                  title="Actual rows (ANALYZE)"
                  style={{
                    width: 74,
                    flex: "none",
                    textAlign: "right",
                    color: node.rows_actual != null ? "var(--tx)" : "var(--fa)",
                    fontSize: 11,
                  }}
                >
                  {node.rows_actual != null
                    ? formatNumber(node.rows_actual)
                    : ""}
                </span>
                <span
                  title="Node time"
                  style={{
                    width: 70,
                    flex: "none",
                    textAlign: "right",
                    color: node.time_ms != null ? "var(--tx)" : "var(--fa)",
                    fontSize: 11,
                  }}
                >
                  {node.time_ms != null ? formatTime(node.time_ms) : ""}
                </span>
                <span
                  title="Total cost"
                  style={{
                    width: 64,
                    flex: "none",
                    textAlign: "right",
                    color: "var(--mu)",
                    fontSize: 11,
                  }}
                >
                  {node.cost != null ? formatNumber(node.cost, 2) : ""}
                </span>
                <div
                  title="Share of the total cost / time"
                  style={{
                    width: 84,
                    height: 5,
                    flex: "none",
                    borderRadius: 3,
                    background: "var(--bd2)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.round(share * 100)}%`,
                      height: "100%",
                      background: isCostliest ? "var(--wn)" : "var(--ac)",
                    }}
                  />
                </div>
              </div>
            );
          })}
      </div>

      <div
        style={{
          flex: "none",
          borderTop: "1px solid var(--bd)",
          background: "var(--sf)",
        }}
      >
        <div
          style={{
            height: 30,
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "0 8px",
          }}
        >
          <button
            type="button"
            className="df2-quiet df2-hover-tx"
            onClick={() => setRawOpen((open) => !open)}
            style={{
              height: 24,
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "0 6px",
              border: 0,
              borderRadius: 4,
              color: "var(--mu)",
              cursor: "default",
              fontSize: 11.5,
            }}
          >
            <i
              className={
                rawOpen ? "icon-chevron-down" : "icon-chevron-right"
              }
              style={{ fontSize: 11 }}
            />
            <span>Raw</span>
          </button>
          <div style={{ flex: 1 }} />
          {rawOpen && (
            <button
              type="button"
              className="v2-btn"
              onClick={() => void copyRaw()}
              style={{ height: 22, padding: "0 9px", fontSize: 11.5 }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
        {rawOpen && (
          <pre
            className="allow-select"
            style={{
              margin: 0,
              maxHeight: 200,
              overflow: "auto",
              padding: "8px 10px",
              borderTop: "1px solid var(--bd)",
              background: "var(--bg)",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              lineHeight: "17px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {plan.raw || "(empty plan)"}
          </pre>
        )}
      </div>
    </div>
  );
}
