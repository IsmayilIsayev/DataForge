import { useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import type { Monaco, OnMount } from "@monaco-editor/react";
import { useAppStore } from "../store";

interface Props {
  onRun: (sqlOverride?: string) => void;
  theme: "dark" | "light";
}

type MonacoEditorInstance = Parameters<OnMount>[0];

const DARK = {
  bg: "#0f1115",
  fg: "#dfe3e8",
  line: "#5c636d",
  lineActive: "#8b929c",
  cursor: "#dfe3e8",
  selection: "#26374f",
  selectionInactive: "#1c2736",
  lineHighlight: "#15181d",
  indent: "#24282f",
  indentActive: "#2f343c",
  widget: "#15181d",
  widgetBorder: "#2f343c",
  widgetSelected: "#1a1e24",
  keyword: "a8a4c4",
  string: "7fb3ab",
  number: "88a6d4",
  comment: "5c636d",
  operator: "8b929c",
  function: "c3c8cf",
};

const LIGHT = {
  bg: "#ffffff",
  fg: "#1a1d21",
  line: "#8a9099",
  lineActive: "#616770",
  cursor: "#1a1d21",
  selection: "#d8e6fb",
  selectionInactive: "#edf3fc",
  lineHighlight: "#fbfbfc",
  indent: "#e6e8ec",
  indentActive: "#d7dade",
  widget: "#fbfbfc",
  widgetBorder: "#d7dade",
  widgetSelected: "#f4f5f7",
  keyword: "62589e",
  string: "2c7a70",
  number: "3767ad",
  comment: "8a9099",
  operator: "616770",
  function: "3a3f46",
};
export default function SqlEditor({ onRun, theme }: Props) {
  const sql = useAppStore((state) => state.sql);
  const setSql = useAppStore((state) => state.setSql);
  const setSelection = useAppStore((state) => state.setSelection);

  const editorRef = useRef<MonacoEditorInstance | null>(null);
  const selectionSubRef = useRef<{ dispose: () => void } | null>(null);
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  useEffect(
    () => () => {
      selectionSubRef.current?.dispose();
    },
    [],
  );

  const executeRun = () => {
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    const model = editor?.getModel();

    if (selection && model && !selection.isEmpty()) {
      const selected = model.getValueInRange(selection);
      setSelection(selected);
      onRunRef.current(selected);
    } else {
      setSelection(null);
      onRunRef.current();
    }
  };

  const executeRunRef = useRef(executeRun);
  executeRunRef.current = executeRun;

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
      () => executeRunRef.current(),
    );

    selectionSubRef.current?.dispose();
    selectionSubRef.current = editor.onDidChangeCursorSelection(() => {
      const selection = editor.getSelection();
      const model = editor.getModel();
      setSelection(
        selection && model && !selection.isEmpty()
          ? model.getValueInRange(selection)
          : null,
      );
    });
    setSelection(null);
    editor.focus();
  };

  const defineTheme = (
    monaco: Monaco,
    name: string,
    palette: typeof DARK,
    base: "vs" | "vs-dark",
  ) => {
    monaco.editor.defineTheme(name, {
      base,
      inherit: true,
      rules: [
        { token: "keyword", foreground: palette.keyword },
        { token: "string", foreground: palette.string },
        { token: "number", foreground: palette.number },
        { token: "comment", foreground: palette.comment, fontStyle: "italic" },
        { token: "operator", foreground: palette.operator },
        { token: "predefined", foreground: palette.function },
        { token: "function", foreground: palette.function },
        { token: "type", foreground: palette.keyword },
      ],
      colors: {
        "editor.background": palette.bg,
        "editor.foreground": palette.fg,
        "editorLineNumber.foreground": palette.line,
        "editorLineNumber.activeForeground": palette.lineActive,
        "editorCursor.foreground": palette.cursor,
        "editor.selectionBackground": palette.selection,
        "editor.inactiveSelectionBackground": palette.selectionInactive,
        "editor.lineHighlightBackground": palette.lineHighlight,
        "editorIndentGuide.background1": palette.indent,
        "editorIndentGuide.activeBackground1": palette.indentActive,
        "editorGutter.background": palette.bg,
        "editorWidget.background": palette.widget,
        "editorWidget.border": palette.widgetBorder,
        "editorSuggestWidget.background": palette.widget,
        "editorSuggestWidget.border": palette.widgetBorder,
        "editorSuggestWidget.selectedBackground": palette.widgetSelected,
        "editorHoverWidget.background": palette.widget,
        "editorHoverWidget.border": palette.widgetBorder,
        "scrollbarSlider.background": palette.widgetBorder,
        "scrollbarSlider.hoverBackground": palette.lineActive,
        "scrollbarSlider.activeBackground": palette.fg,
      },
    });
  };

  const handleBeforeMount = (monaco: Monaco) => {
    defineTheme(monaco, "dataforge-dark", DARK, "vs-dark");
    defineTheme(monaco, "dataforge-light", LIGHT, "vs");
  };

  return (
    <div style={{ height: "100%", width: "100%", overflow: "hidden" }}>
      <Editor
        height="100%"
        language="sql"
        theme={`dataforge-${theme}`}
        value={sql}
        onChange={(value) => setSql(value ?? "")}
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        loading={<div className="editor-loading">Loading Monaco editor...</div>}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineHeight: 20,
          fontFamily:
            '"JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace',
          automaticLayout: true,
          scrollBeyondLastLine: false,
          wordWrap: "off",
          padding: { top: 8, bottom: 8 },
          renderLineHighlight: "none",
          lineNumbersMinChars: 3,
          glyphMargin: false,
          folding: false,
          smoothScrolling: true,
          tabSize: 2,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
          },
        }}
      />
    </div>
  );
}

