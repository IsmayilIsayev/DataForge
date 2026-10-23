import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { copyText } from "../clipboard";
import { aiGetConfig, aiNl2Sql, aiSetConfig, errorMessage } from "../ipc";
import { formatSql } from "../sql";
import { useAppStore } from "../store";
import type { AiConfig, AiProvider, Nl2SqlResult } from "../types";

interface Props {
  onClose: () => void;
}

const CUSTOM_MODEL = "__custom__";

type AiPreset =
  | "openai"
  | "openrouter"
  | "groq"
  | "ollama"
  | "lmstudio"
  | "opencode"
  | "google"
  | "custom";

const AI_PRESETS: Record<
  AiPreset,
  {
    label: string;
    provider: AiProvider;
    baseUrl: string;
    model: string;
    note?: string;
  }
> = {
  openai: {
    label: "OpenAI",
    provider: "openai_compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    note: "Uses the official https://api.openai.com/v1 endpoint.",
  },
  openrouter: {
    label: "OpenRouter",
    provider: "openai_compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    note: "Routes requests through OpenRouter.",
  },
  groq: {
    label: "Groq",
    provider: "openai_compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    note: "Uses Groq's free OpenAI-compatible endpoint.",
  },
  ollama: {
    label: "Ollama (local)",
    provider: "openai_compatible",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.1",
    note: "Local & free. Run `ollama serve` and pull a model. Any text works as the API key.",
  },
  lmstudio: {
    label: "LM Studio (local)",
    provider: "openai_compatible",
    baseUrl: "http://localhost:1234/v1",
    model: "local-model",
    note: "Local & free. Start LM Studio's local server. Any text works as the API key.",
  },
  opencode: {
    label: "opencode (local)",
    provider: "openai_compatible",
    baseUrl: "http://localhost:4096/v1",
    model: "gpt-4o-mini",
    note: "Change host:port to match your local OpenAI-compatible server.",
  },
  google: {
    label: "Google",
    provider: "google",
    baseUrl: "",
    model: "gemini-2.0-flash",
    note: "Uses the Google Generative Language API.",
  },
  custom: {
    label: "Custom / OpenAI-compatible",
    provider: "openai_compatible",
    baseUrl: "",
    model: "",
    note: "Enter any OpenAI-compatible base URL, model, and key.",
  },
};

const MODEL_OPTIONS: Record<AiPreset, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "o3-mini"],
  openrouter: [
    "openai/gpt-4o-mini",
    "anthropic/claude-3.5-sonnet",
    "google/gemini-2.0-flash-001",
    "meta-llama/llama-3.3-70b-instruct",
  ],
  groq: [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "mixtral-8x7b-32768",
    "gemma2-9b-it",
  ],
  ollama: ["llama3.1", "qwen2.5", "mistral", "deepseek-r1"],
  lmstudio: ["local-model", "qwen2.5", "mistral", "llama3.1"],
  opencode: ["gpt-4o-mini", "gpt-4o", "anthropic/claude-3.5-sonnet"],
  google: [
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ],
  custom: [],
};

const KEYWORDS = new Set(
  "select from where and or not exists left right inner outer join on group by order limit offset as desc asc nulls last first having distinct in is null like ilike interval case when then else end with union all insert into values update set delete drop table truncate create alter returning".split(
    " ",
  ),
);
const FUNCTIONS = new Set([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "now",
  "coalesce",
  "lower",
  "upper",
  "date_trunc",
]);

function inferPreset(config: AiConfig): AiPreset {
  if (config.provider === "openai") return "openai";
  if (config.provider === "google") return "google";

  const url = (config.base_url ?? "").toLowerCase();
  if (url.includes("api.openai.com")) return "openai";
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("api.groq.com")) return "groq";
  if (url.includes(":11434")) return "ollama";
  if (url.includes(":1234")) return "lmstudio";
  if (url.includes("localhost") || url.includes("127.0.0.1")) return "opencode";
  return "custom";
}

