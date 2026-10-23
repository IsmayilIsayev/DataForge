import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { aiChat, errorMessage } from "../ipc";
import Markdown from "../markdown";
import type { MarkdownCodeBlock } from "../markdown";
import { chatThreadKey, useAppStore } from "../store";
import type { ChatMessage, ChatRequest, ChatResultContext } from "../types";

interface Props {
  connId: string | null;
  database: string | null;
  isConnected: boolean;
  hasKey: boolean;
  uiLanguage: string;
  onConfigure: () => void;
  onInsertSql: (sql: string) => void;
  onRunSql?: (sql: string) => void;
  request?: ChatRequest | null;
  onRequestHandled?: () => void;
}

const EMPTY_MESSAGES: ChatMessage[] = [];
let lastHandledRequestId = 0;

export default function AiChatView({
  connId,
  database,
  isConnected,
  hasKey,
  uiLanguage,
  onConfigure,
  onInsertSql,
  onRunSql,
  request,
  onRequestHandled,
}: Props) {
  const messages = useAppStore((state) =>
    connId
      ? (state.chatThreads[chatThreadKey(connId, database)] ?? EMPTY_MESSAGES)
      : EMPTY_MESSAGES,
  );
  const appendChatMessage = useAppStore((state) => state.appendChatMessage);
  const clearChatThread = useAppStore((state) => state.clearChatThread);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [messages.length, sending]);

  const send = useCallback(
    async (rawContent: string, result?: ChatResultContext) => {
      const content = rawContent.trim();
      if (!content || sendingRef.current) return;
      if (!connId) {
        setError("Select a connection first.");
        return;
      }
      if (!isConnected) {
        setError("Connect to the database first.");
        return;
      }
      if (!hasKey) {
        setError("Configure an AI provider and API key first.");
        onConfigure();
        return;
      }

      const key = chatThreadKey(connId, database);
      const existing = useAppStore.getState().chatThreads[key] ?? EMPTY_MESSAGES;
      const userMessage: ChatMessage = { role: "user", content };
      const history = [...existing, userMessage].slice(-12);

      sendingRef.current = true;
      setSending(true);
      setError(null);
      setInput("");
      appendChatMessage(connId, database, userMessage);

      try {
        const response = await aiChat(
          connId,
          database ?? undefined,
          history,
          uiLanguage,
          result,
        );
        appendChatMessage(connId, database, {
          role: "assistant",
          content: response.trim() || "(empty response)",
        });
      } catch (chatError) {
        setError(errorMessage(chatError));
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [
      appendChatMessage,
      connId,
      database,
      hasKey,
      isConnected,
      onConfigure,
      uiLanguage,
    ],
  );

  useEffect(() => {
    if (!request || request.id === lastHandledRequestId) return;
    lastHandledRequestId = request.id;
    void send(request.content, request.result);
    onRequestHandled?.();
  }, [onRequestHandled, request, send]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (!sending && input.trim()) void send(input);
    }
  };

  const handleClear = () => {
    if (!connId) return;
    clearChatThread(connId, database);
    setError(null);
  };

  const renderCode = (block: MarkdownCodeBlock, index: number) => {
    if (!block.language.toLowerCase().startsWith("sql")) return undefined;

    return (
      <div
        key={index}
        style={{
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--bd)",
          borderRadius: 4,
          background: "var(--bg)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: 26,
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "0 4px 0 8px",
            borderBottom: "1px solid var(--bd)",
          }}
        >
          <span
            style={{
              flex: 1,
              fontSize: 10.5,
              letterSpacing: ".04em",
              textTransform: "uppercase",
              color: "var(--fa)",
            }}
          >
            SQL
          </span>
          <button
            type="button"
            className="v2-btn"
            onClick={() => onInsertSql(block.text)}
            style={{ height: 20, padding: "0 7px", fontSize: 11 }}
          >
            Insert into editor
          </button>
          {onRunSql && (
            <button
              type="button"
              className="v2-btn v2-btn-primary"
              onClick={() => onRunSql(block.text)}
              disabled={!isConnected}
              style={{ height: 20, padding: "0 7px", fontSize: 11 }}
            >
              Run
            </button>
          )}
        </div>
        <pre
          className="allow-select"
          style={{
            margin: 0,
            padding: "8px 10px",
            overflow: "auto",
            fontFamily: "var(--mono)",
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {block.text}
        </pre>
      </div>
    );
  };

  if (!connId) {
    return (
      <div style={{ padding: 12, color: "var(--mu)", lineHeight: 1.5 }}>
        Select a connection to chat about a database.
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        ref={listRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: 12,
        }}
      >
        {messages.length === 0 && !sending && (
          <div
            style={{
              padding: "10px 11px",
              border: "1px solid var(--bd)",
              borderRadius: 6,
              background: "var(--sf2)",
              color: "var(--mu)",
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            Ask about this database — schema questions, query ideas, or how to
            read a result. SQL suggestions appear in runnable blocks.
          </div>
        )}

        {messages.map((message, index) => {
          const user = message.role === "user";
          return (
            <div
              key={index}
              style={{
                display: "flex",
                justifyContent: user ? "flex-end" : "flex-start",
              }}
            >
              <div
                className="allow-select"
                style={{
                  maxWidth: "94%",
                  minWidth: 0,
                  padding: "7px 9px",
                  border: `1px solid ${user ? "var(--acd)" : "var(--bd)"}`,
                  borderRadius: 6,
                  background: user ? "var(--acs)" : "var(--sf2)",
                  color: "var(--tx)",
                  fontSize: 12.5,
                  lineHeight: 1.5,
                }}
              >
                {user ? (
                  <span style={{ whiteSpace: "pre-wrap" }}>
                    {message.content}
                  </span>
                ) : (
                  <Markdown
                    source={message.content}
                    variant="chat"
                    renderCode={renderCode}
                  />
                )}
              </div>
            </div>
          );
        })}

        {sending && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "7px 10px",
                border: "1px solid var(--bd)",
                borderRadius: 6,
                background: "var(--sf2)",
                color: "var(--mu)",
                fontSize: 12,
              }}
            >
              <i className="icon-sparkles" style={{ fontSize: 12 }} />
              <span>Thinking…</span>
            </div>
          </div>
        )}

        {error && (
          <div
            role="alert"
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
          >
            {error}
          </div>
        )}
      </div>

      <div
        style={{
          flex: "none",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: 12,
          borderTop: "1px solid var(--bd)",
        }}
      >
        <span style={{ color: "var(--fa)", fontSize: 10.5, lineHeight: 1.4 }}>
          Result explanations send the last executed SQL and up to 50 rows to
          your AI provider.
        </span>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          placeholder="Ask about this database"
          className="v2-input"
          style={{
            width: "100%",
            padding: 8,
            border: "1px solid var(--bd2)",
            borderRadius: 4,
            background: "var(--bg)",
            color: "var(--tx)",
            fontSize: 12.5,
            lineHeight: 1.45,
            resize: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              flex: 1,
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--fa)",
            }}
          >
            ↵ send · ⇧↵ newline
          </span>
          <button
            type="button"
            className="v2-btn"
            onClick={handleClear}
            disabled={sending || messages.length === 0}
          >
            Clear chat
          </button>
          <button
            type="button"
            className="v2-btn v2-btn-primary"
            onClick={() => void send(input)}
            disabled={sending || !input.trim()}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
