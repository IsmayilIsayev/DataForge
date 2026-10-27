import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import Editor from "@monaco-editor/react";
import type { Monaco, OnMount } from "@monaco-editor/react";
import type * as MonacoTypes from "monaco-editor";
import { useAppStore } from "../store";
import {
  analyzeCompletion,
  baseTableName,
  buildSuggestions,
  isColumnContext,
  statementAtCursor,
} from "../sqlComplete";
import type { CompletionSchema } from "../sqlComplete";
import {
  cachedColumns,
  cachedTables,
  ensureColumns,
  ensureTables,
} from "../sqlSchemaCache";
import type { AiTextTarget } from "../types";

export interface SqlEditorHandle {
  getAiTarget: () => AiTextTarget | null;
  applyTarget: (target: AiTextTarget, replacement: string) => void;
  replaceStatement: (original: string, replacement: string) => boolean;
}

interface Props {
  onRun: (sqlOverride?: string) => void;
  theme: "dark" | "light";
}

type MonacoEditorInstance = Parameters<OnMount>[0];

function targetFromEditor(editor: MonacoEditorInstance): AiTextTarget | null {
  const model = editor.getModel();
  if (!model) return null;

  const selection = editor.getSelection();
  if (selection && !selection.isEmpty()) {
    const sql = model.getValueInRange(selection);
    if (!sql.trim()) return null;
    return {
      sql,
      start: model.getOffsetAt(selection.getStartPosition()),
      end: model.getOffsetAt(selection.getEndPosition()),
    };
  }

  const position = editor.getPosition();
  const offset = position
    ? model.getOffsetAt(position)
    : model.getValueLength();
  const statement = statementAtCursor(model.getValue(), offset);
  if (!statement.text.trim()) return null;
  return {
    sql: statement.text,
    start: statement.start,
    end: statement.end,
  };
}

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
const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(
  { onRun, theme },
  ref,
) {
  const sql = useAppStore((state) => state.sql);
  const setSql = useAppStore((state) => state.setSql);
  const setSelection = useAppStore((state) => state.setSelection);
  const activeConnId = useAppStore((state) => state.activeConnId);
  const activeDb = useAppStore((state) => state.activeDb);
  const connections = useAppStore((state) => state.connections);
  const connected = useAppStore((state) => state.connected);

  const activeConnection =
    connections.find((connection) => connection.id === activeConnId) ?? null;
  const dialect = activeConnection?.dialect ?? "mysql";
  const schemaConnected = activeConnId ? !!connected[activeConnId] : false;

  const editorRef = useRef<MonacoEditorInstance | null>(null);
  const selectionSubRef = useRef<{ dispose: () => void } | null>(null);
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  const completionContextRef = useRef({
    connId: activeConnId,
    database: activeDb,
    dialect,
    connected: schemaConnected,
  });
  completionContextRef.current = {
    connId: activeConnId,
    database: activeDb,
    dialect,
    connected: schemaConnected,
  };

  const [monacoApi, setMonacoApi] = useState<Monaco | null>(null);

  useEffect(
    () => () => {
      selectionSubRef.current?.dispose();
    },
    [],
  );

  useEffect(() => {
    if (!activeConnId || !activeDb || !schemaConnected) return;
    void ensureTables(activeConnId, activeDb);
  }, [activeConnId, activeDb, schemaConnected]);

  useEffect(() => {
    if (!monacoApi) return;

    const disposable = monacoApi.languages.registerCompletionItemProvider(
      "sql",
      {
        triggerCharacters: [".", " "],
        provideCompletionItems(
          model: MonacoTypes.editor.ITextModel,
          position: MonacoTypes.Position,
        ) {
          const context = completionContextRef.current;
          const analysis = analyzeCompletion(
            model.getValue(),
            model.getOffsetAt(position),
          );
          const word = model.getWordUntilPosition(position);
          const range = new monacoApi.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn,
          );

          const snapshot = (): CompletionSchema => {
            const schema: CompletionSchema = { tables: [], columns: {} };
            if (!context.connId || !context.database || !context.connected) {
              return schema;
            }
            schema.tables =
              cachedTables(context.connId, context.database) ?? [];
            const tables =
              analysis.context === "dot"
                ? analysis.qualifierTable
                  ? [analysis.qualifierTable]
                  : []
                : isColumnContext(analysis.context)
                  ? analysis.referencedTables
                  : [];
            for (const table of tables) {
              const columns = cachedColumns(
                context.connId,
                context.database,
                table,
              );
              if (columns) {
                schema.columns[baseTableName(table).toLowerCase()] = columns;
              }
            }
            return schema;
          };

          const finish = () => {
            const kind = {
              keyword: monacoApi.languages.CompletionItemKind.Keyword,
              template: monacoApi.languages.CompletionItemKind.Snippet,
              table: monacoApi.languages.CompletionItemKind.Struct,
              column: monacoApi.languages.CompletionItemKind.Field,
              starFrom: monacoApi.languages.CompletionItemKind.Snippet,
            } as const;

            const suggestions = buildSuggestions({
              analysis,
              dialect: context.dialect,
              schema: snapshot(),
              prefix: word.word,
            }).map((suggestion) => ({
              label: suggestion.label,
              kind: kind[suggestion.kind],
              insertText: suggestion.insertText,
              detail: suggestion.detail,
              filterText: suggestion.label,
              sortText: suggestion.sortText,
              range,
              ...(suggestion.snippet
                ? {
                    insertTextRules:
                      monacoApi.languages.CompletionItemInsertTextRule
                        .InsertAsSnippet,
                  }
                : {}),
            }));

            return { suggestions };
          };

          if (!context.connId || !context.database || !context.connected) {
            return finish();
          }

          if (analysis.context === "table") {
            if (cachedTables(context.connId, context.database) === null) {
              return ensureTables(context.connId, context.database).then(
                finish,
              );
            }
            return finish();
          }

          if (analysis.context === "dot" && analysis.qualifierTable) {
            if (
              cachedColumns(
                context.connId,
                context.database,
                analysis.qualifierTable,
              ) === null
            ) {
              return ensureColumns(
                context.connId,
                context.database,
                analysis.qualifierTable,
              ).then(finish);
            }
            return finish();
          }

          // Column contexts never wait on IPC: cached columns appear now and a
          // missing table is fetched once, then shown on the next keystroke.
          if (isColumnContext(analysis.context)) {
            for (const table of analysis.referencedTables) {
              if (
                cachedColumns(context.connId, context.database, table) === null
              ) {
                void ensureColumns(context.connId, context.database, table);
              }
            }
          }

          return finish();
        },
      },
    );

    return () => disposable.dispose();
  }, [monacoApi]);

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

  const applyTarget = (target: AiTextTarget, replacement: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;

    const length = model.getValueLength();
    const startOffset = Math.max(0, Math.min(target.start, length));
    const endOffset = Math.max(startOffset, Math.min(target.end, length));
    const start = model.getPositionAt(startOffset);
    const end = model.getPositionAt(endOffset);

    editor.pushUndoStop();
    editor.executeEdits("ai", [
      {
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        },
        text: replacement,
        forceMoveMarkers: true,
      },
    ]);
    editor.pushUndoStop();
    editor.focus();
  };

  const replaceStatement = (
    original: string,
    replacement: string,
  ): boolean => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return false;

    const needle = original.trim();
    if (!needle) return false;

    const selection = editor.getSelection();
    if (
      selection &&
      !selection.isEmpty() &&
      model.getValueInRange(selection).trim() === needle
    ) {
      applyTarget(
        {
          sql: needle,
          start: model.getOffsetAt(selection.getStartPosition()),
          end: model.getOffsetAt(selection.getEndPosition()),
        },
        replacement,
      );
      return true;
    }

    const index = model.getValue().indexOf(needle);
    if (index < 0) return false;
    applyTarget(
      { sql: needle, start: index, end: index + needle.length },
      replacement,
    );
    return true;
  };

  useImperativeHandle(ref, () => ({
    getAiTarget: () => {
      const editor = editorRef.current;
      return editor ? targetFromEditor(editor) : null;
    },
    applyTarget,
    replaceStatement,
  }));

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    setMonacoApi(monaco);
    // Monaco measures glyph widths once; if JetBrains Mono arrives later the caret drifts into the text.
    const remeasure = () => monaco.editor.remeasureFonts();
    document.fonts.load('13px "JetBrains Mono"').then(remeasure, () => {});
    document.fonts.addEventListener("loadingdone", remeasure);
    editor.onDidDispose(() => document.fonts.removeEventListener("loadingdone", remeasure));
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
});

export default SqlEditor;