function sqlHighlight(sql: string): ReactNode {
  return sql.split("\n").map((line, lineIndex) => {
    const tokens: ReactNode[] = [];
    const re =
      /(--.*$)|('(?:[^']|'')*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)|(\s+)|(.)/g;
    let match: RegExpExecArray | null;
    let key = 0;
    while ((match = re.exec(line))) {
      const text = match[0];
      let color = "var(--tx)";
      let fontStyle = "normal";
      if (match[1]) {
        color = "var(--fa)";
        fontStyle = "italic";
      } else if (match[2]) {
        color = "var(--str)";
      } else if (match[3]) {
        color = "var(--num)";
      } else if (match[4]) {
        const lower = match[4].toLowerCase();
        if (KEYWORDS.has(lower)) color = "var(--kw)";
        else if (FUNCTIONS.has(lower)) color = "var(--fn)";
      } else if (match[6]) {
        color = "var(--mu)";
      }
      tokens.push(
        <span key={key++} style={{ color, fontStyle }}>
          {text}
        </span>,
      );
    }
    return (
      <div key={lineIndex} style={{ minHeight: 18 }}>
        {tokens}
      </div>
    );
  });
}

const inputStyle = {
  width: "100%",
  height: 28,
  padding: "0 8px",
  border: "1px solid var(--bd2)",
  borderRadius: 4,
  background: "var(--bg)",
  color: "var(--tx)",
  fontSize: 12.5,
} as const;

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ color: "var(--mu)", fontSize: 11.5 }}>{label}</span>
      {children}
    </label>
  );
}

