import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelOperation,
  errorMessage,
  generateRows,
  previewTestData,
  testDataColumns,
} from "../ipc";
import { isProduction, isReadOnly } from "../environment";
import type {
  CellValue,
  ConnectionMeta,
  GenerateProgress,
  GenerateSummary,
  TestDataColumn,
  TestDataColumnConfig,
  TestDataGenerator,
  TestDataGeneratorKind,
  TestDataLocale,
  TestDataPreview,
} from "../types";

interface Props {
  connection: ConnectionMeta;
  database: string;
  table: string;
  onClose: () => void;
  onGenerated: () => void;
}

interface GeneratorOption {
  kind: TestDataGeneratorKind;
  label: string;
}

const GENERATOR_OPTIONS: GeneratorOption[] = [
  { kind: "skip", label: "Skip (use DEFAULT)" },
  { kind: "null", label: "NULL" },
  { kind: "constant", label: "Constant" },
  { kind: "sequence", label: "Sequence" },
  { kind: "int", label: "Random integer" },
  { kind: "decimal", label: "Random decimal" },
  { kind: "boolean", label: "Boolean" },
  { kind: "date", label: "Date / time range" },
  { kind: "time", label: "Time" },
  { kind: "uuid", label: "UUID" },
  { kind: "list", label: "From list" },
  { kind: "regex", label: "Regex-lite pattern" },
  { kind: "lorem_words", label: "Lorem words" },
  { kind: "lorem_sentence", label: "Lorem sentence" },
  { kind: "first_name", label: "First name" },
  { kind: "last_name", label: "Last name" },
  { kind: "full_name", label: "Full name" },
  { kind: "email", label: "Email (unique)" },
  { kind: "phone", label: "Phone" },
  { kind: "city", label: "City" },
  { kind: "street_address", label: "Street address" },
  { kind: "company", label: "Company" },
  { kind: "product_name", label: "Product name" },
  { kind: "price", label: "Price" },
  { kind: "status", label: "Status" },
  { kind: "color", label: "Color" },
  { kind: "url", label: "URL" },
  { kind: "ip", label: "IP address" },
  { kind: "foreign_key", label: "Foreign key" },
];

const LOCALE_KINDS = new Set<TestDataGeneratorKind>([
  "first_name",
  "last_name",
  "full_name",
  "email",
  "phone",
  "city",
  "street_address",
  "company",
  "product_name",
  "url",
]);

const inputStyle = {
  height: 24,
  border: "1px solid var(--bd2)",
  borderRadius: 4,
  background: "var(--bg)",
  color: "var(--tx)",
  fontFamily: "var(--mono)",
  fontSize: 11,
  padding: "0 6px",
};

function parseNumber(text: string): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function generatorDefaults(
  kind: TestDataGeneratorKind,
  locale: TestDataLocale,
  column: TestDataColumn | undefined,
): TestDataGenerator {
  switch (kind) {
    case "constant":
      return { kind, constant: "" };
    case "sequence":
      return { kind, start: 1, step: 1 };
    case "int":
      return { kind, min: 1, max: 10000 };
    case "decimal":
      return { kind, min: 0, max: 1000, precision: 2 };
    case "price":
      return { kind, min: 1, max: 500, precision: 2 };
    case "date":
      return { kind, date_from: "2020-01-01", date_to: "2025-12-31" };
    case "list":
      return { kind, items: ["active", "inactive", "pending"] };
    case "regex":
      return { kind, pattern: "[A-Z]{3}[0-9]{3}" };
    case "lorem_words":
      return { kind, words: 4 };
    case "foreign_key":
      return {
        kind,
        table: column?.foreign_key?.table ?? null,
        column: column?.foreign_key?.column ?? null,
      };
    case "first_name":
    case "last_name":
    case "full_name":
    case "email":
    case "phone":
    case "city":
    case "street_address":
    case "company":
    case "product_name":
    case "url":
      return { kind, locale };
    default:
      return { kind };
  }
}

