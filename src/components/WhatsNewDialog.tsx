import { useEffect, useMemo } from "react";

interface Props {
  version: string;
  notes: string;
  kind?: "available" | "whats-new";
  busy?: string | null;
  onInstall?: () => void;
  onClose: () => void;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "paragraph"; text: string };

function parseNotes(source: string): Block[] {
  const blocks: Block[] = [];
  let items: string[] | null = null;

  const flushList = () => {
    if (!items) return;
    blocks.push({ kind: "list", items });
    items = null;
  };

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushList();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        text: heading[2],
      });
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!items) items = [];
      items.push(bullet[1]);
      continue;
    }

    flushList();
    blocks.push({ kind: "paragraph", text: line });
  }

  flushList();
  return blocks;
}

export default function WhatsNewDialog({
  version,
  notes,
  kind = "available",
  busy,
  onInstall,
  onClose,
}: Props) {
  const blocks = useMemo(() => parseNotes(notes), [notes]);
  const title =
    kind === "whats-new"
      ? `What's new in v${version}`
      : `DataForge v${version} is available`;

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div
        onMouseDown={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 90, background: "var(--scrim)" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%,-50%)",
          zIndex: 91,
          width: 500,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 64px)",
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
            padding: "12px 16px",
            borderBottom: "1px solid var(--bd)",
          }}
        >
          <i
            className={kind === "whats-new" ? "icon-sparkles" : "icon-download"}
            style={{ fontSize: 15, color: "var(--ac)" }}
          />
          <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{title}</span>
          <button
            type="button"
            className="v2-icon-btn"
            onClick={onClose}
            aria-label="Close"
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
            <i className="icon-x" style={{ fontSize: 13 }} />
          </button>
        </div>

        <div
          className="allow-select"
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: "14px 16px",
            fontSize: 12.5,
          }}
        >
          {blocks.length === 0 ? (
            <span style={{ color: "var(--mu)" }}>See CHANGELOG.md.</span>
          ) : (
            blocks.map((block, index) => {
              if (block.kind === "heading") {
                return (
                  <div
                    key={index}
                    style={{
                      marginTop: index === 0 ? 0 : 4,
                      fontWeight: 600,
                      fontSize: block.level <= 2 ? 13 : 11,
                      letterSpacing: block.level <= 2 ? undefined : ".04em",
                      textTransform: block.level <= 2 ? undefined : "uppercase",
                      color: block.level <= 2 ? "var(--tx)" : "var(--mu)",
                    }}
                  >
                    {block.text}
                  </div>
                );
              }

              if (block.kind === "list") {
                return (
                  <ul
                    key={index}
                    style={{
                      margin: 0,
                      paddingLeft: 18,
                      display: "flex",
                      flexDirection: "column",
                      gap: 5,
                    }}
                  >
                    {block.items.map((item, itemIndex) => (
                      <li key={itemIndex} style={{ color: "var(--tx)", lineHeight: 1.5 }}>
                        {item}
                      </li>
                    ))}
                  </ul>
                );
              }

              return (
                <p key={index} style={{ margin: 0, color: "var(--mu)", lineHeight: 1.5 }}>
                  {block.text}
                </p>
              );
            })
          )}
        </div>

        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 16px",
            borderTop: "1px solid var(--bd)",
          }}
        >
          {busy ? (
            <span style={{ color: "var(--mu)" }}>{busy}</span>
          ) : (
            <>
              {kind === "available" && onInstall && (
                <button
                  type="button"
                  className="v2-btn v2-btn-primary"
                  onClick={onInstall}
                >
                  Install &amp; restart
                </button>
              )}
              <button type="button" className="v2-btn" onClick={onClose}>
                {kind === "available" ? "Later" : "Close"}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
