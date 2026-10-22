// Bundle Monaco instead of loading it from cdn.jsdelivr.net, so the production CSP needs no remote script host.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// Only SQL is edited here; it needs no language worker beyond the base editor worker.
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

loader.config({ monaco });
