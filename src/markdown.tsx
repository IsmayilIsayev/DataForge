import { useMemo } from "react";
import type { ReactNode } from "react";

export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; language: string; text: string };

export type MarkdownCodeBlock = Extract<MarkdownBlock, { kind: "code" }>;

export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let items: string[] | null = null;
  let paragraph: string[] = [];
  let code: { language: string; lines: string[] } | null = null;

  const flushList = () => {
    if (!items) return;
    blocks.push({ kind: "list", items });
    items = null;
  };

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (code) {
      if (line.startsWith("```")) {
        blocks.push({
          kind: "code",
          language: code.language,
          text: code.lines.join("\n"),
        });
        code = null;
      } else {
        code.lines.push(rawLine);
      }
      continue;
    }

    if (line.startsWith("```")) {
      flushList();
      flushParagraph();
      code = { language: line.slice(3).trim(), lines: [] };
      continue;
    }

    if (!line) {
      flushList();
      flushParagraph();
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushList();
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        text: heading[2],
      });
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (!items) items = [];
      items.push(bullet[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushList();
  flushParagraph();
  if (code) {
    blocks.push({
      kind: "code",
      language: code.language,
      text: code.lines.join("\n"),
    });
  }

  return blocks;
}

export function renderInline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, index) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={index}
          style={{
            padding: "0 3px",
            border: "1px solid var(--bd)",
            borderRadius: 3,
            background: "var(--sf2)",
            fontFamily: "var(--mono)",
            fontSize: "0.94em",
          }}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

interface MarkdownProps {
  source: string;
  variant?: "notes" | "chat";
  className?: string;
  renderCode?: (block: MarkdownCodeBlock, index: number) => ReactNode;
}

export default function Markdown({
  source,
  variant = "notes",
  className,
  renderCode,
}: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const chat = variant === "chat";

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 0,
        overflowWrap: "anywhere",
      }}
    >
      {blocks.map((block, index) => {
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
              {renderInline(block.text)}
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
                <li
                  key={itemIndex}
                  style={{
                    color: "var(--tx)",
                    lineHeight: chat ? 1.55 : 1.5,
                  }}
                >
                  {renderInline(item)}
                </li>
              ))}
            </ul>
          );
        }

        if (block.kind === "code") {
          if (renderCode) {
            const custom = renderCode(block, index);
            if (custom !== undefined && custom !== null) return custom;
          }
          return (
            <pre
              key={index}
              className="allow-select"
              style={{
                margin: 0,
                padding: "8px 10px",
                overflow: "auto",
                border: "1px solid var(--bd)",
                borderRadius: 4,
                background: "var(--sf2)",
                color: "var(--tx)",
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {block.text}
            </pre>
          );
        }

        return (
          <p
            key={index}
            style={{
              margin: 0,
              color: chat ? "var(--tx)" : "var(--mu)",
              lineHeight: chat ? 1.55 : 1.5,
            }}
          >
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}
