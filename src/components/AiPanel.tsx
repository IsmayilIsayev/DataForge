import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { copyText } from "../clipboard";
import {
  aiGetConfig,
  aiListModels,
  aiNl2Sql,
  aiSetConfig,
  errorMessage,
} from "../ipc";
import { formatSql } from "../sql";
import { useAppStore } from "../store";
import type {
  AiConfig,
  AiModelList,
  AiProvider,
  ChatRequest,
  Nl2SqlResult,
} from "../types";

const AiChatView = lazy(() => import("./AiChatView"));

interface Props {
  onClose: () => void;
  settingsSignal?: number;
  chatRequest?: ChatRequest | null;
  onChatRequestHandled?: () => void;
  onRunSql?: (sql: string) => void;
  uiLanguage?: string;
}

type AiMode = "generate" | "chat";

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
    model: "openai/gpt-oss-120b",
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
  groq: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
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

function withSelectedModel(options: string[], selected: string): string[] {
  const result: string[] = [];
  for (const option of options) {
    if (option.trim() && !result.includes(option)) result.push(option);
  }
  const current = selected.trim();
  if (current && !result.includes(current)) result.unshift(current);
  return result;
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

export default function AiPanel({
  onClose,
  settingsSignal = 0,
  chatRequest = null,
  onChatRequestHandled,
  onRunSql,
  uiLanguage = "en",
}: Props) {
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
  const [mode, setMode] = useState<AiMode>("generate");
  const [liveModels, setLiveModels] = useState<AiModelList | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [modelIndex, setModelIndex] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const modelsRequestRef = useRef(0);

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
    setModelCustom(
      !MODEL_OPTIONS[nextPreset].includes(value.model) &&
        !(liveModels?.models ?? []).includes(value.model),
    );
    setBaseUrl(value.base_url ?? "");
  };

  const loadModels = async (refresh = false) => {
    const requestId = ++modelsRequestRef.current;
    setModelsLoading(true);
    try {
      const value = await aiListModels(refresh);
      if (requestId === modelsRequestRef.current) setLiveModels(value);
    } catch {
      // The command already falls back to the preset list; keep what we have.
    } finally {
      if (requestId === modelsRequestRef.current) setModelsLoading(false);
    }
  };

  const modelsMatchSavedScope =
    !!config &&
    config.provider === provider &&
    (provider !== "openai_compatible" ||
      (config.base_url ?? "").replace(/\/+$/, "") === normalizedBaseUrl);

  const modelOptions = withSelectedModel(
    modelsMatchSavedScope && liveModels
      ? liveModels.models
      : MODEL_OPTIONS[preset],
    modelsMatchSavedScope && config ? config.model : model,
  );

  useEffect(() => {
    let cancelled = false;

    aiGetConfig()
      .then((value) => {
        if (cancelled) return;
        applyConfig(value);
        void loadModels();
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

  const handledSettingsSignal = useRef(settingsSignal);

  useEffect(() => {
    if (settingsSignal !== handledSettingsSignal.current) {
      handledSettingsSignal.current = settingsSignal;
      setSettingsOpen(true);
    }
  }, [settingsSignal]);

  useEffect(() => {
    if (chatRequest) setMode("chat");
  }, [chatRequest]);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [activeConnId]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 1600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (settingsOpen) void loadModels();
  }, [settingsOpen]);

  useEffect(() => {
    if (!modelMenuOpen) return;

    const frame = requestAnimationFrame(() => modelSearchRef.current?.focus());
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        modelMenuRef.current?.contains(target) ||
        modelTriggerRef.current?.contains(target)
      ) {
        return;
      }
      setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [modelMenuOpen]);

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

  const modelQueryText = modelQuery.trim().toLowerCase();
  const filteredModels = modelOptions.filter((option) =>
    option.toLowerCase().includes(modelQueryText),
  );
  const activeModelIndex =
    filteredModels.length === 0
      ? -1
      : Math.min(modelIndex, filteredModels.length - 1);

  const openModelMenu = () => {
    setModelQuery("");
    setModelIndex(0);
    setModelMenuOpen((open) => !open);
    void loadModels(false);
  };

  const closeModelMenu = (focusTrigger = false) => {
    setModelMenuOpen(false);
    if (focusTrigger) {
      requestAnimationFrame(() => modelTriggerRef.current?.focus());
    }
  };

  const chooseModel = async (nextModel: string) => {
    if (!config) return;
    if (nextModel === config.model) {
      closeModelMenu();
      return;
    }

    try {
      const value = await aiSetConfig(
        config.provider,
        nextModel,
        config.base_url ?? undefined,
        undefined,
      );
      applyConfig(value);
      setToast(`Model set to ${value.model}`);
      closeModelMenu();
    } catch (selectionError) {
      setToast(errorMessage(selectionError));
    }
  };

  const handleModelMenuKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filteredModels.length === 0) return;
      setModelIndex(Math.min(activeModelIndex + 1, filteredModels.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setModelIndex(Math.max(activeModelIndex - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = filteredModels[activeModelIndex] ?? filteredModels[0];
      if (option) void chooseModel(option);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeModelMenu(true);
    }
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
        {modelOptions.length > 0 && (
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
            {modelOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
            <option value={CUSTOM_MODEL}>Custom…</option>
          </select>
        )}
        {(modelCustom || modelOptions.length === 0) && (
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="Enter a model name"
            autoComplete="off"
            spellCheck={false}
            className="v2-input"
            style={{
              ...inputStyle,
              marginTop: modelOptions.length > 0 ? 6 : 0,
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
        position: "relative",
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
              height: 30,
              flex: "none",
              display: "flex",
              alignItems: "stretch",
              gap: 2,
              padding: "0 6px",
              borderBottom: "1px solid var(--bd)",
            }}
          >
            {(
              [
                ["generate", "Generate SQL"],
                ["chat", "Chat"],
              ] as const
            ).map(([id, label]) => {
              const active = mode === id;
              return (
                <button
                  key={id}
                  type="button"
                  className="df2-quiet df2-hover-tx"
                  onClick={() => setMode(id)}
                  style={{
                    height: 30,
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "0 8px",
                    border: 0,
                    borderBottom: `2px solid ${
                      active ? "var(--ac)" : "transparent"
                    }`,
                    borderRadius: 0,
                    background: "transparent",
                    color: active ? "var(--tx)" : "var(--mu)",
                    cursor: "default",
                    fontSize: 11.5,
                  }}
                >
                  <i
                    className={id === "chat" ? "icon-message-circle" : "icon-code"}
                    style={{ fontSize: 12 }}
                  />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>

          {mode === "generate" ? (
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
              }}
            >
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
            </div>
          ) : (
            <Suspense
              fallback={
                <div style={{ padding: 12, color: "var(--mu)" }}>
                  Loading chat…
                </div>
              }
            >
              <AiChatView
                connId={activeConnId}
                database={activeDb}
                isConnected={isConnected}
                hasKey={hasKey}
                uiLanguage={uiLanguage}
                onConfigure={() => {
                  setError(null);
                  setSettingsOpen(true);
                }}
                onInsertSql={(sql) =>
                  setSql(formatSql(sql, activeDialect))
                }
                onRunSql={onRunSql}
                request={chatRequest}
                onRequestHandled={onChatRequestHandled}
              />
            </Suspense>
          )}

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
            <div
              style={{
                position: "relative",
                flex: 1,
                minWidth: 0,
                display: "flex",
              }}
            >
              <button
                ref={modelTriggerRef}
                type="button"
                className="df2-quiet"
                onClick={openModelMenu}
                aria-haspopup="listbox"
                aria-expanded={modelMenuOpen}
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

              {modelMenuOpen && config && (
                <div
                  ref={modelMenuRef}
                  role="dialog"
                  aria-label="Choose a model"
                  style={{
                    position: "absolute",
                    left: 0,
                    bottom: "calc(100% + 5px)",
                    zIndex: 30,
                    width: 280,
                    maxWidth: "calc(100vw - 24px)",
                    background: "var(--sf)",
                    border: "1px solid var(--bd2)",
                    borderRadius: 6,
                    boxShadow: "var(--sh)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      padding: 6,
                      borderBottom: "1px solid var(--bd)",
                    }}
                  >
                    <input
                      ref={modelSearchRef}
                      value={modelQuery}
                      onChange={(event) => {
                        setModelQuery(event.target.value);
                        setModelIndex(0);
                      }}
                      onKeyDown={handleModelMenuKeyDown}
                      placeholder="Filter models"
                      autoComplete="off"
                      spellCheck={false}
                      className="v2-input"
                      style={{ ...inputStyle, height: 26, fontSize: 12 }}
                    />
                  </div>
                  <div
                    role="listbox"
                    aria-label="Models"
                    style={{ maxHeight: 220, overflow: "auto", padding: 4 }}
                  >
                    {filteredModels.length === 0 ? (
                      <div
                        style={{
                          padding: "6px 8px",
                          color: "var(--mu)",
                          fontSize: 11.5,
                        }}
                      >
                        No matching models
                      </div>
                    ) : (
                      filteredModels.map((option, index) => {
                        const selected = option === config.model;
                        const active = index === activeModelIndex;
                        return (
                          <button
                            key={option}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className="df2-quiet"
                            onMouseEnter={() => setModelIndex(index)}
                            onClick={() => void chooseModel(option)}
                            style={{
                              width: "100%",
                              height: 26,
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              padding: "0 6px",
                              border: 0,
                              borderRadius: 4,
                              background: active
                                ? "var(--sel)"
                                : "transparent",
                              color: "var(--tx)",
                              fontSize: 11.5,
                              textAlign: "left",
                              cursor: "default",
                            }}
                          >
                            <span
                              style={{
                                width: 14,
                                flex: "none",
                                display: "flex",
                              }}
                            >
                              {selected && (
                                <i
                                  className="icon-check"
                                  style={{ fontSize: 11, color: "var(--ac)" }}
                                />
                              )}
                            </span>
                            <span
                              style={{
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {option}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                  <div
                    style={{
                      borderTop: "1px solid var(--bd)",
                      padding: 4,
                    }}
                  >
                    <button
                      type="button"
                      className="df2-quiet"
                      onClick={() => void loadModels(true)}
                      disabled={modelsLoading}
                      style={{
                        width: "100%",
                        height: 26,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "0 6px",
                        border: 0,
                        borderRadius: 4,
                        color: "var(--mu)",
                        fontSize: 11.5,
                        cursor: "default",
                        opacity: modelsLoading ? 0.6 : 1,
                      }}
                    >
                      <i
                        className="icon-refresh-cw"
                        style={{ fontSize: 11 }}
                      />
                      <span>{modelsLoading ? "Refreshing…" : "Refresh"}</span>
                    </button>
                    <button
                      type="button"
                      className="df2-quiet"
                      onClick={() => {
                        closeModelMenu();
                        openSettings();
                      }}
                      style={{
                        width: "100%",
                        height: 26,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "0 6px",
                        border: 0,
                        borderRadius: 4,
                        color: "var(--mu)",
                        fontSize: 11.5,
                        cursor: "default",
                      }}
                    >
                      <i className="icon-settings" style={{ fontSize: 11 }} />
                      <span>Settings…</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {toast && (
        <div
          role="status"
          style={{
            position: "absolute",
            left: "50%",
            bottom: 38,
            transform: "translateX(-50%)",
            zIndex: 40,
            maxWidth: "calc(100% - 24px)",
            padding: "5px 10px",
            border: "1px solid var(--bd2)",
            borderRadius: 4,
            background: "var(--sf2)",
            boxShadow: "var(--sh)",
            color: "var(--tx)",
            fontSize: 11.5,
            lineHeight: 1.4,
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

