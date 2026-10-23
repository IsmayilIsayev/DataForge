import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import lockupOnLight from "../assets/lockup.png";
import lockupOnDark from "../assets/lockup-light.png";
import { copyText } from "../clipboard";
import {
  applyChanges,
  cancelOperation,
  deleteRows as deleteRowsIpc,
  errorMessage,
  exportResult,
  exportTable,
  previewChanges,
  updateCell,
} from "../ipc";
import type {
  CellRef,
  ChangeInput,
  ExportFormat,
  TransferProgress,
} from "../ipc";
import {
  buildOrderBy,
  buildWhere,
  FILTER_OPERATORS,
  filterNeedsValue,
  describeFilter,
  rowMatchesFilters,
} from "../gridFilter";
import type { ColumnFilter, FilterOperator } from "../gridFilter";
import { quoteIdentifier, sqliteBooleanLiteral } from "../sql";
import { isProduction } from "../environment";
import { guardSqlExecution, readOnlyWriteError } from "../prodGuard";
import { useAppStore } from "../store";
import type { PendingChange } from "../store";
import type { CellValue, Dialect } from "../types";

const INDEX_WIDTH = 44;
const DEFAULT_COL_WIDTH = 160;
const MIN_COL_WIDTH = 56;
const ROW_HEIGHT = 22;
const LONG_TEXT_LENGTH = 60;
const MIN_VIEWER_WIDTH = 280;
const MIN_VIEWER_HEIGHT = 120;
const VIEWER_MAX_RATIO = 0.7;
const VIEWER_RESIZE_STEP = 16;

interface Props {
  viewKey: string;
  tabId?: string;
  dialect: Dialect;
  database?: string | null;
  table?: string | null;
  sql?: string;
  emptyText?: string;
  theme: "dark" | "light";
  connId?: string;
  editable?: boolean;
  pkColumns?: string[];
  serverSide?: boolean;
  where?: string;
  onServerQuery?: (where: string, orderBy: string) => void;
  onReload?: () => void;
}

interface Position {
  row: number;
  col: number;
}

interface ViewerState extends Position {}

interface GridMenu {
  x: number;
  y: number;
}

interface HeaderMenu extends GridMenu {
  column: number;
}

interface FilterMenu extends GridMenu {
  column: number;
}

type CopyFormat = "tsv" | "headers" | "csv" | "json" | "insert";

function displayValue(value: CellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function rawValue(value: CellValue): string {
  if (value === null) return "NULL";
  return displayValue(value);
}

// Preserve string values exactly: 64-bit PKs arrive as JSON strings to avoid
// precision loss, and must not be round-tripped through a JS number.
function pkValue(value: CellValue): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

function cellType(value: CellValue): string {
  if (value === null) return "null";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        JSON.parse(trimmed);
        return "json";
      } catch {
        return "text";
      }
    }
  }
  return "text";
}

const EMPTY_FILTERS: ColumnFilter[] = [];
const EMPTY_PENDING: PendingChange[] = [];

function toChangeInput(change: PendingChange): ChangeInput {
  if (change.kind === "update") {
    return {
      kind: "update",
      pk: change.pk,
      column: change.column,
      value: change.value,
    };
  }
  if (change.kind === "delete") {
    return { kind: "delete", pk: change.pk };
  }
  return { kind: "insert", values: change.values };
}

const MONO_FONT =
  '12px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
let measureContext: CanvasRenderingContext2D | null | undefined;