export default function AiPanel({ onClose }: Props) {
  const activeConnId = useAppStore((state) => state.activeConnId);
  const activeDb = useAppStore((state) => state.activeDb);

  const connected = useAppStore((state) => state.connected);
  const connections = useAppStore((state) => state.connections);
  const setSql = useAppStore((state) => state.setSql);

  const [config, setConfig] = useState<AiConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preset, setPreset] = useState<AiPreset>("openai");
  const [provider, setProvider] = useState<AiProvider>("openai_compatible");
  const [model, setModel] = useState("gpt-4o-mini");
  const [modelCustom, setModelCustom] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [includeSchema, setIncludeSchema] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<Nl2SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);

  const isConnected = activeConnId ? !!connected[activeConnId] : false;
  const hasKey = !!config?.has_key;
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const keyMatchesProvider =
    hasKey &&
    config?.provider === provider &&
    (provider !== "openai_compatible" ||
      (config.base_url ?? "").replace(/\/+$/, "") === normalizedBaseUrl);
  const activeDialect =
    connections.find((connection) => connection.id === activeConnId)?.dialect ??
    "mysql";

  const applyConfig = (value: AiConfig) => {
    const nextPreset = inferPreset(value);
    setConfig(value);
    setPreset(nextPreset);
    setProvider(value.provider);
    setModel(value.model);
    setModelCustom(!MODEL_OPTIONS[nextPreset].includes(value.model));
    setBaseUrl(value.base_url ?? "");
  };

  useEffect(() => {
    let cancelled = false;

    aiGetConfig()
      .then((value) => {
        if (cancelled) return;
        applyConfig(value);
        if (!value.has_key) setSettingsOpen(true);
      })
      .catch((configError) => {
        if (!cancelled) {
          setSettingsOpen(true);
          setError(errorMessage(configError));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [activeConnId]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const openSettings = () => {
    if (config) applyConfig(config);
    setError(null);
    setSettingsOpen(true);
  };

  const closeSettings = () => {
    if (config) applyConfig(config);
    if (keyRef.current) keyRef.current.value = "";
    setError(null);
    setSettingsOpen(false);
  };

  const applyPreset = (value: AiPreset) => {
    const next = AI_PRESETS[value];
    setPreset(value);
    setProvider(next.provider);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setModelCustom(!next.model || !MODEL_OPTIONS[value].includes(next.model));
    setError(null);
  };

  const handleSaveSettings = async (event: FormEvent) => {
    event.preventDefault();

    if (!model.trim()) {
      setError("Enter a model name.");
      return;
    }
    if (preset === "custom" && !baseUrl.trim()) {
      setError("Base URL is required for the Custom provider.");
      return;
    }

    setSavingSettings(true);
    setError(null);

    try {
      const apiKey = keyRef.current?.value.trim() || undefined;
      const baseUrlForSave =
        preset === "custom"
          ? baseUrl.trim()
          : AI_PRESETS[preset].baseUrl.trim();
      const value = await aiSetConfig(
        provider,
        model.trim(),
        provider === "openai_compatible" ? baseUrlForSave : undefined,
        apiKey,
      );

      if (keyRef.current) keyRef.current.value = "";
      applyConfig(value);

      if (!value.has_key) {
        setSettingsOpen(true);
        setError("Enter an API key to use AI.");
      } else {
        setSettingsOpen(false);
      }
    } catch (settingsError) {
      setError(errorMessage(settingsError));
    } finally {
      setSavingSettings(false);
    }
  };

  const handleAsk = async () => {
    const trimmed = question.trim();

    if (!activeConnId) {
      setError("Select a connection first.");
      return;
    }
    if (!isConnected) {
      setError("Connect to the database first.");
      return;
    }
    if (!trimmed) {
      setError("Describe the query first.");
      return;
    }
    if (!hasKey) {
      setError("Configure an AI provider and API key first.");
      setSettingsOpen(true);
      return;
    }

    setAsking(true);
    setError(null);
    setResult(null);

    try {
      const response = await aiNl2Sql(
        activeConnId,
        trimmed,
        includeSchema,
        activeDb ?? undefined,
      );
      setResult({
        ...response,
        sql: formatSql(response.sql, activeDialect),
      });
    } catch (askError) {
      setError(errorMessage(askError));
    } finally {
      setAsking(false);
    }
  };

  const handleQuestionKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (!asking && hasKey && isConnected && activeConnId && question.trim()) {
        void handleAsk();
      }
    }
  };

  const useSql = () => {
    if (!result?.sql.trim()) return;
    setSql(formatSql(result.sql, activeDialect));
  };

  const copySql = async () => {
    if (!result?.sql) return;
    const ok = await copyText(result.sql);
    setCopied(ok);
  };

  const settingsForm = (
    <form
      onSubmit={handleSaveSettings}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 12,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12.5, fontWeight: 500 }}>AI settings</span>
        <span style={{ color: "var(--mu)", fontSize: 11.5, lineHeight: 1.45 }}>
          The API key is stored in the OS keychain and never returned to the UI.
        </span>
      </div>

      <Field label="Provider">
        <select
          value={preset}
          onChange={(event) => applyPreset(event.target.value as AiPreset)}
          style={inputStyle}
        >
          <option value="openai">OpenAI</option>
          <option value="openrouter">OpenRouter</option>
          <option value="groq">Groq</option>
          <option value="ollama">Ollama (local)</option>
          <option value="lmstudio">LM Studio (local)</option>
          <option value="opencode">opencode (local)</option>
          <option value="google">Google Gemini</option>
          <option value="custom">Custom / OpenAI-compatible</option>
        </select>
      </Field>

      {AI_PRESETS[preset].note && (
        <p
          style={{
            margin: "-4px 0 0",
            color: "var(--fa)",
            fontSize: 10.5,
            lineHeight: 1.45,
          }}
        >
          {AI_PRESETS[preset].note}
        </p>
      )}

      <Field label="Model">
        {MODEL_OPTIONS[preset].length > 0 && (
          <select
            value={modelCustom ? CUSTOM_MODEL : model}
            onChange={(event) => {
              const value = event.target.value;
              if (value === CUSTOM_MODEL) {
                setModelCustom(true);
              } else {
                setModel(value);
                setModelCustom(false);
              }
            }}
            style={inputStyle}
          >
            {MODEL_OPTIONS[preset].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
            <option value={CUSTOM_MODEL}>Custom…</option>
          </select>
        )}
        {(modelCustom || MODEL_OPTIONS[preset].length === 0) && (
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="Enter a model name"
            autoComplete="off"
            spellCheck={false}
            className="v2-input"
            style={{
              ...inputStyle,
              marginTop: MODEL_OPTIONS[preset].length > 0 ? 6 : 0,
            }}
          />
        )}
      </Field>

      {preset === "custom" && (
        <Field label="Base URL">
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.example.com/v1"
            autoComplete="off"
            spellCheck={false}
            className="v2-input"
            style={inputStyle}
          />
        </Field>
      )}

      <Field label="API key">
        <input
          ref={keyRef}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={
            keyMatchesProvider
              ? "Leave blank to keep saved key"
              : "Enter an API key for this provider"
          }
          className="v2-input"
          style={inputStyle}
        />
      </Field>

      {error && (
        <div
          style={{
            padding: "7px 8px",
            border: "1px solid var(--er)",
            borderRadius: 4,
            background: "var(--ers)",
            color: "var(--er)",
            fontFamily: "var(--mono)",
            fontSize: 11,
            lineHeight: 1.45,
            overflowWrap: "anywhere",
          }}
          role="alert"
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        {hasKey && (
          <button
            type="button"
            className="v2-btn"
            onClick={closeSettings}
            disabled={savingSettings}
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          className="v2-btn v2-btn-primary"
          disabled={savingSettings}
        >
          {savingSettings ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );

  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          height: 32,
          flex: "none",
          display: "flex",
          alignItems: "center",
          padding: "0 4px 0 12px",
          borderBottom: "1px solid var(--bd)",
        }}
      >
        <span style={{ fontWeight: 500 }}>Assistant</span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="v2-icon-btn"
          onClick={onClose}
          aria-label="Close assistant"
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

      {config === null && !settingsOpen ? (
        <div style={{ padding: 12, color: "var(--mu)" }}>
          Loading AI settings…
        </div>
      ) : settingsOpen || !hasKey ? (
        settingsForm
      ) : (
        <>
          <div
            style={{
              flex: "none",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: 12,
            }}
          >
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={handleQuestionKeyDown}
              rows={3}
              placeholder="Describe the query"
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
              <button
                type="button"
                onClick={() => setIncludeSchema((value) => !value)}
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
                    border: `1px solid ${
                      includeSchema ? "var(--acd)" : "var(--bd2)"
                    }`,
                    borderRadius: 3,
                    background: includeSchema ? "var(--acd)" : "var(--bg)",
                    color: "#fff",
                  }}
                >
                  {includeSchema && (
                    <i className="icon-check" style={{ fontSize: 10 }} />
                  )}
                </span>
                <span>Schema</span>
              </button>
              <span
                style={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: "var(--mono)",
                  fontSize: 10.5,
                  color: "var(--fa)",
                }}
              >
                {includeSchema ? "relevant tables only" : "not sent"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  flex: 1,
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: "var(--fa)",
                }}
              >
                ↵ generate · ⇧↵ newline
              </span>
              <button
                type="button"
                className="v2-btn"
                onClick={() => void handleAsk()}
                disabled={asking || !question.trim()}
              >
                {asking ? "Generating…" : "Generate"}
              </button>
            </div>
          </div>

          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflow: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              padding: "0 12px 12px",
            }}
          >
            {asking && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  paddingTop: 4,
                }}
              >
                <span style={{ color: "var(--mu)" }}>Generating…</span>
                <div
                  style={{
                    height: 8,
                    width: "80%",
                    borderRadius: 2,
                    background: "var(--hv)",
                  }}
                />
                <div
                  style={{
                    height: 8,
                    width: "60%",
                    borderRadius: 2,
                    background: "var(--hv)",
                  }}
                />
              </div>
            )}

            {result && !asking && (
              <>
                <div
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    color: "var(--fa)",
                    lineHeight: 1.45,
                  }}
                >
                  {result.schema_total_tables > 0
                    ? `Schema: ${result.schema_tables.length} of ${result.schema_total_tables} tables with columns · ~${result.schema_tokens} tokens${
                        result.schema_truncated ? " (trimmed)" : ""
                      }`
                    : "Schema not sent"}
                </div>
                {result.sql.trim() ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      border: "1px solid var(--bd)",
                      borderRadius: 4,
                      background: "var(--bg)",
                    }}
                  >
                    <div
                      style={{
                        height: 28,
                        display: "flex",
                        alignItems: "center",
                        gap: 2,
                        padding: "0 4px 0 10px",
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
                      onClick={() => void copySql()}
                      style={{
                        height: 22,
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "0 6px",
                        border: 0,
                        borderRadius: 4,
                        background: "transparent",
                        color: "var(--mu)",
                        fontSize: 12,
                        cursor: "default",
                      }}
                    >
                      <i
                        className={copied ? "icon-check" : "icon-copy"}
                        style={{ fontSize: 12 }}
                      />
                      <span>Copy</span>
                    </button>
                    <button
                      type="button"
                      onClick={useSql}
                      style={{
                        height: 22,
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "0 6px",
                        border: 0,
                        borderRadius: 4,
                        background: "transparent",
                        color: "var(--ac)",
                        fontSize: 12,
                        cursor: "default",
                      }}
                    >
                      <i
                        className="icon-corner-down-left"
                        style={{ fontSize: 12 }}
                      />
                      <span>Use this SQL</span>
                    </button>
                  </div>
                    <pre
                      className="allow-select"
                      style={{
                        margin: 0,
                        padding: "8px 10px",
                        overflow: "auto",
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        lineHeight: "18px",
                      }}
                    >
                      {sqlHighlight(result.sql)}
                    </pre>
                  </div>
                ) : (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      border: "1px solid var(--bd)",
                      borderRadius: 4,
                      background: "var(--bg)",
                    }}
                  >
                    <div
                      style={{
                        height: 28,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "0 10px",
                        borderBottom: "1px solid var(--bd)",
                      }}
                    >
                      <i
                        className="icon-circle-alert"
                        style={{ fontSize: 12, color: "var(--er)" }}
                      />
                      <span
                        style={{
                          fontSize: 10.5,
                          letterSpacing: ".04em",
                          textTransform: "uppercase",
                          color: "var(--fa)",
                        }}
                      >
                        Raw response
                      </span>
                    </div>
                    <div style={{ padding: "8px 10px" }}>
                      <p
                        style={{
                          margin: 0,
                          color: "var(--mu)",
                          fontSize: 12,
                          lineHeight: 1.5,
                          textWrap: "pretty",
                        }}
                      >
                        No SQL could be parsed from the model response. The raw
                        output is below for diagnosis.
                      </p>
                      <details style={{ marginTop: 8 }}>
                        <summary
                          style={{
                            color: "var(--ac)",
                            fontSize: 12,
                            cursor: "default",
                          }}
                        >
                          Show raw model response
                        </summary>
                        <pre
                          className="allow-select"
                          style={{
                            maxHeight: 240,
                            margin: "8px 0 0",
                            padding: "8px 10px",
                            overflow: "auto",
                            border: "1px solid var(--bd)",
                            borderRadius: 4,
                            background: "var(--sf)",
                            color: "var(--tx)",
                            fontFamily: "var(--mono)",
                            fontSize: 11,
                            lineHeight: 1.5,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {result.raw || "(empty response)"}
                        </pre>
                      </details>
                    </div>
                  </div>
                )}

                {result.explanation && (
                  <p
                    style={{
                      margin: 0,
                      color: "var(--mu)",
                      textWrap: "pretty",
                    }}
                  >
                    {result.explanation}
                  </p>
                )}

                {(result.warnings.length > 0 || result.needs_confirmation) && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    {result.needs_confirmation && (
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "baseline",
                        }}
                      >
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
                        <span style={{ fontSize: 12, textWrap: "pretty" }}>
                          Review this statement before running it.
                        </span>
                      </div>
                    )}
                    {result.warnings.map((warning, index) => (
                      <div
                        key={index}
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "baseline",
                        }}
                      >
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
                        <span style={{ fontSize: 12, textWrap: "pretty" }}>
                          {warning}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {error && (
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
                {error}
              </div>
            )}
          </div>

          <div
            style={{
              height: 30,
              flex: "none",
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "0 6px 0 12px",
              borderTop: "1px solid var(--bd)",
              fontSize: 12,
            }}
          >
            <span style={{ color: "var(--fa)" }}>Provider</span>
            <button
              type="button"
              className="df2-quiet"
              onClick={openSettings}
              style={{
                height: 22,
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "0 6px",
                border: 0,
                borderRadius: 4,
                cursor: "default",
              }}
            >
              <span>
                {config ? AI_PRESETS[inferPreset(config)].label : "—"}
              </span>
              <i
                className="icon-chevrons-up-down"
                style={{ fontSize: 11, color: "var(--fa)" }}
              />
            </button>
            <span style={{ color: "var(--fa)", marginLeft: 6 }}>Model</span>
            <button
              type="button"
              className="df2-quiet"
              onClick={openSettings}
              style={{
                height: 22,
                flex: 1,
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "0 6px",
                border: 0,
                borderRadius: 4,
                fontFamily: "var(--mono)",
                fontSize: 11,
                cursor: "default",
                overflow: "hidden",
              }}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {config?.model ?? "—"}
              </span>
              <i
                className="icon-chevrons-up-down"
                style={{ fontSize: 11, color: "var(--fa)" }}
              />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

