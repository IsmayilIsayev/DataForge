// Bundle Monaco instead of loading it from cdn.jsdelivr.net, so the production CSP needs no remote script host.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/languages/definitions/sql/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/folding/register";
import "monaco-editor/features/suggest/register";
import "monaco-editor/features/bracketMatching/register";
import "monaco-editor/features/multicursor/register";
import "monaco-editor/features/contextmenu/register";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/comment/register";
import "monaco-editor/features/linesOperations/register";
import "monaco-editor/features/snippet/register";
import "monaco-editor/features/wordHighlighter/register";
import "monaco-editor/features/wordOperations/register";
import "monaco-editor/features/cursorUndo/register";
import "monaco-editor/features/gotoLine/register";
import "monaco-editor/features/hover/register";
import editorWorker from "monaco-editor/editor/editor.worker?worker";

// Only SQL is edited here; it needs no language worker beyond the base editor worker.
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

loader.config({ monaco });