function measureText(text: string): number {
  if (measureContext === undefined) {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  if (!measureContext) return text.length * 7;
  measureContext.font = MONO_FONT;
  return measureContext.measureText(text).width;
}

// Long values are easier to read in the viewer panel than in the grid cell.
// "Wider than the column" is measured with the grid's 12px mono font plus the
// 8px padding on each side.
function isLongValue(value: CellValue, columnWidth: number): boolean {
  if (typeof value !== "string") return false;
  if (value.length > LONG_TEXT_LENGTH) return true;
  if (/[\r\n]/.test(value)) return true;
  if (cellType(value) === "json") return true;
  return measureText(value) + 16 > columnWidth;
}

function prettyValue(value: CellValue, pretty: boolean): string {
  if (value === null) return "NULL";
  const text = displayValue(value);
  if (!pretty || typeof value !== "string") return text;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

function csvCell(value: CellValue): string {
  if (value === null) return "";
  const raw = displayValue(value);
  // Only text can carry a spreadsheet formula; numbers like -5 stay numeric.
  const text = typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function tsvCell(value: CellValue): string {
  return value === null ? "" : displayValue(value);
}

function jsonCell(value: CellValue): string | number | boolean | null {
  if (value === null) return null;
  return value;
}

function insertCell(value: CellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${value.replace(/'/g, "''")}'`;
}

function tableRef(
  dialect: Dialect,
  database: string | null | undefined,
  table: string,
) {
  const quotedTable = quoteIdentifier(dialect, table);
  if (!database) return quotedTable;
  if (dialect === "mssql") {
    return `${quoteIdentifier(dialect, database)}.${quoteIdentifier(
      dialect,
      "dbo",
    )}.${quotedTable}`;
  }
  return `${quoteIdentifier(dialect, database)}.${quotedTable}`;
}

function tableFromSql(sql: string | undefined): {
  database?: string;
  table?: string;
} {
  if (!sql) return {};
  const match = sql.match(
    /\b(?:from|into|update)\s+([`"[\]\w$]+(?:\.[`"[\]\w$]+)*)/i,
  );
  if (!match) return {};
  const parts = match[1]
    .split(".")
    .map((part) => part.replace(/^[`"[]|[`"\]]$/g, ""));
  if (parts.length >= 2) {
    return {
      database: parts[parts.length - 2],
      table: parts[parts.length - 1],
    };
  }
  return { table: parts[0] };
}

function normalizeRange(a: Position, b: Position) {
  return {
    top: Math.min(a.row, b.row),
    bottom: Math.max(a.row, b.row),
    left: Math.min(a.col, b.col),
    right: Math.max(a.col, b.col),
  };
}

function operationId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function DataGrid({
  viewKey,
  tabId,
  dialect,
  database,
  table,
  sql,
  emptyText,
  theme,
  connId,
  editable,
  pkColumns,
  serverSide,
  where,
  onServerQuery,
  onReload,
}: Props) {
  const result = useAppStore((state) => state.result);
  const running = useAppStore((state) => state.running);
  const error = useAppStore((state) => state.error);
  const setResult = useAppStore((state) => state.setResult);
  const setError = useAppStore((state) => state.setError);
  const viewerPrefs = useAppStore((state) => state.viewerPrefs);
  const setViewerPref = useAppStore((state) => state.setViewerPref);
  const autoCommitEdits = useAppStore((state) => state.autoCommitEdits);
  const connection = useAppStore((state) =>
    state.connections.find((item) => item.id === connId),
  );
  const effectiveAutoCommit =
    autoCommitEdits && connection?.environment !== "prod";
  const storedPending = useAppStore((state) =>
    tabId ? state.pendingChanges[tabId] : undefined,
  );
  const pendingChanges = storedPending ?? EMPTY_PENDING;
  const addPendingChange = useAppStore((state) => state.addPendingChange);
  const undoPendingChange = useAppStore((state) => state.undoPendingChange);
  const clearPendingChanges = useAppStore(
    (state) => state.clearPendingChanges,
  );
  const [editing, setEditing] = useState<Position | null>(null);
  const [editText, setEditText] = useState("");
  const [savingChanges, setSavingChanges] = useState(false);
  const [failedChangeId, setFailedChangeId] = useState<string | null>(null);
  const [previewSql, setPreviewSql] = useState<string[] | null>(null);

  const gridRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const [anchor, setAnchor] = useState<Position | null>(null);
  const [focus, setFocus] = useState<Position | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(
    null,
  );
  const storedFilters = useAppStore((state) =>
    tabId ? state.clientFilters[tabId] : undefined,
  );
  const setClientFilters = useAppStore((state) => state.setClientFilters);
  const [localFilters, setLocalFilters] = useState<ColumnFilter[]>([]);
  const filters = tabId
    ? (storedFilters ?? EMPTY_FILTERS)
    : localFilters;
  const [hoverHeader, setHoverHeader] = useState<number | null>(null);
  const [headerMenu, setHeaderMenu] = useState<HeaderMenu | null>(null);
  const [filterMenu, setFilterMenu] = useState<FilterMenu | null>(null);
  const [draftOp, setDraftOp] = useState<FilterOperator>("contains");
  const [draftValue, setDraftValue] = useState("");
  const [order, setOrder] = useState<number[]>([]);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [dragCol, setDragCol] = useState<number | null>(null);
  const [overCol, setOverCol] = useState<number | null>(null);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [viewerSize, setViewerSize] = useState(() =>
    viewerPrefs.dock === "right"
      ? viewerPrefs.rightWidth
      : viewerPrefs.bottomHeight,
  );
  const [wrap, setWrap] = useState(true);
  const [pretty, setPretty] = useState(true);
  const [gridMenu, setGridMenu] = useState<GridMenu | null>(null);
  const [exportMenu, setExportMenu] = useState<GridMenu | null>(null);
  const [exporting, setExporting] = useState<{
    id: string;
    rows: number;
    cancelRequested: boolean;
  } | null>(null);
  const exportIdRef = useRef<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const columns = result?.columns.length ?? 0;
    setOrder(Array.from({ length: columns }, (_, index) => index));
    setWidths({});
    if (!serverSide) {
      setSort(null);
    }
    setAnchor(null);
    setFocus(null);
    setViewer(null);
    setGridMenu(null);
    setExportMenu(null);
    setHeaderMenu(null);
    setFilterMenu(null);
    setCopied(null);
    setDragging(false);
    setConfirmDelete(null);
    setFailedChangeId(null);
    setPreviewSql(null);
  }, [viewKey, serverSide]);

  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(false);
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, [dragging]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<TransferProgress>("export:progress", (event) => {
      const progress = event.payload;
      if (progress.id !== exportIdRef.current) return;
      if (progress.done) {
        exportIdRef.current = null;
        setExporting(null);
        setCopied(
          progress.cancelled
            ? "Export cancelled"
            : `Exported ${(progress.rows ?? 0).toLocaleString("en-US")} rows`,
        );
      } else {
        setExporting((current) =>
          current && current.id === progress.id
            ? { ...current, rows: progress.rows ?? current.rows }
            : current,
        );
      }
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // Only available inside Tauri.
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!tabId || pendingChanges.length === 0) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void savePendingChanges();
      } else if (key === "z" && !editing) {
        event.preventDefault();
        undoPendingChange(tabId);
        setFailedChangeId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tabId, pendingChanges.length, editing, savingChanges]);

  useEffect(() => {
    setViewerSize(
      viewerPrefs.dock === "right"
        ? viewerPrefs.rightWidth
        : viewerPrefs.bottomHeight,
    );
  }, [viewerPrefs.dock, viewerPrefs.rightWidth, viewerPrefs.bottomHeight]);

  useEffect(() => {
    if (!viewer && !gridMenu && !exportMenu && !headerMenu && !filterMenu) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setViewer(null);
        setGridMenu(null);
        setExportMenu(null);
        setHeaderMenu(null);
        setFilterMenu(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewer, gridMenu, exportMenu, headerMenu, filterMenu]);

  const columns = result?.columns ?? [];
  const rows = result?.rows ?? [];

  const sourceRows = useMemo(() => {
    const indexed = rows.map((row, index) => ({ row, index }));
    if (serverSide || filters.length === 0) return indexed;
    return indexed.filter((item) =>
      rowMatchesFilters(columns, item.row, filters),
    );
  }, [rows, columns, filters, serverSide]);

  const sortedRows = useMemo(() => {
    if (!sort) return sourceRows;
    return [...sourceRows].sort((a, b) => {
      const left = a.row[sort.col];
      const right = b.row[sort.col];
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      if (typeof left === "number" && typeof right === "number") {
        return (left - right) * (sort.dir === "asc" ? 1 : -1);
      }
      const compared = String(left).localeCompare(String(right), undefined, {
        numeric: true,
        sensitivity: "base",
      });
      return compared * (sort.dir === "asc" ? 1 : -1);
    });
  }, [sourceRows, sort]);

  const numericColumns = useMemo(() => {
    return columns.map((_, index) => {
      let seen = false;
      for (const row of rows) {
        const value = row[index];
        if (value === null || value === undefined) continue;
        seen = true;
        if (typeof value !== "number") return false;
      }
      return seen;
    });
  }, [columns, rows]);

  const pendingUpdates = useMemo(() => {
    const map = new Map<
      string,
      Extract<PendingChange, { kind: "update" }>
    >();
    for (const change of pendingChanges) {
      if (change.kind === "update") {
        map.set(`${change.sourceIndex}:${change.columnIndex}`, change);
      }
    }
    return map;
  }, [pendingChanges]);

  const pendingDeleted = useMemo(
    () =>
      new Set(
        pendingChanges
          .filter(
            (change): change is Extract<PendingChange, { kind: "delete" }> =>
              change.kind === "delete",
          )
          .map((change) => change.sourceIndex),
      ),
    [pendingChanges],
  );

  const pendingInserts = useMemo(
    () =>
      pendingChanges.filter(
        (change): change is Extract<PendingChange, { kind: "insert" }> =>
          change.kind === "insert",
      ),
    [pendingChanges],
  );

  const pendingCount = pendingChanges.length;

  function latestPendingUpdate(
    sourceIndex: number,
    columnIndex: number,
  ): Extract<PendingChange, { kind: "update" }> | undefined {
    return pendingUpdates.get(`${sourceIndex}:${columnIndex}`);
  }

  const gridWidth =
    INDEX_WIDTH +
    order.reduce(
      (total, column) => total + (widths[column] ?? DEFAULT_COL_WIDTH),
      0,
    );

  const selection = anchor && focus ? normalizeRange(anchor, focus) : null;
  const activeCell = viewer ?? focus ?? anchor;
  const activeValue =
    activeCell && activeCell.row < sortedRows.length
      ? (sortedRows[activeCell.row].row[activeCell.col] ?? null)
      : null;
  const activeColumn =
    activeCell && activeCell.col < columns.length
      ? columns[activeCell.col]
      : "";

  function selectCell(
    event: MouseEvent<HTMLDivElement>,
    row: number,
    col: number,
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    gridRef.current?.focus({ preventScroll: true });
    if (event.shiftKey && anchor) {
      setFocus({ row, col });
    } else {
      setAnchor({ row, col });
      setFocus({ row, col });
    }
    setViewer((current) =>
      current ? { row, col: order[col] ?? col } : null,
    );
    setGridMenu(null);
    setDragging(true);
  }

  function enterCell(row: number, col: number) {
    if (!dragging) return;
    setFocus({ row, col });
  }

  const canEdit =
    !!editable &&
    !!connId &&
    !!table &&
    !!tabId &&
    Array.isArray(pkColumns) &&
    pkColumns.length > 0;

  function startEdit(rowDisplay: number, columnActual: number) {
    const source = sortedRows[rowDisplay];
    if (!source || pendingDeleted.has(source.index)) return;
    const queued = latestPendingUpdate(source.index, columnActual);
    const raw = queued
      ? queued.next
      : (source.row[columnActual] ?? null);
    setEditing({ row: rowDisplay, col: columnActual });
    setEditText(raw === null || raw === undefined ? "" : String(raw));
    setViewer(null);
    setGridMenu(null);
  }

  async function commitEdit() {
    const current = editing;
    setEditing(null);
    if (!current || !canEdit || !connId || !table || !tabId || !result) return;

    const source = sortedRows[current.row];
    const columnName = columns[current.col];
    if (!source || !columnName) return;

    const original = source.row[current.col] ?? null;
    const queued = latestPendingUpdate(source.index, current.col);
    const currentValue = queued ? queued.next : original;
    const next = editText;
    if (
      (currentValue === null && next === "") ||
      String(currentValue ?? "") === next
    ) {
      return; // no change
    }

    let payload = next;
    let displayNext: CellValue = next;
    if (dialect === "sqlite" && typeof currentValue === "boolean") {
      const bool = sqliteBooleanLiteral(next);
      if (bool !== null) {
        payload = bool;
        displayNext = bool === "1";
      }
    }

    const pk = (pkColumns ?? []).map((name) => {
      const index = columns.indexOf(name);
      const value = index >= 0 ? source.row[index] : null;
      return { column: name, value: pkValue(value) };
    });

    if (!effectiveAutoCommit) {
      addPendingChange(tabId, {
        kind: "update",
        sourceIndex: source.index,
        pk,
        column: columnName,
        columnIndex: current.col,
        value: payload,
        previous: currentValue,
        next: displayNext,
      });
      setFailedChangeId(null);
      setError(null);
      setCopied("Edit queued");
      return;
    }

    const guard = await guardSqlExecution(
      connId,
      `UPDATE ${table} SET ${columnName} = NULL WHERE ...`,
      database ?? undefined,
    );
    if (!guard.allow) {
      if (guard.error) setError(guard.error);
      setCopied("Edit blocked");
      return;
    }

    try {
      await updateCell(connId, database ?? "", table, pk, columnName, payload);
      const rows = result.rows.map((row) => row.slice());
      rows[source.index][current.col] = displayNext;
      setResult({ ...result, rows });
      setError(null);
      setCopied("Updated");
    } catch (updateError) {
      // Surface the real DB error (e.g. a read-only user without UPDATE rights)
      // in the table's error bar, and keep the cell's original value.
      setError(errorMessage(updateError));
      setCopied("Edit denied");
    }
  }

  // Distinct rows covered by the current selection (whole rows, PK-based).
  function selectedRowDisplayIndexes(): number[] {
    if (!selection) return activeCell ? [activeCell.row] : [];
    const indexes: number[] = [];
    for (let row = selection.top; row <= selection.bottom; row++) {
      if (row < sortedRows.length) indexes.push(row);
    }
    return indexes;
  }

  async function deleteSelectedRows() {
    const displayIndexes = selectedRowDisplayIndexes();
    if (
      !canEdit ||
      !connId ||
      !table ||
      !tabId ||
      !result ||
      displayIndexes.length === 0
    ) {
      setConfirmDelete(null);
      return;
    }

    const pkList: CellRef[][] = [];
    const sourceIndexes: number[] = [];
    for (const displayIndex of displayIndexes) {
      const source = sortedRows[displayIndex];
      if (!source) continue;
      const pk = (pkColumns ?? []).map((name) => {
        const index = columns.indexOf(name);
        const value = index >= 0 ? source.row[index] : null;
        return { column: name, value: pkValue(value) };
      });
      pkList.push(pk);
      sourceIndexes.push(source.index);
    }

    if (!effectiveAutoCommit) {
      pkList.forEach((pk, index) => {
        addPendingChange(tabId, {
          kind: "delete",
          sourceIndex: sourceIndexes[index],
          pk,
        });
      });
      setFailedChangeId(null);
      setError(null);
      setAnchor(null);
      setFocus(null);
      setCopied(`Queued ${pkList.length} delete(s)`);
      setConfirmDelete(null);
      return;
    }

    const guard = await guardSqlExecution(
      connId,
      `DELETE FROM ${table} WHERE ...`,
      database ?? undefined,
      { title: "Delete rows" },
    );
    if (!guard.allow) {
      if (guard.error) setError(guard.error);
      setCopied("Delete blocked");
      setConfirmDelete(null);
      return;
    }

    setDeleting(true);
    try {
      const affected = await deleteRowsIpc(connId, database ?? "", table, pkList);
      const drop = new Set(sourceIndexes);
      const rows = result.rows.filter((_, index) => !drop.has(index));
      setResult({ ...result, rows });
      setError(null);
      setAnchor(null);
      setFocus(null);
      setCopied(`Deleted ${affected} row(s)`);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
      setCopied("Delete denied");
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
    }
  }

  async function savePendingChanges() {
    if (
      !tabId ||
      !connId ||
      !table ||
      pendingChanges.length === 0 ||
      savingChanges
    ) {
      return;
    }

    const changes = pendingChanges.slice();
    const readOnlyError = readOnlyWriteError(connId);
    if (readOnlyError) {
      setError(readOnlyError);
      setCopied("Save blocked");
      return;
    }

    setSavingChanges(true);
    setFailedChangeId(null);
    setError(null);
    try {
      if (isProduction(connection)) {
        const preview = await previewChanges(
          connId,
          database ?? "",
          table,
          changes.map(toChangeInput),
        );
        const previewSql = preview.join(";\n");
        const guard = await guardSqlExecution(
          connId,
          previewSql,
          database ?? undefined,
          { title: "Save changes", previewSql },
        );
        if (!guard.allow) {
          if (guard.error) setError(guard.error);
          setCopied("Save cancelled");
          return;
        }
      }

      const outcome = await applyChanges(
        connId,
        database ?? "",
        table,
        changes.map(toChangeInput),
      );
      if (outcome.ok) {
        clearPendingChanges(tabId);
        setPreviewSql(null);
        setCopied(`Saved ${changes.length} change(s)`);
        onReload?.();
      } else {
        const failedIndex = outcome.failed_change;
        setFailedChangeId(
          failedIndex !== undefined ? (changes[failedIndex]?.id ?? null) : null,
        );
        setError(outcome.error ?? "Save failed");
        setCopied("Save failed");
      }
    } catch (saveError) {
      setError(errorMessage(saveError));
      setCopied("Save failed");
    } finally {
      setSavingChanges(false);
    }
  }

  function discardPendingChanges() {
    if (!tabId) return;
    clearPendingChanges(tabId);
    setFailedChangeId(null);
    setPreviewSql(null);
    setError(null);
    setCopied("Discarded");
  }

  async function openPreview() {
    if (!connId || !table || pendingChanges.length === 0) return;
    try {
      const statements = await previewChanges(
        connId,
        database ?? "",
        table,
        pendingChanges.map(toChangeInput),
      );
      setPreviewSql(statements);
      setError(null);
    } catch (previewError) {
      setError(errorMessage(previewError));
    }
  }

  function selectRow(event: MouseEvent<HTMLDivElement>, row: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    gridRef.current?.focus({ preventScroll: true });
    if (event.shiftKey && anchor) {
      setAnchor({ row: anchor.row, col: 0 });
      setFocus({ row, col: Math.max(0, columns.length - 1) });
    } else {
      setAnchor({ row, col: 0 });
      setFocus({ row, col: Math.max(0, columns.length - 1) });
    }
    setViewer(null);
    setGridMenu(null);
    setDragging(false);
  }

  function openContextMenu(
    event: MouseEvent<HTMLDivElement>,
    row: number,
    col: number,
  ) {
    event.preventDefault();
    gridRef.current?.focus({ preventScroll: true });
    if (!selection || !inSelection(row, col)) {
      setAnchor({ row, col });
      setFocus({ row, col });
    }
    setViewer(null);
    setGridMenu({
      x: Math.min(event.clientX, window.innerWidth - 230),
      y: Math.min(event.clientY, window.innerHeight - 260),
    });
  }

  function inSelection(row: number, col: number) {
    if (!selection) return false;
    return (
      row >= selection.top &&
      row <= selection.bottom &&
      col >= selection.left &&
      col <= selection.right
    );
  }

  function selectedMatrix() {
    if (!selection) return null;
    const columnIndexes: number[] = [];
    for (let position = selection.left; position <= selection.right; position++) {
      const column = order[position];
      if (column !== undefined) columnIndexes.push(column);
    }
    const selectedRows: CellValue[][] = [];
    for (let row = selection.top; row <= selection.bottom; row++) {
      const source = sortedRows[row];
      if (!source) continue;
      selectedRows.push(columnIndexes.map((column) => source.row[column] ?? null));
    }
    return {
      rowCount: selectedRows.length,
      headers: columnIndexes.map((column) => columns[column] ?? ""),
      rows: selectedRows,
    };
  }

  function insertStatement(matrix: NonNullable<ReturnType<typeof selectedMatrix>>) {
    const inferred = tableFromSql(sql);
    const targetTable = table ?? inferred.table ?? "result";
    const targetDb = database ?? inferred.database;
    const target = tableRef(dialect, targetDb, targetTable);
    const names = matrix.headers
      .map((name) => quoteIdentifier(dialect, name))
      .join(", ");
    const values = matrix.rows.map((row) => {
      return `(${row.map(insertCell).join(", ")})`;
    });
    return `INSERT INTO ${target} (${names}) VALUES\n  ${values.join(",\n  ")};`;
  }

  async function copySelection(format: CopyFormat) {
    const matrix = selectedMatrix();
    if (!matrix) return;

    let text = "";
    if (format === "tsv" || format === "headers") {
      const lines = matrix.rows.map((row) => row.map(tsvCell).join("\t"));
      text =
        format === "headers"
          ? [matrix.headers.join("\t"), ...lines].join("\n")
          : lines.join("\n");
    } else if (format === "csv") {
      const lines = matrix.rows.map((row) => row.map(csvCell).join(","));
      text = [matrix.headers.map(csvCell).join(","), ...lines].join("\r\n");
    } else if (format === "json") {
      text = JSON.stringify(
        matrix.rows.map((row) =>
          Object.fromEntries(
            matrix.headers.map((header, index) => [
              header,
              jsonCell(row[index] ?? null),
            ]),
          ),
        ),
        null,
        2,
      );
    } else {
      text = insertStatement(matrix);
    }

    gridRef.current?.focus({ preventScroll: true });
    setGridMenu(null);
    const ok = await copyText(text);
    setCopied(
      ok
        ? matrix.rowCount === 1
          ? "Copied 1 row"
          : `Copied ${matrix.rowCount} rows`
        : "Copy failed",
    );
  }

  async function copyActiveCell() {
    if (!activeCell || activeCell.row >= sortedRows.length) return;
    const row = sortedRows[activeCell.row];
    const value = row.row[activeCell.col] ?? null;
    const ok = await copyText(rawValue(value));
    setCopied(ok ? "Copied cell" : "Copy failed");
  }

  async function copyViewer() {
    if (!viewer || viewer.row >= sortedRows.length) return;
    const value = sortedRows[viewer.row].row[viewer.col] ?? null;
    const ok = await copyText(prettyValue(value, pretty));
    setCopied(ok ? "Copied cell" : "Copy failed");
  }

  async function exportLoaded(format: ExportFormat) {
    if (!result || result.columns.length === 0) return;
    const inferred = tableFromSql(sql);
    const targetTable = table ?? inferred.table;
    const targetDatabase = database ?? inferred.database;
    const base = targetTable ?? "query-result";
    setGridMenu(null);
    setExportMenu(null);
    setCopied("Exporting…");
    try {
      const saved = await exportResult(
        format,
        result.columns,
        result.rows,
        `${base}.${format}`,
        {
          dialect,
          database: targetDatabase,
          table: targetTable,
        },
      );
      setCopied(
        saved ? `Exported ${format.toUpperCase()}` : "Export cancelled",
      );
    } catch (exportError) {
      setError(errorMessage(exportError));
      setCopied("Export failed");
    }
  }

  async function exportWholeTable(format: ExportFormat) {
    if (!connId || !table) return;
    const id = operationId("export");
    setGridMenu(null);
    setExportMenu(null);
    exportIdRef.current = id;
    setExporting({ id, rows: 0, cancelRequested: false });
    setCopied("Exporting whole table…");
    try {
      const saved = await exportTable(
        connId,
        database ?? "",
        table,
        format,
        id,
      );
      if (!saved && exportIdRef.current === id) {
        setCopied("Export cancelled");
      }
    } catch (exportError) {
      if (exportIdRef.current === id) {
        setError(errorMessage(exportError));
        setCopied("Export failed");
      }
    } finally {
      if (exportIdRef.current === id) {
        exportIdRef.current = null;
        setExporting(null);
      }
    }
  }

  async function cancelExport() {
    if (!exporting) return;
    setExporting({ ...exporting, cancelRequested: true });
    try {
      await cancelOperation(exporting.id);
    } catch {
      // The export may already have finished.
    }
  }

  function handleGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (!mod) {
      if (editing) return;
      let rowDelta = 0;
      let colDelta = 0;
      if (event.key === "ArrowUp") rowDelta = -1;
      else if (event.key === "ArrowDown") rowDelta = 1;
      else if (event.key === "ArrowLeft") colDelta = -1;
      else if (event.key === "ArrowRight") colDelta = 1;
      else return;
      if (sortedRows.length === 0 || order.length === 0) return;
      event.preventDefault();
      const current = focus ?? anchor ?? { row: 0, col: 0 };
      const next = {
        row: Math.max(
          0,
          Math.min(sortedRows.length - 1, current.row + rowDelta),
        ),
        col: Math.max(0, Math.min(order.length - 1, current.col + colDelta)),
      };
      if (event.shiftKey && anchor) {
        setFocus(next);
      } else {
        setAnchor(next);
        setFocus(next);
      }
      if (viewer) {
        const actual = order[next.col];
        if (actual !== undefined) {
          setViewer({ row: next.row, col: actual });
        }
      }
      gridRef.current
        ?.querySelector<HTMLElement>(`[data-cell="${next.row}:${next.col}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    if (key === "a") {
      event.preventDefault();
      if (sortedRows.length === 0 || columns.length === 0) return;
      setAnchor({ row: 0, col: 0 });
      setFocus({ row: sortedRows.length - 1, col: columns.length - 1 });
      return;
    }
    if (key === "c") {
      event.preventDefault();
      void copySelection("tsv");
    }
  }

  function startResize(
    event: MouseEvent<HTMLSpanElement>,
    column: number,
  ) {
    event.preventDefault();
    event.stopPropagation();
    resizingRef.current = true;
    const startX = event.clientX;
    const startWidth = widths[column] ?? DEFAULT_COL_WIDTH;

    const onMove = (moveEvent: globalThis.MouseEvent) => {
      const next = Math.max(
        MIN_COL_WIDTH,
        startWidth + moveEvent.clientX - startX,
      );
      setWidths((current) => ({ ...current, [column]: next }));
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.setTimeout(() => {
        resizingRef.current = false;
      }, 0);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function viewerSizeLimit(dock: "right" | "bottom"): number {
    const container = gridRef.current?.parentElement;
    if (!container) return Number.POSITIVE_INFINITY;
    const size =
      dock === "right" ? container.clientWidth : container.clientHeight;
    return Math.max(0, size) * VIEWER_MAX_RATIO;
  }

  function clampViewerSize(dock: "right" | "bottom", size: number): number {
    const min = dock === "right" ? MIN_VIEWER_WIDTH : MIN_VIEWER_HEIGHT;
    const max = viewerSizeLimit(dock);
    return Math.max(min, Math.min(size, Math.max(min, max)));
  }

  function startViewerResize(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const dock = viewerPrefs.dock;
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = viewerSize;

    const nextSize = (clientX: number, clientY: number) => {
      const delta = dock === "right" ? startX - clientX : startY - clientY;
      return clampViewerSize(dock, startSize + delta);
    };

    const onMove = (moveEvent: globalThis.MouseEvent) => {
      setViewerSize(nextSize(moveEvent.clientX, moveEvent.clientY));
    };

    const onUp = (upEvent: globalThis.MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const next = nextSize(upEvent.clientX, upEvent.clientY);
      setViewerSize(next);
      setViewerPref(
        dock === "right" ? { rightWidth: next } : { bottomHeight: next },
      );
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = dock === "right" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }

  function handleViewerResizeKey(event: KeyboardEvent<HTMLDivElement>) {
    const dock = viewerPrefs.dock;
    let delta = 0;
    if (dock === "right") {
      if (event.key === "ArrowLeft") delta = VIEWER_RESIZE_STEP;
      else if (event.key === "ArrowRight") delta = -VIEWER_RESIZE_STEP;
    } else if (event.key === "ArrowUp") {
      delta = VIEWER_RESIZE_STEP;
    } else if (event.key === "ArrowDown") {
      delta = -VIEWER_RESIZE_STEP;
    }
    if (delta === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next = clampViewerSize(dock, viewerSize + delta);
    setViewerSize(next);
    setViewerPref(
      dock === "right" ? { rightWidth: next } : { bottomHeight: next },
    );
  }

  function toggleViewerDock() {
    setViewerPref({ dock: viewerPrefs.dock === "right" ? "bottom" : "right" });
  }

  function applyServerQuery(
    nextFilters: ColumnFilter[],
    nextSort: { col: number; dir: "asc" | "desc" } | null,
    clearWhere = false,
  ) {
    if (!serverSide || !onServerQuery) return;
    const spec = nextSort
      ? { column: columns[nextSort.col] ?? "", dir: nextSort.dir }
      : null;
    const generated = buildWhere(dialect, columns, nextFilters);
    const nextWhere =
      nextFilters.length > 0 ? generated : clearWhere ? "" : (where ?? "");
    onServerQuery(
      nextWhere,
      buildOrderBy(dialect, columns, spec),
    );
  }

  function changeFilters(next: ColumnFilter[]) {
    if (tabId) {
      setClientFilters(tabId, next);
    } else {
      setLocalFilters(next);
    }
    applyServerQuery(next, sort, next.length === 0 && filters.length > 0);
  }

  function applySort(next: { col: number; dir: "asc" | "desc" } | null) {
    setSort(next);
    applyServerQuery(filters, next);
  }

  function cycleSort(column: number) {
    if (resizingRef.current) return;
    setViewer(null);
    setAnchor(null);
    setFocus(null);
    const next =
      !sort || sort.col !== column
        ? { col: column, dir: "asc" as const }
        : sort.dir === "asc"
          ? { col: column, dir: "desc" as const }
          : null;
    applySort(next);
  }

  function openHeaderMenu(
    event: MouseEvent<HTMLDivElement>,
    column: number,
  ) {
    event.preventDefault();
    event.stopPropagation();
    setGridMenu(null);
    setFilterMenu(null);
    setHeaderMenu({
      column,
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 160),
    });
  }

  function openFilterMenu(column: number, x: number, y: number) {
    const name = columns[column] ?? "";
    const existing = filters.find((filter) => filter.column === name);
    setDraftOp(existing?.op ?? "contains");
    setDraftValue(existing?.value ?? "");
    setHeaderMenu(null);
    setGridMenu(null);
    setFilterMenu({
      column,
      x: Math.min(x, window.innerWidth - 280),
      y: Math.min(y, window.innerHeight - 150),
    });
  }

  function applyDraftFilter() {
    const menu = filterMenu;
    if (!menu) return;
    const name = columns[menu.column];
    if (!name) return;
    const next = filters.filter((filter) => filter.column !== name);
    next.push({ column: name, op: draftOp, value: draftValue });
    setFilterMenu(null);
    changeFilters(next);
  }

  function removeFilter(filter: ColumnFilter) {
    changeFilters(filters.filter((item) => item.column !== filter.column));
  }

  function handleDrop(target: number) {
    if (dragCol === null || dragCol === target) {
      setDragCol(null);
      setOverCol(null);
      return;
    }
    setOrder((current) => {
      const next = current.filter((column) => column !== dragCol);
      const targetIndex = next.indexOf(target);
      next.splice(targetIndex < 0 ? next.length : targetIndex, 0, dragCol);
      return next;
    });
    setDragCol(null);
    setOverCol(null);
    setViewer(null);
    setAnchor(null);
    setFocus(null);
  }

  const hasResult = !!result;
  const hasColumns = columns.length > 0;
  const canExportWholeTable = !!(table && connId);

  return (
    <section
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
      }}
    >
      {pendingCount > 0 && (
        <div
          role="status"
          style={{
            height: 28,
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 10px",
            borderBottom: "1px solid var(--bd)",
            background: "var(--edits)",
            fontFamily: "var(--mono)",
            fontSize: 11.5,
          }}
        >
          <i
            className="icon-pencil"
            style={{ fontSize: 12, color: "var(--wn)" }}
          />
          <span style={{ color: "var(--tx)" }}>
            {pendingCount} change{pendingCount === 1 ? "" : "s"} —
          </span>
          <button
            type="button"
            className="v2-btn v2-btn-primary"
            onClick={() => void savePendingChanges()}
            disabled={savingChanges}
            style={{ height: 20, padding: "0 8px", fontSize: 11 }}
          >
            {savingChanges ? "Saving…" : "Save (Ctrl/Cmd+S)"}
          </button>
          <span style={{ color: "var(--fa)" }}>·</span>
          <button
            type="button"
            className="v2-btn"
            onClick={discardPendingChanges}
            disabled={savingChanges}
            style={{ height: 20, padding: "0 8px", fontSize: 11 }}
          >
            Discard
          </button>
          <span style={{ color: "var(--fa)" }}>·</span>
          <button
            type="button"
            className="v2-btn"
            onClick={() => void openPreview()}
            disabled={savingChanges}
            style={{ height: 20, padding: "0 8px", fontSize: 11 }}
          >
            Preview SQL
          </button>
          <div style={{ flex: 1 }} />
          <span style={{ color: "var(--fa)" }}>Ctrl/Cmd+Z undo</span>
        </div>
      )}

      {filters.length > 0 && (
        <div
          style={{
            flex: "none",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 6,
            padding: "4px 8px",
            borderBottom: "1px solid var(--bd)",
            background: "var(--sf)",
          }}
        >
          {filters.map((filter) => (
            <span
              key={filter.column}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                height: 20,
                padding: "0 4px 0 7px",
                border: "1px solid var(--bd2)",
                borderRadius: 10,
                background: "var(--bg)",
                color: "var(--tx)",
                fontFamily: "var(--mono)",
                fontSize: 11,
                whiteSpace: "nowrap",
              }}
            >
              <span>{describeFilter(filter)}</span>
              <button
                type="button"
                onClick={() => removeFilter(filter)}
                title="Remove filter"
                aria-label={`Remove filter ${describeFilter(filter)}`}
                style={{
                  width: 16,
                  height: 16,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  border: 0,
                  borderRadius: "50%",
                  background: "transparent",
                  color: "var(--mu)",
                  cursor: "default",
                }}
              >
                <i className="icon-x" style={{ fontSize: 10 }} />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="v2-icon-btn"
            onClick={() => changeFilters([])}
            style={{
              height: 20,
              padding: "0 6px",
              border: 0,
              borderRadius: 4,
              background: "transparent",
              color: "var(--mu)",
              fontSize: 11,
              cursor: "default",
            }}
          >
            Clear all
          </button>
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection:
            viewer && viewerPrefs.dock === "bottom" ? "column" : "row",
          position: "relative",
        }}
      >
        {running && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              height: 2,
              background: "var(--ac)",
              zIndex: 6,
              animation: "df-load 1.2s cubic-bezier(.2,.8,.2,1) forwards",
            }}
          />
        )}

        {hasResult && hasColumns ? (
          <div
            ref={gridRef}
            tabIndex={0}
            onKeyDown={handleGridKeyDown}
            onMouseDown={() => setGridMenu(null)}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "auto",
              position: "relative",
              outline: "none",
            }}
          >
            <div
              style={{
                width: gridWidth,
                fontFamily: "var(--mono)",
                fontSize: 12,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <div
                style={{
                  display: "flex",
                  position: "sticky",
                  top: 0,
                  zIndex: 2,
                  height: 24,
                  background: "var(--sf2)",
                  borderBottom: "1px solid var(--bd)",
                }}
              >
                <div
                  style={{
                    width: INDEX_WIDTH,
                    flex: "none",
                    borderRight: "1px solid var(--bd)",
                  }}
                />
                {order.map((column) => {
                  const label = columns[column] ?? "";
                  const width = widths[column] ?? DEFAULT_COL_WIDTH;
                  const activeSort = sort?.col === column ? sort.dir : null;
                  const activeFilter = filters.find(
                    (filter) => filter.column === label,
                  );
                  const numeric = numericColumns[column];
                  return (
                    <div
                      key={column}
                      draggable
                      onMouseEnter={() => setHoverHeader(column)}
                      onMouseLeave={() =>
                        setHoverHeader((current) =>
                          current === column ? null : current,
                        )
                      }
                      onContextMenu={(event) => openHeaderMenu(event, column)}
                      onDragStart={(event) => {
                        if (resizingRef.current) {
                          event.preventDefault();
                          return;
                        }
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", String(column));
                        setDragCol(column);
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setOverCol(column);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        handleDrop(column);
                      }}
                      onDragEnd={() => {
                        setDragCol(null);
                        setOverCol(null);
                      }}
                      onClick={() => cycleSort(column)}
                      style={{
                        position: "relative",
                        width,
                        flex: "none",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: numeric ? "flex-end" : "flex-start",
                        gap: 4,
                        padding: "0 8px",
                        borderRight: "1px solid var(--bd)",
                        boxShadow:
                          overCol === column &&
                          dragCol !== null &&
                          dragCol !== column
                            ? "inset 2px 0 0 var(--ac)"
                            : "none",
                        fontFamily: "var(--ui)",
                        fontSize: 12,
                        fontWeight: 500,
                        color: "var(--tx)",
                        cursor: "default",
                        userSelect: "none",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                      }}
                      title={label}
                    >
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {label}
                      </span>
                      {activeSort && (
                        <i
                          className={
                            activeSort === "asc"
                              ? "icon-arrow-up"
                              : "icon-arrow-down"
                          }
                          style={{ fontSize: 11, color: "var(--ac)" }}
                        />
                      )}
                      {activeFilter && (
                        <span
                          title="Filtered"
                          style={{
                            width: 5,
                            height: 5,
                            flex: "none",
                            borderRadius: "50%",
                            background: "var(--ac)",
                          }}
                        />
                      )}
                      <button
                        type="button"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          const rect =
                            event.currentTarget.getBoundingClientRect();
                          setFilterMenu(null);
                          setGridMenu(null);
                          setHeaderMenu({
                            column,
                            x: Math.min(rect.right - 190, window.innerWidth - 190),
                            y: Math.min(rect.bottom + 2, window.innerHeight - 160),
                          });
                        }}
                        title="Column menu"
                        aria-label={`Column menu for ${label}`}
                        style={{
                          width: 16,
                          height: 16,
                          flex: "none",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 0,
                          border: 0,
                          borderRadius: 3,
                          background:
                            headerMenu?.column === column
                              ? "var(--hv)"
                              : "transparent",
                          color: "var(--mu)",
                          cursor: "default",
                          opacity:
                            hoverHeader === column ||
                            activeFilter ||
                            activeSort ||
                            headerMenu?.column === column
                              ? 1
                              : 0,
                        }}
                      >
                        <i
                          className="icon-chevron-down"
                          style={{ fontSize: 10 }}
                        />
                      </button>
                      <span
                        onMouseDown={(event) => startResize(event, column)}
                        onClick={(event) => event.stopPropagation()}
                        style={{
                          position: "absolute",
                          top: 0,
                          right: -1,
                          width: 6,
                          height: "100%",
                          cursor: "col-resize",
                          zIndex: 3,
                        }}
                      />
                    </div>
                  );
                })}
              </div>

              {sortedRows.map((source, rowIndex) => {
                const deletedRow = pendingDeleted.has(source.index);
                const failedRow =
                  failedChangeId !== null &&
                  pendingChanges.some(
                    (change) =>
                      change.id === failedChangeId &&
                      change.kind !== "insert" &&
                      change.sourceIndex === source.index,
                  );
                return (
                  <div
                    key={source.index}
                    data-row={rowIndex}
                    style={{
                      display: "flex",
                      height: ROW_HEIGHT,
                      background: failedRow
                        ? "var(--ers)"
                        : deletedRow
                          ? "var(--dels)"
                          : rowIndex % 2 === 1
                            ? "var(--zb)"
                            : "transparent",
                      opacity: deletedRow ? 0.68 : 1,
                    }}
                  >
                    <div
                      data-row-index={rowIndex}
                      onMouseDown={(event) => selectRow(event, rowIndex)}
                      style={{
                        width: INDEX_WIDTH,
                        flex: "none",
                        padding: "0 8px",
                        textAlign: "right",
                        lineHeight: `${ROW_HEIGHT}px`,
                        color: deletedRow ? "var(--mu)" : "var(--fa)",
                        textDecoration: deletedRow ? "line-through" : "none",
                        borderRight: "1px solid var(--bd)",
                        fontSize: 11,
                        background:
                          selection &&
                          selection.left === 0 &&
                          selection.right === order.length - 1 &&
                          rowIndex >= selection.top &&
                          rowIndex <= selection.bottom
                            ? "var(--acs)"
                            : "transparent",
                        cursor: "default",
                        userSelect: "none",
                      }}
                    >
                      {rowIndex + 1}
                    </div>
                    {order.map((column, columnPosition) => {
                      const queued = latestPendingUpdate(
                        source.index,
                        column,
                      );
                      const value = queued
                        ? queued.next
                        : (source.row[column] ?? null);
                      const selected =
                        selection !== null &&
                        rowIndex >= selection.top &&
                        rowIndex <= selection.bottom &&
                        columnPosition >= selection.left &&
                        columnPosition <= selection.right;
                      const numeric = numericColumns[column];
                      return (
                        <div
                          key={column}
                          data-cell={`${rowIndex}:${columnPosition}`}
                          onMouseDown={(event) =>
                            selectCell(event, rowIndex, columnPosition)
                          }
                          onMouseEnter={() =>
                            enterCell(rowIndex, columnPosition)
                          }
                          onDoubleClick={() => {
                            if (deletedRow) return;
                            const columnWidth =
                              widths[column] ?? DEFAULT_COL_WIDTH;
                            if (isLongValue(value, columnWidth)) {
                              setViewer({ row: rowIndex, col: column });
                              setGridMenu(null);
                            } else if (canEdit) {
                              startEdit(rowIndex, column);
                            } else {
                              setViewer({ row: rowIndex, col: column });
                              setGridMenu(null);
                            }
                          }}
                          onContextMenu={(event) =>
                            openContextMenu(
                              event,
                              rowIndex,
                              columnPosition,
                            )
                          }
                          style={{
                            width: widths[column] ?? DEFAULT_COL_WIDTH,
                            flex: "none",
                            padding: "0 8px",
                            lineHeight: `${ROW_HEIGHT}px`,
                            textAlign: numeric ? "right" : "left",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            borderRight: "1px solid var(--bd)",
                            color: deletedRow
                              ? "var(--mu)"
                              : value === null
                                ? "var(--fa)"
                                : "var(--tx)",
                            textDecoration: deletedRow
                              ? "line-through"
                              : "none",
                            fontStyle:
                              value === null ? "italic" : "normal",
                            background: selected
                              ? "var(--acs)"
                              : queued
                                ? "var(--edits)"
                                : "transparent",
                            outline: selected
                              ? "1px solid var(--ac)"
                              : "none",
                            outlineOffset: -1,
                            cursor: "default",
                            userSelect: "text",
                          }}
                          title={
                            queued
                              ? `${displayValue(value)} (pending)`
                              : displayValue(value)
                          }
                        >
                          {editing &&
                          editing.row === rowIndex &&
                          editing.col === column ? (
                            <input
                              autoFocus
                              value={editText}
                              onChange={(event) =>
                                setEditText(event.target.value)
                              }
                              onMouseDown={(event) =>
                                event.stopPropagation()
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void commitEdit();
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  setEditing(null);
                                }
                              }}
                              onBlur={() => void commitEdit()}
                              style={{
                                width: "100%",
                                height: ROW_HEIGHT - 2,
                                border: "1px solid var(--ac)",
                                borderRadius: 2,
                                background: "var(--bg)",
                                color: "var(--tx)",
                                font: "inherit",
                                padding: "0 6px",
                                outline: "none",
                              }}
                            />
                          ) : (
                            displayValue(value)
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {pendingInserts.map((change) => {
                const failedRow = change.id === failedChangeId;
                return (
                  <div
                    key={change.id}
                    style={{
                      display: "flex",
                      height: ROW_HEIGHT,
                      background: failedRow
                        ? "var(--ers)"
                        : "var(--newrow)",
                    }}
                  >
                    <div
                      style={{
                        width: INDEX_WIDTH,
                        flex: "none",
                        padding: "0 8px",
                        textAlign: "right",
                        lineHeight: `${ROW_HEIGHT}px`,
                        color: "var(--ok)",
                        borderRight: "1px solid var(--bd)",
                        fontSize: 11,
                        userSelect: "none",
                      }}
                    >
                      +
                    </div>
                    {order.map((column) => {
                      const name = columns[column] ?? "";
                      const cell = change.values.find(
                        (item) => item.column === name,
                      );
                      const value = cell ? cell.value : null;
                      return (
                        <div
                          key={column}
                          style={{
                            width: widths[column] ?? DEFAULT_COL_WIDTH,
                            flex: "none",
                            padding: "0 8px",
                            lineHeight: `${ROW_HEIGHT}px`,
                            textAlign: numericColumns[column]
                              ? "right"
                              : "left",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            borderRight: "1px solid var(--bd)",
                            color:
                              value === null ? "var(--fa)" : "var(--tx)",
                            fontStyle:
                              value === null ? "italic" : "normal",
                          }}
                          title={value ?? "NULL"}
                        >
                          {value === null ? "NULL" : value}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        ) : hasResult && !hasColumns ? (
          <div
            style={{
              flex: 1,
              display: "grid",
              placeItems: "center",
              color: "var(--mu)",
              fontFamily: "var(--mono)",
              fontSize: 12.5,
            }}
          >
            {typeof result?.rows_affected === "number"
              ? `Query OK — ${result.rows_affected} row(s) affected.`
              : "Query completed without a result set."}
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              color: "var(--mu)",
            }}
          >
            <img
              src={theme === "dark" ? lockupOnDark : lockupOnLight}
              alt="DataForge"
              style={{
                height: 30,
                width: "auto",
                display: "block",
                opacity: 0.92,
              }}
            />
            <span>
              {running
                ? "Running…"
                : error
                  ? "Fix the error and run again"
                  : emptyText ?? "No results — run a query"}
            </span>
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--fa)",
              }}
            >
              ⌘↵ run · ⌘K commands
            </span>
          </div>
        )}

        {viewer && activeCell && (
          <div
            role="region"
            aria-label={`${activeColumn} value`}
            style={{
              position: "relative",
              width:
                viewerPrefs.dock === "right"
                  ? `min(${viewerSize}px, 70%)`
                  : "100%",
              height:
                viewerPrefs.dock === "bottom"
                  ? `min(${viewerSize}px, 70%)`
                  : undefined,
              flex: "none",
              display: "flex",
              flexDirection: "column",
              borderLeft:
                viewerPrefs.dock === "right"
                  ? "1px solid var(--bd)"
                  : undefined,
              borderTop:
                viewerPrefs.dock === "bottom"
                  ? "1px solid var(--bd)"
                  : undefined,
              background: "var(--sf)",
              minHeight: 0,
              minWidth: viewerPrefs.dock === "right" ? MIN_VIEWER_WIDTH : 0,
            }}
          >
            <div
              role="separator"
              aria-orientation={
                viewerPrefs.dock === "right" ? "vertical" : "horizontal"
              }
              aria-label="Resize value panel"
              aria-valuenow={Math.round(viewerSize)}
              aria-valuemin={
                viewerPrefs.dock === "right"
                  ? MIN_VIEWER_WIDTH
                  : MIN_VIEWER_HEIGHT
              }
              tabIndex={0}
              title="Drag to resize"
              onMouseDown={startViewerResize}
              onKeyDown={handleViewerResizeKey}
              className={
                viewerPrefs.dock === "right"
                  ? "df2-resize-col"
                  : "df2-resize-row"
              }
              style={{
                position: "absolute",
                zIndex: 2,
                ...(viewerPrefs.dock === "right"
                  ? {
                      top: 0,
                      left: 0,
                      bottom: 0,
                      width: 5,
                      cursor: "col-resize",
                    }
                  : {
                      top: 0,
                      left: 0,
                      right: 0,
                      height: 5,
                      cursor: "row-resize",
                    }),
              }}
            />
            <div
              style={{
                height: 30,
                flex: "none",
                display: "flex",
                alignItems: "center",
                gap: 2,
                padding: "0 4px 0 10px",
                borderBottom: "1px solid var(--bd)",
              }}
            >
              <span
                title={activeColumn}
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {activeColumn}
              </span>
              <span
                style={{
                  flex: "none",
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: "var(--fa)",
                  marginLeft: 6,
                }}
              >
                {cellType(activeValue)}
              </span>
              <div style={{ flex: 1 }} />
              {canEdit && (
                <button
                  type="button"
                  className="v2-icon-btn"
                  onClick={() => startEdit(viewer.row, viewer.col)}
                  title="Edit value"
                  aria-label="Edit value"
                  style={{
                    ...viewerButtonStyle(false),
                    width: "auto",
                    padding: "0 6px",
                    gap: 4,
                  }}
                >
                  <i className="icon-pencil" style={{ fontSize: 13 }} />
                  <span style={{ fontSize: 11 }}>Edit</span>
                </button>
              )}
              <button
                type="button"
                className="v2-icon-btn"
                onClick={() => setWrap((value) => !value)}
                title="Wrap"
                style={viewerButtonStyle(wrap)}
              >
                <i className="icon-wrap-text" style={{ fontSize: 13 }} />
              </button>
              {cellType(activeValue) === "json" && (
                <button
                  type="button"
                  className="v2-icon-btn"
                  onClick={() => setPretty((value) => !value)}
                  title="Pretty-print JSON"
                  style={viewerButtonStyle(pretty)}
                >
                  <i className="icon-braces" style={{ fontSize: 13 }} />
                </button>
              )}
              <button
                type="button"
                className="v2-icon-btn"
                onClick={() => void copyViewer()}
                title="Copy"
                style={viewerButtonStyle(false)}
              >
                <i
                  className={copied ? "icon-check" : "icon-copy"}
                  style={{ fontSize: 13 }}
                />
              </button>
              <button
                type="button"
                className="v2-icon-btn"
                onClick={toggleViewerDock}
                title={
                  viewerPrefs.dock === "right"
                    ? "Dock panel to bottom"
                    : "Dock panel to right"
                }
                aria-label={
                  viewerPrefs.dock === "right"
                    ? "Dock panel to bottom"
                    : "Dock panel to right"
                }
                style={viewerButtonStyle(false)}
              >
                <i
                  className={
                    viewerPrefs.dock === "right"
                      ? "icon-panel-bottom"
                      : "icon-panel-right"
                  }
                  style={{ fontSize: 13 }}
                />
              </button>
              <button
                type="button"
                className="v2-icon-btn"
                onClick={() => setViewer(null)}
                title="Close"
                style={viewerButtonStyle(false)}
              >
                <i className="icon-x" style={{ fontSize: 13 }} />
              </button>
            </div>
            <pre
              className="allow-select"
              style={{
                flex: 1,
                minHeight: 0,
                margin: 0,
                padding: "10px 12px",
                overflow: "auto",
                fontFamily: "var(--mono)",
                fontSize: 12,
                lineHeight: 1.55,
                whiteSpace: wrap ? "pre-wrap" : "pre",
                wordBreak: "break-word",
                color: activeValue === null ? "var(--fa)" : "var(--tx)",
                fontStyle: activeValue === null ? "italic" : "normal",
              }}
            >
              {prettyValue(activeValue, pretty)}
            </pre>
          </div>
        )}
      </div>

      {hasResult && (
        <div
          style={{
            height: 24,
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 10px",
            borderTop: "1px solid var(--bd)",
            fontFamily: "var(--mono)",
            fontSize: 12,
            minWidth: 0,
          }}
        >
          <span style={{ flex: "none", color: "var(--fa)" }}>
            {activeCell
              ? `${activeColumn} · row ${activeCell.row + 1}`
              : "No cell selected"}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: activeCell ? "var(--tx)" : "var(--fa)",
              fontStyle:
                activeCell && activeValue === null ? "italic" : "normal",
            }}
          >
            {activeCell
              ? displayValue(activeValue)
              : "Click a cell to preview · double-click to open"}
          </span>
          <button
            type="button"
            className="v2-icon-btn"
            onClick={() => void copyActiveCell()}
            title="Copy cell value"
            disabled={!activeCell}
            style={{
              height: 24,
              flex: "none",
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "0 6px",
              border: 0,
              borderRadius: 4,
              background: "transparent",
              color: activeCell ? "var(--mu)" : "var(--fa)",
              opacity: activeCell ? 1 : 0.45,
              fontSize: 12,
              cursor: "default",
            }}
          >
            <i className="icon-copy" style={{ fontSize: 13 }} />
            <span>Copy</span>
          </button>
          <button
            type="button"
            className="v2-icon-btn"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setGridMenu(null);
              setExportMenu({
                x: Math.max(8, Math.min(rect.left, window.innerWidth - 280)),
                y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 360)),
              });
            }}
            title="Export the loaded rows"
            disabled={!hasColumns}
            style={{
              height: 24,
              flex: "none",
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "0 6px",
              border: 0,
              borderRadius: 4,
              background: "transparent",
              color: hasColumns ? "var(--mu)" : "var(--fa)",
              opacity: hasColumns ? 1 : 0.45,
              fontSize: 12,
              cursor: "default",
            }}
          >
            <i className="icon-download" style={{ fontSize: 13 }} />
            <span>Export</span>
            <i className="icon-chevron-down" style={{ fontSize: 11 }} />
          </button>
        </div>
      )}

      {exporting && (
        <div
          role="status"
          style={{
            height: 26,
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 10px",
            borderTop: "1px solid var(--bd)",
            background: "var(--sf)",
            fontFamily: "var(--mono)",
            fontSize: 11,
          }}
        >
          <i
            className="icon-download"
            style={{ fontSize: 12, color: "var(--ac)" }}
          />
          <span>
            Exporting whole table ·{" "}
            {exporting.rows.toLocaleString("en-US")} rows
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="v2-btn"
            onClick={() => void cancelExport()}
            disabled={exporting.cancelRequested}
            style={{ height: 20, padding: "0 8px", fontSize: 11 }}
          >
            {exporting.cancelRequested ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      )}

      <div
        style={{
          height: 26,
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 10px",
          borderTop: "1px solid var(--bd)",
          background: "var(--sf)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--mu)",
        }}
      >
        <span>
          {copied ??
            (running
              ? "Running…"
              : result
                ? `${rows.length.toLocaleString("en-US")} rows · ${result.elapsed_ms} ms`
                : error
                  ? "Query failed"
                  : "Ready")}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ color: "var(--fa)" }}>
          {result
            ? sort
              ? `sorted by ${columns[sort.col]} ${sort.dir}`
              : `${order.length} columns`
            : ""}
        </span>
      </div>

      {headerMenu && (
        <>
          <div
            onMouseDown={() => setHeaderMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setHeaderMenu(null);
            }}
            style={{ position: "fixed", inset: 0, zIndex: 60 }}
          />
          <div
            style={{
              position: "fixed",
              left: headerMenu.x,
              top: headerMenu.y,
              zIndex: 61,
              minWidth: 180,
              padding: 4,
              background: "var(--sf)",
              border: "1px solid var(--bd2)",
              borderRadius: 6,
              boxShadow: "var(--sh)",
            }}
          >
            <GridMenuItem
              icon="icon-arrow-up"
              label="Sort ascending"
              onClick={() => {
                setHeaderMenu(null);
                applySort({ col: headerMenu.column, dir: "asc" });
              }}
            />
            <GridMenuItem
              icon="icon-arrow-down"
              label="Sort descending"
              onClick={() => {
                setHeaderMenu(null);
                applySort({ col: headerMenu.column, dir: "desc" });
              }}
            />
            <GridMenuItem
              icon="icon-x"
              label="Clear sort"
              onClick={() => {
                setHeaderMenu(null);
                applySort(null);
              }}
            />
            <div
              style={{
                height: 1,
                background: "var(--bd)",
                margin: "4px -4px",
              }}
            />
            <GridMenuItem
              icon="icon-filter"
              label="Filter…"
              onClick={() =>
                openFilterMenu(headerMenu.column, headerMenu.x, headerMenu.y)
              }
            />
          </div>
        </>
      )}

      {filterMenu && (
        <>
          <div
            onMouseDown={() => setFilterMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setFilterMenu(null);
            }}
            style={{ position: "fixed", inset: 0, zIndex: 62 }}
          />
          <div
            style={{
              position: "fixed",
              left: filterMenu.x,
              top: filterMenu.y,
              zIndex: 63,
              width: 260,
              padding: 10,
              background: "var(--sf)",
              border: "1px solid var(--bd2)",
              borderRadius: 6,
              boxShadow: "var(--sh)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--mu)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              Filter · {columns[filterMenu.column]}
            </div>
            <select
              value={draftOp}
              onChange={(event) =>
                setDraftOp(event.target.value as FilterOperator)
              }
              style={{
                height: 26,
                border: "1px solid var(--bd2)",
                borderRadius: 4,
                background: "var(--bg)",
                color: "var(--tx)",
                fontSize: 12,
                padding: "0 6px",
              }}
            >
              {FILTER_OPERATORS.map((operator) => (
                <option key={operator.value} value={operator.value}>
                  {operator.label}
                </option>
              ))}
            </select>
            {filterNeedsValue(draftOp) && (
              <input
                autoFocus
                value={draftValue}
                onChange={(event) => setDraftValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applyDraftFilter();
                  }
                }}
                placeholder={
                  draftOp === "inList"
                    ? "a, b, c"
                    : draftOp === "contains"
                      ? "value"
                      : "value"
                }
                spellCheck={false}
                style={{
                  height: 26,
                  border: "1px solid var(--bd2)",
                  borderRadius: 4,
                  background: "var(--bg)",
                  color: "var(--tx)",
                  padding: "0 6px",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                }}
              />
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {filters.some(
                (filter) => filter.column === columns[filterMenu.column],
              ) && (
                <button
                  type="button"
                  className="v2-btn"
                  onClick={() => {
                    const filter = filters.find(
                      (item) =>
                        item.column === columns[filterMenu.column],
                    );
                    setFilterMenu(null);
                    if (filter) removeFilter(filter);
                  }}
                >
                  Remove
                </button>
              )}
              <div style={{ flex: 1 }} />
              <button
                type="button"
                className="v2-btn"
                onClick={() => setFilterMenu(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="v2-btn v2-btn-primary"
                onClick={applyDraftFilter}
              >
                Apply
              </button>
            </div>
          </div>
        </>
      )}

      {gridMenu && (
        <>
          <div
            onMouseDown={() => setGridMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setGridMenu(null);
            }}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 60,
            }}
          />
          <div
            style={{
              position: "fixed",
              left: gridMenu.x,
              top: gridMenu.y,
              zIndex: 61,
              minWidth: 220,
              padding: 4,
              background: "var(--sf)",
              border: "1px solid var(--bd2)",
              borderRadius: 6,
              boxShadow: "var(--sh)",
            }}
          >
            <GridMenuItem
              icon="icon-copy"
              label="Copy (TSV)"
              kbd="⌘C"
              onClick={() => void copySelection("tsv")}
            />
            <GridMenuItem
              icon="icon-copy"
              label="Copy with headers"
              onClick={() => void copySelection("headers")}
            />
            <GridMenuItem
              icon="icon-table"
              label="Copy as CSV"
              onClick={() => void copySelection("csv")}
            />
            <GridMenuItem
              icon="icon-braces"
              label="Copy as JSON"
              onClick={() => void copySelection("json")}
            />
            <GridMenuItem
              icon="icon-code"
              label="Copy as INSERT"
              onClick={() => void copySelection("insert")}
            />
            <div
              style={{
                height: 1,
                background: "var(--bd)",
                margin: "4px -4px",
              }}
            />
            <GridMenuItem
              icon="icon-download"
              label="Export…"
              onClick={() => {
                const menu = gridMenu;
                setGridMenu(null);
                if (menu) setExportMenu(menu);
              }}
            />
            <GridMenuItem
              icon="icon-type"
              label="Copy cell value"
              onClick={() => {
                setGridMenu(null);
                void copyActiveCell();
              }}
            />
            {canEdit && (
              <>
                <div
                  style={{
                    height: 1,
                    background: "var(--bd)",
                    margin: "4px -4px",
                  }}
                />
                <GridMenuItem
                  icon="icon-trash-2"
                  label={(() => {
                    const count = selectedRowDisplayIndexes().length;
                    return count > 1 ? `Delete ${count} rows` : "Delete row";
                  })()}
                  destructive
                  onClick={() => {
                    const count = selectedRowDisplayIndexes().length;
                    setGridMenu(null);
                    if (count > 0) setConfirmDelete(count);
                  }}
                />
              </>
            )}
          </div>
        </>
      )}

      {exportMenu && (
        <>
          <div
            onMouseDown={() => setExportMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setExportMenu(null);
            }}
            style={{ position: "fixed", inset: 0, zIndex: 62 }}
          />
          <div
            style={{
              position: "fixed",
              left: exportMenu.x,
              top: exportMenu.y,
              zIndex: 63,
              width: 240,
              padding: 4,
              background: "var(--sf)",
              border: "1px solid var(--bd2)",
              borderRadius: 6,
              boxShadow: "var(--sh)",
            }}
          >
            <GridMenuItem
              icon="icon-sheet"
              label="Excel (.xlsx)"
              onClick={() => void exportLoaded("xlsx")}
            />
            <GridMenuItem
              icon="icon-table"
              label="CSV (.csv)"
              onClick={() => void exportLoaded("csv")}
            />
            <GridMenuItem
              icon="icon-braces"
              label="JSON (.json)"
              onClick={() => void exportLoaded("json")}
            />
            <GridMenuItem
              icon="icon-code"
              label="SQL INSERT (.sql)"
              onClick={() => void exportLoaded("sql")}
            />
            {canExportWholeTable && (
              <>
                <div
                  style={{
                    height: 1,
                    background: "var(--bd)",
                    margin: "4px -4px",
                  }}
                />
                <div
                  style={{
                    padding: "4px 8px 2px",
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                    color: "var(--fa)",
                    textTransform: "uppercase",
                    letterSpacing: ".05em",
                  }}
                >
                  Whole table
                </div>
                <GridMenuItem
                  icon="icon-sheet"
                  label="Excel (.xlsx)"
                  onClick={() => void exportWholeTable("xlsx")}
                />
                <GridMenuItem
                  icon="icon-table"
                  label="CSV (.csv)"
                  onClick={() => void exportWholeTable("csv")}
                />
                <GridMenuItem
                  icon="icon-braces"
                  label="JSON (.json)"
                  onClick={() => void exportWholeTable("json")}
                />
                <GridMenuItem
                  icon="icon-code"
                  label="SQL INSERT (.sql)"
                  onClick={() => void exportWholeTable("sql")}
                />
              </>
            )}
          </div>
        </>
      )}

      {confirmDelete !== null && (
        <>
          <div
            onMouseDown={() => !deleting && setConfirmDelete(null)}
            style={{ position: "fixed", inset: 0, zIndex: 72, background: "var(--ov)" }}
          />
          <div
            style={{
              position: "fixed",
              left: "50%",
              top: "32%",
              transform: "translateX(-50%)",
              zIndex: 73,
              width: 360,
              maxWidth: "90vw",
              padding: 16,
              background: "var(--sf)",
              border: "1px solid var(--bd2)",
              borderRadius: 8,
              boxShadow: "var(--sh)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <i className="icon-trash-2" style={{ fontSize: 15, color: "var(--er)" }} />
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                Delete {confirmDelete} row{confirmDelete > 1 ? "s" : ""}?
              </span>
            </div>
            <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--mu)", lineHeight: 1.5 }}>
              {effectiveAutoCommit ? (
                <>
                  This runs{" "}
                  <code style={{ fontFamily: "var(--mono)" }}>DELETE</code>{" "}
                  against the live database and cannot be undone.
                </>
              ) : (
                <>
                  The rows are marked until you press Save; nothing is
                  deleted before that.
                </>
              )}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                className="v2-btn"
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="v2-btn"
                onClick={() => void deleteSelectedRows()}
                disabled={deleting}
                style={{
                  background: "var(--er)",
                  borderColor: "var(--er)",
                  color: "#fff",
                }}
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </>
      )}

      {previewSql !== null && (
        <>
          <div
            onMouseDown={() => setPreviewSql(null)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 74,
              background: "var(--ov)",
            }}
          />
          <div
            role="dialog"
            aria-label="Pending changes SQL"
            style={{
              position: "fixed",
              left: "50%",
              top: "12%",
              transform: "translateX(-50%)",
              zIndex: 75,
              width: 720,
              maxWidth: "92vw",
              maxHeight: "74vh",
              display: "flex",
              flexDirection: "column",
              background: "var(--sf)",
              border: "1px solid var(--bd2)",
              borderRadius: 8,
              boxShadow: "var(--sh)",
            }}
          >
            <div
              style={{
                height: 32,
                flex: "none",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 10px",
                borderBottom: "1px solid var(--bd)",
              }}
            >
              <i
                className="icon-code"
                style={{ fontSize: 13, color: "var(--fa)" }}
              />
              <span style={{ fontSize: 12.5, fontWeight: 500 }}>
                Preview SQL
              </span>
              <span style={{ color: "var(--fa)", fontSize: 11 }}>
                {previewSql.length} statement
                {previewSql.length === 1 ? "" : "s"} · runs in one transaction
              </span>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                className="v2-icon-btn"
                onClick={() => setPreviewSql(null)}
                title="Close"
                style={{ width: 24, height: 24 }}
              >
                <i className="icon-x" style={{ fontSize: 13 }} />
              </button>
            </div>
            <pre
              className="allow-select"
              style={{
                flex: 1,
                minHeight: 0,
                margin: 0,
                padding: "10px 12px",
                overflow: "auto",
                fontFamily: "var(--mono)",
                fontSize: 12,
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: "var(--tx)",
              }}
            >
              {previewSql.length === 0
                ? "No statements."
                : `${previewSql.join(";\n")};`}
            </pre>
          </div>
        </>
      )}
    </section>
  );
}

function viewerButtonStyle(active: boolean): CSSProperties {
  return {
    width: 24,
    height: 24,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: 0,
    borderRadius: 4,
    background: "transparent",
    color: active ? "var(--tx)" : "var(--mu)",
    cursor: "default",
  };
}

function GridMenuItem({
  icon,
  label,
  kbd,
  destructive,
  onClick,
}: {
  icon: string;
  label: string;
  kbd?: string;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="df2-menu-item"
      onClick={onClick}
      style={{
        width: "100%",
        height: 26,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 8px",
        border: 0,
        borderRadius: 4,
        color: destructive ? "var(--er)" : "var(--tx)",
        textAlign: "left",
        cursor: "default",
      }}
    >
      <i
        className={icon}
        style={{
          width: 14,
          flex: "none",
          fontSize: 13,
          color: destructive ? "var(--er)" : "var(--mu)",
        }}
      />
      <span style={{ flex: 1, whiteSpace: "nowrap" }}>{label}</span>
      {kbd && (
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--fa)",
          }}
        >
          {kbd}
        </span>
      )}
    </button>
  );
}

