import { useEffect, useRef, useState } from "react";
import type { QueryParam, QueryParamType } from "../types";

export interface ParamDraft {
  value: string;
  type: QueryParamType;
}

interface Props {
  names: string[];
  initial: Record<string, ParamDraft>;
  onRun: (params: QueryParam[]) => void;
  onCancel: () => void;
}

const TYPES: QueryParamType[] = ["Text", "Number", "Boolean", "NULL"];

const inputStyle = {
  height: 28,
  border: "1px solid var(--bd2)",
  borderRadius: 4,
  background: "var(--bg)",
  color: "var(--tx)",
  padding: "0 8px",
  fontSize: 12.5,
  minWidth: 0,
};

export default function ParamsDialog({
  names,
  initial,
  onRun,
  onCancel,
}: Props) {
  const [drafts, setDrafts] = useState<Record<string, ParamDraft>>(() => {
    const start: Record<string, ParamDraft> = {};
    for (const name of names) {
      start[name] = initial[name] ?? { value: "", type: "Text" };
    }
    return start;
  });
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const setDraft = (name: string, patch: Partial<ParamDraft>) =>
    setDrafts((current) => ({
      ...current,
      [name]: { ...current[name], ...patch },
    }));

  const submit = () => {
    onRun(
      names.map((name) => {
        const draft = drafts[name];
        return {
          name,
          type: draft.type,
          value: draft.type === "NULL" ? null : draft.value,
        };
      }),
    );
  };

  return (
    <>
      <div
        onMouseDown={onCancel}
        style={{ position: "fixed", inset: 0, zIndex: 70, background: "var(--ov)" }}
      />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        style={{
          position: "fixed",
          left: "50%",
          top: "18%",
          transform: "translateX(-50%)",
          zIndex: 71,
          width: 520,
          maxWidth: "92vw",
          maxHeight: "70vh",
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
            padding: "10px 12px",
            borderBottom: "1px solid var(--bd)",
          }}
        >
          <i
            className="icon-code"
            style={{ fontSize: 14, color: "var(--fa)" }}
          />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Query parameters</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fa)" }}>
            {names.length} value{names.length === 1 ? "" : "s"}
          </span>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "6px 0" }}>
          {names.map((name, index) => {
            const draft = drafts[name];
            return (
              <div
                key={name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 12px",
                }}
              >
                <code
                  title={name}
                  style={{
                    width: 150,
                    flex: "none",
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    color: "var(--tx)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  :{name}
                </code>
                <input
                  ref={index === 0 ? firstRef : undefined}
                  value={draft.type === "NULL" ? "" : draft.value}
                  onChange={(event) => setDraft(name, { value: event.target.value })}
                  disabled={draft.type === "NULL"}
                  placeholder={draft.type === "NULL" ? "NULL" : "Value"}
                  spellCheck={false}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <select
                  value={draft.type}
                  onChange={(event) =>
                    setDraft(name, {
                      type: event.target.value as QueryParamType,
                    })
                  }
                  style={{ ...inputStyle, width: 96, flex: "none" }}
                >
                  {TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>

        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            padding: "9px 12px",
            borderTop: "1px solid var(--bd)",
          }}
        >
          <span style={{ marginRight: "auto", fontSize: 11, color: "var(--fa)" }}>
            Enter runs · Esc cancels
          </span>
          <button type="button" className="v2-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="v2-btn">
            Run
          </button>
        </div>
      </form>
    </>
  );
}