function formatValue(value: CellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function columnFlags(column: TestDataColumn): string[] {
  const flags: string[] = [];
  if (column.primary_key) flags.push("PK");
  if (column.auto_increment) flags.push("AI");
  if (column.unique) flags.push("UNIQUE");
  if (column.foreign_key) flags.push("FK");
  if (!column.nullable) flags.push("NOT NULL");
  return flags;
}

export default function GenerateTestDataDialog({
  connection,
  database,
  table,
  onClose,
  onGenerated,
}: Props) {
  const [columns, setColumns] = useState<TestDataColumn[]>([]);
  const [configs, setConfigs] = useState<TestDataColumnConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [columnsError, setColumnsError] = useState<string | null>(null);
  const [rowsInput, setRowsInput] = useState("100");
  const [seedInput, setSeedInput] = useState("42");
  const [locale, setLocale] = useState<TestDataLocale>("en");
  const [preview, setPreview] = useState<TestDataPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<GenerateSummary | null>(null);
  const [progress, setProgress] = useState<{
    id: string;
    generated: number;
    total: number;
    cancelRequested: boolean;
  } | null>(null);

  const blockedReason = isReadOnly(connection)
    ? "Test data generation is disabled on read-only connections"
    : isProduction(connection)
      ? "Test data generation is disabled on production connections"
      : null;

  const totalRows = Math.min(
    100_000,
    Math.max(1, Math.round(parseNumber(rowsInput) ?? 100)),
  );
  const seed = Math.max(0, Math.floor(parseNumber(seedInput) ?? 0));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setColumnsError(null);
    testDataColumns(connection.id, database, table)
      .then((items) => {
        if (cancelled) return;
        setColumns(items);
        setConfigs(
          items.map((column) => ({
            name: column.name,
            generator: column.suggested,
            null_percent: 0,
          })),
        );
      })
      .catch((loadError) => {
        if (!cancelled) setColumnsError(errorMessage(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection.id, database, table]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<GenerateProgress>("test_data:progress", (event) => {
      const update = event.payload;
      setProgress((current) =>
        current && current.id === update.id && !update.done
          ? {
              ...current,
              generated: update.generated,
              total: update.total,
            }
          : current,
      );
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (loading || columnsError || blockedReason || busy || configs.length === 0) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setPreviewing(true);
      setPreviewError(null);
      previewTestData({
        connId: connection.id,
        database,
        table,
        rows: totalRows,
        seed,
        locale,
        columns: configs,
      })
        .then((result) => {
          if (!cancelled) setPreview(result);
        })
        .catch((previewFailure) => {
          if (!cancelled) setPreviewError(errorMessage(previewFailure));
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    connection.id,
    database,
    table,
    configs,
    totalRows,
    seed,
    locale,
    previewNonce,
    loading,
    columnsError,
    blockedReason,
    busy,
  ]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const updateConfig = (
    name: string,
    update: (config: TestDataColumnConfig) => TestDataColumnConfig,
  ) => {
    setConfigs((current) =>
      current.map((config) => (config.name === name ? update(config) : config)),
    );
  };

  const changeKind = (name: string, kind: TestDataGeneratorKind) => {
    const column = columns.find((item) => item.name === name);
    updateConfig(name, (config) => ({
      ...config,
      generator: generatorDefaults(kind, locale, column),
    }));
  };

  const changeLocale = (next: TestDataLocale) => {
    setLocale(next);
    setConfigs((current) =>
      current.map((config) =>
        LOCALE_KINDS.has(config.generator.kind)
          ? {
              ...config,
              generator: { ...config.generator, locale: next },
            }
          : config,
      ),
    );
  };

  const updateGenerator = (
    name: string,
    patch: Partial<TestDataGenerator>,
  ) => {
    updateConfig(name, (config) => ({
      ...config,
      generator: { ...config.generator, ...patch },
    }));
  };

  const cancel = async () => {
    if (!progress) return;
    setProgress({ ...progress, cancelRequested: true });
    try {
      await cancelOperation(progress.id);
    } catch {
      // The generation may already have finished.
    }
  };

  const run = async () => {
    if (busy || blockedReason || configs.length === 0) return;
    const id = `generate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setBusy(true);
    setError(null);
    setSummary(null);
    setProgress({
      id,
      generated: 0,
      total: totalRows,
      cancelRequested: false,
    });
    try {
      const result = await generateRows(
        {
          connId: connection.id,
          database,
          table,
          rows: totalRows,
          seed,
          locale,
          columns: configs,
        },
        id,
      );
      setSummary(result);
      if (!result.cancelled) onGenerated();
    } catch (generateError) {
      setError(errorMessage(generateError));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const renderParams = (
    config: TestDataColumnConfig,
    column: TestDataColumn,
  ) => {
    const generator = config.generator;

    switch (generator.kind) {
      case "constant":
        return (
          <input
            value={generator.constant ?? ""}
            onChange={(event) =>
              updateGenerator(config.name, { constant: event.target.value })
            }
            placeholder="value"
            disabled={busy}
            style={{ ...inputStyle, width: 160 }}
          />
        );
      case "sequence":
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="number"
              value={generator.start ?? 1}
              onChange={(event) =>
                updateGenerator(config.name, {
                  start: parseNumber(event.target.value) ?? 1,
                })
              }
              disabled={busy}
              style={{ ...inputStyle, width: 70 }}
              title="Start"
            />
            <span style={{ color: "var(--fa)" }}>+</span>
            <input
              type="number"
              value={generator.step ?? 1}
              onChange={(event) =>
                updateGenerator(config.name, {
                  step: parseNumber(event.target.value) ?? 1,
                })
              }
              disabled={busy}
              style={{ ...inputStyle, width: 60 }}
              title="Step"
            />
          </div>
        );
      case "int":
      case "decimal":
      case "price":
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="number"
              value={generator.min ?? ""}
              onChange={(event) =>
                updateGenerator(config.name, {
                  min: parseNumber(event.target.value),
                })
              }
              placeholder="min"
              disabled={busy}
              style={{ ...inputStyle, width: 75 }}
            />
            <span style={{ color: "var(--fa)" }}>…</span>
            <input
              type="number"
              value={generator.max ?? ""}
              onChange={(event) =>
                updateGenerator(config.name, {
                  max: parseNumber(event.target.value),
                })
              }
              placeholder="max"
              disabled={busy}
              style={{ ...inputStyle, width: 75 }}
            />
            {generator.kind !== "int" && (
              <input
                type="number"
                min={0}
                max={10}
                value={generator.precision ?? 2}
                onChange={(event) =>
                  updateGenerator(config.name, {
                    precision: Math.max(
                      0,
                      Math.min(10, parseNumber(event.target.value) ?? 2),
                    ),
                  })
                }
                disabled={busy}
                style={{ ...inputStyle, width: 48 }}
                title="Precision"
              />
            )}
          </div>
        );
      case "date":
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="date"
              value={generator.date_from ?? ""}
              onChange={(event) =>
                updateGenerator(config.name, {
                  date_from: event.target.value,
                })
              }
              disabled={busy}
              style={{ ...inputStyle, width: 125 }}
            />
            <span style={{ color: "var(--fa)" }}>…</span>
            <input
              type="date"
              value={generator.date_to ?? ""}
              onChange={(event) =>
                updateGenerator(config.name, { date_to: event.target.value })
              }
              disabled={busy}
              style={{ ...inputStyle, width: 125 }}
            />
          </div>
        );
      case "list":
        return (
          <input
            defaultValue={(generator.items ?? []).join(", ")}
            onBlur={(event) =>
              updateGenerator(config.name, {
                items: event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
            placeholder="a, b, c"
            disabled={busy}
            style={{ ...inputStyle, width: 220 }}
          />
        );
      case "regex":
        return (
          <input
            value={generator.pattern ?? ""}
            onChange={(event) =>
              updateGenerator(config.name, { pattern: event.target.value })
            }
            placeholder="[A-Z]{3}[0-9]{3}"
            disabled={busy}
            style={{ ...inputStyle, width: 180 }}
          />
        );
      case "lorem_words":
        return (
          <input
            type="number"
            min={1}
            max={24}
            value={generator.words ?? 4}
            onChange={(event) =>
              updateGenerator(config.name, {
                words: Math.max(
                  1,
                  Math.min(24, parseNumber(event.target.value) ?? 4),
                ),
              })
            }
            disabled={busy}
            style={{ ...inputStyle, width: 60 }}
            title="Word count"
          />
        );
      case "foreign_key":
        return (
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              color: "var(--fa)",
            }}
          >
            {column.foreign_key
              ? `${column.foreign_key.table}.${column.foreign_key.column}`
              : generator.table && generator.column
                ? `${generator.table}.${generator.column}`
                : "no FK target"}
          </span>
        );
      case "first_name":
      case "last_name":
      case "full_name":
      case "email":
      case "phone":
      case "city":
      case "street_address":
      case "company":
      case "product_name":
      case "url":
        return (
          <span style={{ fontSize: 10.5, color: "var(--fa)" }}>
            {locale === "az" ? "Azerbaijani" : "English"} values
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <>
      <div
        onMouseDown={() => !busy && onClose()}
        style={{ position: "fixed", inset: 0, zIndex: 70, background: "var(--ov)" }}
      />
      <div
        style={{
          position: "fixed",
          left: "50%",
          top: "4%",
          transform: "translateX(-50%)",
          zIndex: 71,
          width: 980,
          maxWidth: "96vw",
          maxHeight: "92vh",
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
            padding: "11px 12px",
            borderBottom: "1px solid var(--bd)",
          }}
        >
          <i className="icon-flask-conical" style={{ fontSize: 14, color: "var(--ac)" }} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Generate test data</span>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              color: "var(--fa)",
            }}
          >
            {database}.{table}
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="v2-btn"
            onClick={onClose}
            disabled={busy}
            style={{ height: 22, padding: "0 8px", fontSize: 11 }}
          >
            Close
          </button>
        </div>

        <div
          style={{
            flex: "none",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 14,
            padding: "8px 12px",
            borderBottom: "1px solid var(--bd)",
            fontFamily: "var(--mono)",
            fontSize: 11,
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            Rows
            <input
              type="number"
              min={1}
              max={100_000}
              value={rowsInput}
              onChange={(event) => setRowsInput(event.target.value)}
              disabled={busy}
              style={{ ...inputStyle, width: 90 }}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            Seed
            <input
              type="number"
              min={0}
              value={seedInput}
              onChange={(event) => setSeedInput(event.target.value)}
              disabled={busy}
              style={{ ...inputStyle, width: 110 }}
            />
          </label>
          <button
            type="button"
            className="v2-btn"
            onClick={() =>
              setSeedInput(String(Math.floor(Math.random() * 1_000_000)))
            }
            disabled={busy}
            style={{ height: 22, padding: "0 8px", fontSize: 11 }}
            title="Use a new random seed"
          >
            Random seed
          </button>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            Locale
            <select
              value={locale}
              onChange={(event) =>
                changeLocale(event.target.value as TestDataLocale)
              }
              disabled={busy}
              style={inputStyle}
            >
              <option value="en">EN</option>
              <option value="az">AZ</option>
            </select>
          </label>
          <button
            type="button"
            className="v2-btn"
            onClick={() => setPreviewNonce((value) => value + 1)}
            disabled={busy || previewing}
            style={{ height: 22, padding: "0 8px", fontSize: 11 }}
          >
            Regenerate
          </button>
          <span style={{ color: "var(--fa)" }}>
            {totalRows.toLocaleString("en-US")} rows
          </span>
        </div>

        {blockedReason && (
          <div
            role="alert"
            style={{
              flex: "none",
              margin: "8px 12px 0",
              padding: "7px 8px",
              border: "1px solid var(--er)",
              borderRadius: 4,
              background: "var(--ers)",
              color: "var(--er)",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
            }}
          >
            {blockedReason}
          </div>
        )}

        {(columnsError || error) && (
          <div
            role="alert"
            style={{
              flex: "none",
              margin: "8px 12px 0",
              padding: "7px 8px",
              border: "1px solid var(--er)",
              borderRadius: 4,
              background: "var(--ers)",
              color: "var(--er)",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
            }}
          >
            {columnsError ?? error}
          </div>
        )}

        <div
          style={{
            flex: 1,
            minHeight: 140,
            overflow: "auto",
            margin: "8px 12px 0",
            border: "1px solid var(--bd)",
            borderRadius: 4,
          }}
        >
          {loading ? (
            <div
              style={{
                padding: 12,
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                color: "var(--fa)",
              }}
            >
              Loading columns…
            </div>
          ) : (
            <div style={{ minWidth: 760 }}>
              <div
                style={{
                  position: "sticky",
                  top: 0,
                  zIndex: 1,
                  display: "grid",
                  gridTemplateColumns: "minmax(160px,1.1fr) 130px minmax(170px,1fr) minmax(260px,1.8fr) 80px",
                  gap: 8,
                  padding: "5px 8px",
                  background: "var(--sf2)",
                  borderBottom: "1px solid var(--bd2)",
                  fontFamily: "var(--mono)",
                  fontSize: 10.5,
                  color: "var(--fa)",
                  textTransform: "uppercase",
                  letterSpacing: ".04em",
                }}
              >
                <span>Column</span>
                <span>Type</span>
                <span>Generator</span>
                <span>Options</span>
                <span>NULL %</span>
              </div>
              {columns.map((column) => {
                const config = configs.find((item) => item.name === column.name);
                if (!config) return null;
                const flags = columnFlags(column);
                return (
                  <div
                    key={column.name}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(160px,1.1fr) 130px minmax(170px,1fr) minmax(260px,1.8fr) 80px",
                      gap: 8,
                      alignItems: "center",
                      padding: "4px 8px",
                      borderBottom: "1px solid var(--bd)",
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                        overflow: "hidden",
                      }}
                    >
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          color: "var(--tx)",
                        }}
                        title={column.name}
                      >
                        {column.name}
                      </span>
                      {flags.map((flag) => (
                        <span
                          key={flag}
                          style={{
                            flex: "none",
                            padding: "0 3px",
                            borderRadius: 3,
                            background: "var(--hv)",
                            color: "var(--fa)",
                            fontSize: 9,
                          }}
                        >
                          {flag}
                        </span>
                      ))}
                    </div>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: "var(--mu)",
                      }}
                      title={column.data_type}
                    >
                      {column.data_type}
                    </span>
                    <select
                      value={config.generator.kind}
                      onChange={(event) =>
                        changeKind(
                          config.name,
                          event.target.value as TestDataGeneratorKind,
                        )
                      }
                      disabled={busy}
                      style={{ ...inputStyle, width: "100%" }}
                    >
                      {GENERATOR_OPTIONS.map((option) => (
                        <option key={option.kind} value={option.kind}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <div style={{ minWidth: 0 }}>
                      {renderParams(config, column)}
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={config.null_percent}
                      onChange={(event) =>
                        updateConfig(config.name, (current) => ({
                          ...current,
                          null_percent: Math.max(
                            0,
                            Math.min(
                              100,
                              parseNumber(event.target.value) ?? 0,
                            ),
                          ),
                        }))
                      }
                      disabled={busy || !column.nullable || column.unique}
                      title={
                        !column.nullable
                          ? "NOT NULL columns never get NULL"
                          : column.unique
                            ? "Unique columns do not use NULL%"
                            : "Chance of NULL"
                      }
                      style={{ ...inputStyle, width: 70 }}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div
          style={{
            flex: "none",
            height: 190,
            display: "flex",
            flexDirection: "column",
            margin: "8px 12px 0",
            border: "1px solid var(--bd)",
            borderRadius: 4,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              flex: "none",
              padding: "4px 8px",
              background: "var(--sf2)",
              borderBottom: "1px solid var(--bd2)",
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              color: "var(--fa)",
              textTransform: "uppercase",
              letterSpacing: ".04em",
            }}
          >
            Preview · first {Math.min(totalRows, 10)} generated rows
            {previewing && " · generating…"}
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {previewError ? (
              <div
                style={{
                  padding: 10,
                  color: "var(--er)",
                  fontFamily: "var(--mono)",
                  fontSize: 11.5,
                }}
              >
                {previewError}
              </div>
            ) : preview && preview.rows.length > 0 ? (
              <table
                style={{
                  borderCollapse: "collapse",
                  width: "100%",
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  whiteSpace: "nowrap",
                }}
              >
                <thead>
                  <tr>
                    {preview.columns.map((name) => (
                      <th
                        key={name}
                        style={{
                          position: "sticky",
                          top: 0,
                          padding: "4px 8px",
                          textAlign: "left",
                          background: "var(--sf2)",
                          borderBottom: "1px solid var(--bd2)",
                          color: "var(--tx)",
                          fontWeight: 500,
                        }}
                      >
                        {name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((value, columnIndex) => (
                        <td
                          key={columnIndex}
                          style={{
                            padding: "3px 8px",
                            borderBottom: "1px solid var(--bd)",
                            color:
                              value === null ? "var(--fa)" : "var(--mu)",
                            fontStyle: value === null ? "italic" : "normal",
                          }}
                        >
                          {formatValue(value)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div
                style={{
                  padding: 10,
                  color: "var(--fa)",
                  fontFamily: "var(--mono)",
                  fontSize: 11.5,
                }}
              >
                {blockedReason ? "Preview is disabled." : "No preview yet."}
              </div>
            )}
          </div>
        </div>

        {busy && progress && (
          <div
            role="status"
            style={{
              flex: "none",
              display: "flex",
              alignItems: "center",
              gap: 8,
              margin: "8px 12px 0",
              padding: "7px 8px",
              border: "1px solid var(--bd2)",
              borderRadius: 4,
              background: "var(--bg)",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
            }}
          >
            <i className="icon-flask-conical" style={{ fontSize: 12, color: "var(--ac)" }} />
            <span>
              Generating… {progress.generated.toLocaleString("en-US")} /{" "}
              {progress.total.toLocaleString("en-US")} rows
            </span>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="v2-btn"
              onClick={() => void cancel()}
              disabled={progress.cancelRequested}
              style={{ height: 20, padding: "0 8px", fontSize: 11 }}
            >
              {progress.cancelRequested ? "Cancelling…" : "Cancel"}
            </button>
          </div>
        )}

        {summary && (
          <div
            role="status"
            style={{
              flex: "none",
              margin: "8px 12px 0",
              padding: "8px 9px",
              border: "1px solid var(--bd2)",
              borderRadius: 4,
              background: "var(--bg)",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
            }}
          >
            {summary.cancelled ? (
              <span style={{ color: "var(--wn)" }}>
                Generation cancelled — the transaction was rolled back.
              </span>
            ) : (
              <span style={{ color: "var(--ok)" }}>
                Inserted {summary.inserted.toLocaleString("en-US")} rows.
              </span>
            )}
          </div>
        )}

        <div
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
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
          <button
            type="button"
            className="v2-btn v2-btn-primary"
            onClick={() => void run()}
            disabled={busy || !!blockedReason || configs.length === 0}
          >
            {busy
              ? "Generating…"
              : `Insert ${totalRows.toLocaleString("en-US")} rows`}
          </button>
        </div>
      </div>
    </>
  );
}
