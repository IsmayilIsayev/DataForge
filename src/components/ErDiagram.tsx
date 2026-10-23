import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { errorMessage, getErSchema, saveErd } from "../ipc";
import {
  ERD_HEADER_HEIGHT,
  ERD_ROW_HEIGHT,
  ERD_ROW_PAD,
  layoutEr,
} from "../erLayout";
import type { ErTableBox } from "../erLayout";
import { notify } from "../notifications";
import type { ErSchema } from "../types";

interface Props {
  connId: string;
  database: string;
  theme: "dark" | "light";
  onOpenTable: (table: string) => void;
}

interface Palette {
  bg: string;
  panel: string;
  panel2: string;
  border: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  key: string;
  edge: string;
  grid: string;
}

const DARK: Palette = {
  bg: "#0f1115",
  panel: "#15181d",
  panel2: "#1a1e24",
  border: "#2f343c",
  text: "#dfe3e8",
  muted: "#8b929c",
  faint: "#5c636d",
  accent: "#5b8def",
  key: "#caa23a",
  edge: "#4a5462",
  grid: "rgba(255,255,255,0.035)",
};

const LIGHT: Palette = {
  bg: "#ffffff",
  panel: "#fbfbfc",
  panel2: "#f4f5f7",
  border: "#d7dade",
  text: "#1a1d21",
  muted: "#616770",
  faint: "#8a9099",
  accent: "#2f6fd1",
  key: "#a9831c",
  edge: "#9aa1ab",
  grid: "rgba(0,0,0,0.045)",
};

interface VisualColumn {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
}

interface TableVisual {
  name: string;
  box: ErTableBox;
  columns: VisualColumn[];
  rowIndex: Map<string, number>;
  height: number;
}

interface EdgeVisual {
  id: string;
  from: string;
  to: string;
  path: string;
  fork: string;
  dotX: number;
  dotY: number;
}

interface Point {
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function shorten(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function rowY(box: ErTableBox, index: number) {
  return box.y + ERD_HEADER_HEIGHT + index * ERD_ROW_HEIGHT + ERD_ROW_HEIGHT / 2;
}

function buildEdges(
  visuals: Map<string, TableVisual>,
  schema: ErSchema,
): EdgeVisual[] {
  const edges: EdgeVisual[] = [];

  for (const fk of schema.foreign_keys) {
    const from = visuals.get(fk.from_table);
    const to = visuals.get(fk.to_table);
    if (!from || !to) continue;

    const count = Math.min(fk.from_columns.length, fk.to_columns.length);
    for (let index = 0; index < count; index += 1) {
      const fromRow = from.rowIndex.get(fk.from_columns[index]);
      const toRow = to.rowIndex.get(fk.to_columns[index]);
      if (fromRow === undefined || toRow === undefined) continue;

      const sy = rowY(from.box, fromRow);
      const ty = rowY(to.box, toRow);
      const forward =
        from.box.x + from.box.width / 2 <= to.box.x + to.box.width / 2;
      const sx = forward ? from.box.x + from.box.width : from.box.x;
      const tx = forward ? to.box.x : to.box.x + to.box.width;
      const bend = Math.max(46, Math.abs(tx - sx) * 0.45);

      const path =
        from.name === to.name
          ? `M ${sx} ${sy} C ${sx + 70} ${sy}, ${sx + 70} ${ty}, ${sx} ${ty}`
          : forward
            ? `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`
            : `M ${sx} ${sy} C ${sx - bend} ${sy}, ${tx + bend} ${ty}, ${tx} ${ty}`;

      const direction = from.name === to.name ? 1 : forward ? -1 : 1;
      const forkX = sx + direction * 10;
      const fork = `M ${sx} ${sy} L ${forkX} ${sy - 6} M ${sx} ${sy} L ${forkX} ${sy + 6}`;

      edges.push({
        id: `${fk.name}:${index}:${fk.from_table}:${fk.to_table}`,
        from: from.name,
        to: to.name,
        path,
        fork,
        dotX: tx,
        dotY: ty,
      });
    }
  }

  return edges;
}

export default function ErDiagram({
  connId,
  database,
  theme,
  onOpenTable,
}: Props) {
  const palette = theme === "dark" ? DARK : LIGHT;
  const patternId = `erd-grid-${useId().replace(/:/g, "")}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{
    kind: "pan" | "table";
    name?: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const positionsRef = useRef<Record<string, Point>>({});
  const viewRef = useRef({ x: 0, y: 0, scale: 1 });
  const spaceRef = useRef(false);
  const suppressClickRef = useRef(false);

  const [schema, setSchema] = useState<ErSchema | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [keysOnly, setKeysOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [hovered, setHovered] = useState<string | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [exporting, setExporting] = useState<"png" | "svg" | null>(null);

  const storageKey = `df-erd-positions:${connId}:${database}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    getErSchema(connId, database)
      .then((result) => {
        if (cancelled) return;
        setSchema(result);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [connId, database, reload]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? (JSON.parse(raw) as Record<string, Point>) : {};
      setPositions(parsed && typeof parsed === "object" ? parsed : {});
    } catch {
      setPositions({});
    }
  }, [storageKey]);

  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      spaceRef.current = true;
      setSpaceDown(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      spaceRef.current = false;
      setSpaceDown(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const layout = useMemo(
    () => (schema ? layoutEr(schema.tables, schema.foreign_keys) : null),
    [schema],
  );

  const placed = useMemo(() => {
    if (!layout) return [];
    return layout.tables.map((box) => ({
      ...box,
      ...(positions[box.name] ?? {}),
    }));
  }, [layout, positions]);

  const fkColumns = useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (!schema) return map;
    for (const fk of schema.foreign_keys) {
      const set = map.get(fk.from_table) ?? new Set<string>();
      for (const column of fk.from_columns) set.add(column);
      map.set(fk.from_table, set);
    }
    return map;
  }, [schema]);

  const visuals = useMemo(() => {
    if (!schema) return [] as TableVisual[];
    const boxes = new Map(placed.map((box) => [box.name, box]));
    const result: TableVisual[] = [];

    for (const table of schema.tables) {
      const box = boxes.get(table.name);
      if (!box) continue;
      const fks = fkColumns.get(table.name) ?? new Set<string>();
      const columns = table.columns
        .filter((column) => !keysOnly || column.pk || fks.has(column.name))
        .map((column) => ({
          name: column.name,
          type: column.data_type,
          pk: column.pk,
          fk: fks.has(column.name),
        }));
      result.push({
        name: table.name,
        box,
        columns,
        rowIndex: new Map(columns.map((column, index) => [column.name, index])),
        height:
          ERD_HEADER_HEIGHT +
          Math.max(1, columns.length) * ERD_ROW_HEIGHT +
          ERD_ROW_PAD,
      });
    }

    return result;
  }, [schema, placed, keysOnly, fkColumns]);

  const visualMap = useMemo(
    () => new Map(visuals.map((visual) => [visual.name, visual])),
    [visuals],
  );

  const edges = useMemo(
    () => (schema ? buildEdges(visualMap, schema) : []),
    [schema, visualMap],
  );

  const related = useMemo(() => {
    if (!hovered) return null;
    const set = new Set<string>([hovered]);
    for (const edge of edges) {
      if (edge.from === hovered || edge.to === hovered) {
        set.add(edge.from);
        set.add(edge.to);
      }
    }
    return set;
  }, [hovered, edges]);

  const query = search.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!schema || !query) return null;
    const set = new Set<string>();
    for (const table of schema.tables) {
      if (
        table.name.toLowerCase().includes(query) ||
        table.columns.some((column) => column.name.toLowerCase().includes(query))
      ) {
        set.add(table.name);
      }
    }
    return set;
  }, [schema, query]);

  const contentBounds = useMemo(() => {
    if (visuals.length === 0) {
      return { minX: 0, minY: 0, width: 1, height: 1 };
    }
    const minX = Math.min(...visuals.map((visual) => visual.box.x));
    const minY = Math.min(...visuals.map((visual) => visual.box.y));
    const maxX = Math.max(
      ...visuals.map((visual) => visual.box.x + visual.box.width),
    );
    const maxY = Math.max(
      ...visuals.map((visual) => visual.box.y + visual.height),
    );
    return {
      minX,
      minY,
      width: Math.max(maxX - minX, 1),
      height: Math.max(maxY - minY, 1),
    };
  }, [visuals]);

  const fitToScreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const pad = 56;
    const scale = clamp(
      Math.min(
        (rect.width - pad * 2) / contentBounds.width,
        (rect.height - pad * 2) / contentBounds.height,
      ),
      0.25,
      2,
    );
    setView({
      scale,
      x: (rect.width - contentBounds.width * scale) / 2 - contentBounds.minX * scale,
      y: (rect.height - contentBounds.height * scale) / 2 - contentBounds.minY * scale,
    });
  }, [contentBounds]);

  useEffect(() => {
    if (!schema) return;
    const frame = requestAnimationFrame(() => fitToScreen());
    return () => cancelAnimationFrame(frame);
  }, [schema]); // deliberately re-fit only when the schema changes

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;

      setView((previous) => {
        const scale = clamp(
          previous.scale * Math.exp(-event.deltaY * 0.0015),
          0.25,
          2,
        );
        if (scale === previous.scale) return previous;
        const wx = (px - previous.x) / previous.scale;
        const wy = (py - previous.y) / previous.scale;
        return {
          scale,
          x: px - wx * scale,
          y: py - wy * scale,
        };
      });
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;

      if (drag.kind === "pan") {
        setView((previous) => ({
          ...previous,
          x: drag.originX + dx,
          y: drag.originY + dy,
        }));
      } else if (drag.name) {
        const scale = viewRef.current.scale;
        setPositions((previous) => ({
          ...previous,
          [drag.name!]: {
            x: drag.originX + dx / scale,
            y: drag.originY + dy / scale,
          },
        }));
      }
    };

    const onUp = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;

      if (drag.kind === "table" && drag.moved) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        try {
          localStorage.setItem(
            storageKey,
            JSON.stringify(positionsRef.current),
          );
        } catch {
          // storage may be unavailable; positions stay for this session
        }
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [storageKey]);

  const startPan = (event: ReactMouseEvent) => {
    if (event.button !== 0) return;
    dragRef.current = {
      kind: "pan",
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
      moved: false,
    };
  };

  const startTableDrag = (
    event: ReactMouseEvent,
    visual: TableVisual,
  ) => {
    if (event.button !== 0) return;
    if (spaceRef.current) {
      startPan(event);
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    dragRef.current = {
      kind: "table",
      name: visual.name,
      startX: event.clientX,
      startY: event.clientY,
      originX: visual.box.x,
      originY: visual.box.y,
      moved: false,
    };
  };

  const zoomBy = (factor: number) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const px = rect.width / 2;
    const py = rect.height / 2;
    setView((previous) => {
      const scale = clamp(previous.scale * factor, 0.25, 2);
      const wx = (px - previous.x) / previous.scale;
      const wy = (py - previous.y) / previous.scale;
      return { scale, x: px - wx * scale, y: py - wy * scale };
    });
  };

  const fileBase = database.replace(/[\\/:*?"<>|]/g, "_") || "database";

  const collectSvg = useCallback(() => {
    const node = svgRef.current;
    if (!node) return null;
    const clone = node.cloneNode(true) as SVGSVGElement;
    const viewport = clone.querySelector("[data-erd-viewport]");
    viewport?.setAttribute("transform", "translate(0 0) scale(1)");
    const pad = 40;
    const bounds = contentBounds;
    clone.setAttribute(
      "viewBox",
      `${bounds.minX - pad} ${bounds.minY - pad} ${
        bounds.width + pad * 2
      } ${bounds.height + pad * 2}`,
    );
    clone.setAttribute("width", String(Math.ceil(bounds.width + pad * 2)));
    clone.setAttribute("height", String(Math.ceil(bounds.height + pad * 2)));
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.style.background = palette.bg;
    return new XMLSerializer().serializeToString(clone);
  }, [contentBounds, palette.bg]);

  const exportSvg = async () => {
    setExporting("svg");
    try {
      const data = collectSvg();
      if (!data) return;
      const saved = await saveErd("svg", data, `${fileBase}-erd.svg`);
      if (saved) void notify("DataForge", "ER diagram exported.");
    } catch (error) {
      void notify("DataForge", "Export failed: " + errorMessage(error));
    } finally {
      setExporting(null);
    }
  };

  const exportPng = async () => {
    setExporting("png");
    try {
      const data = collectSvg();
      if (!data) return;
      const pad = 40;
      const width = Math.ceil(contentBounds.width + pad * 2);
      const height = Math.ceil(contentBounds.height + pad * 2);
      const blob = new Blob([data], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const image = new Image();

      try {
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("Could not rasterize diagram"));
          image.src = url;
        });

        const canvas = document.createElement("canvas");
        canvas.width = width * 2;
        canvas.height = height * 2;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas is not available");
        context.fillStyle = palette.bg;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);

        const saved = await saveErd(
          "png",
          canvas.toDataURL("image/png"),
          `${fileBase}-erd.png`,
        );
        if (saved) void notify("DataForge", "ER diagram exported.");
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      void notify("DataForge", "Export failed: " + errorMessage(error));
    } finally {
      setExporting(null);
    }
  };

  const buttonStyle = {
    height: 24,
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "0 8px",
    border: "1px solid var(--bd2)",
    borderRadius: 4,
    background: "transparent",
    color: "var(--tx)",
    cursor: "default",
    fontSize: 11.5,
  } as const;

  if (loading && !schema) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--mu)" }}>
        Loading schema…
      </div>
    );
  }

  if (loadError && !schema) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--mu)" }}>
        <i className="icon-circle-alert" style={{ fontSize: 22, color: "var(--er)" }} />
        <span style={{ maxWidth: 460, textAlign: "center", lineHeight: 1.5 }}>
          {loadError}
        </span>
        <button
          type="button"
          className="v2-btn"
          onClick={() => setReload((value) => value + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        overflow: "hidden",
        background: palette.bg,
        cursor: spaceDown ? "grab" : "default",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          right: 8,
          zIndex: 3,
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 7px",
            background: "var(--sf)",
            border: "1px solid var(--bd)",
            borderRadius: 6,
            boxShadow: "var(--sh)",
            pointerEvents: "auto",
          }}
        >
          <i className="icon-search" style={{ fontSize: 12, color: "var(--fa)" }} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tables…"
            spellCheck={false}
            style={{
              width: 150,
              height: 20,
              border: 0,
              background: "transparent",
              color: "var(--tx)",
              fontSize: 11.5,
            }}
          />
          {matches && (
            <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fa)" }}>
              {matches.size}
            </span>
          )}
          <span style={{ width: 1, height: 14, background: "var(--bd)" }} />
          <button
            type="button"
            className="df2-quiet"
            onClick={() => setKeysOnly((value) => !value)}
            title="Toggle column visibility"
            style={{
              height: 20,
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "0 6px",
              borderRadius: 4,
              color: keysOnly ? "var(--ac)" : "var(--mu)",
              fontSize: 11,
            }}
          >
            <i className={keysOnly ? "icon-key-round" : "icon-list"} style={{ fontSize: 12 }} />
            <span>{keysOnly ? "Keys only" : "All columns"}</span>
          </button>
        </div>

        <div style={{ flex: 1 }} />

        {schema?.truncated && (
          <div
            style={{
              padding: "4px 8px",
              borderRadius: 6,
              background: "var(--wn)",
              color: "#1b1505",
              fontSize: 10.5,
              fontWeight: 500,
              pointerEvents: "auto",
            }}
            title="Only the first 300 tables are shown"
          >
            Showing first 300 tables
          </div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            padding: 3,
            background: "var(--sf)",
            border: "1px solid var(--bd)",
            borderRadius: 6,
            boxShadow: "var(--sh)",
            pointerEvents: "auto",
          }}
        >
          <button type="button" className="df2-icon-btn" onClick={() => zoomBy(0.8)} title="Zoom out" style={{ width: 24, height: 22, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 4 }}>
            <i className="icon-zoom-out" style={{ fontSize: 13 }} />
          </button>
          <span style={{ width: 40, textAlign: "center", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--mu)" }}>
            {Math.round(view.scale * 100)}%
          </span>
          <button type="button" className="df2-icon-btn" onClick={() => zoomBy(1.25)} title="Zoom in" style={{ width: 24, height: 22, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 4 }}>
            <i className="icon-zoom-in" style={{ fontSize: 13 }} />
          </button>
          <button type="button" className="df2-icon-btn" onClick={fitToScreen} title="Fit to screen" style={{ width: 24, height: 22, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 4 }}>
            <i className="icon-maximize" style={{ fontSize: 13 }} />
          </button>
          <span style={{ width: 1, height: 14, background: "var(--bd)", margin: "0 2px" }} />
          <button type="button" className="df2-quiet" onClick={() => void exportPng()} disabled={exporting !== null} style={buttonStyle} title="Export PNG at 2×">
            <i className="icon-image" style={{ fontSize: 12 }} />
            <span>{exporting === "png" ? "…" : "PNG"}</span>
          </button>
          <button type="button" className="df2-quiet" onClick={() => void exportSvg()} disabled={exporting !== null} style={buttonStyle} title="Export SVG">
            <i className="icon-download" style={{ fontSize: 12 }} />
            <span>{exporting === "svg" ? "…" : "SVG"}</span>
          </button>
          <button type="button" className="df2-icon-btn" onClick={() => setReload((value) => value + 1)} title="Refresh schema" style={{ width: 24, height: 22, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 4 }}>
            <i className="icon-refresh-cw" style={{ fontSize: 13 }} />
          </button>
        </div>
      </div>

      {schema && schema.tables.length === 0 && !loading && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--mu)" }}>
          This database has no tables.
        </div>
      )}

      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        style={{ display: "block" }}
        onMouseDown={startPan}
      >
        <defs>
          <pattern id={patternId} width="22" height="22" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill={palette.grid} />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={palette.bg} />
        <rect width="100%" height="100%" fill={`url(#${patternId})`} />
        <g
          data-erd-viewport=""
          transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}
        >
          {edges.map((edge) => {
            const connected =
              !hovered || edge.from === hovered || edge.to === hovered;
            return (
              <g
                key={edge.id}
                opacity={connected ? 1 : 0.12}
                pointerEvents="none"
              >
                <path
                  d={edge.path}
                  fill="none"
                  stroke={connected && hovered ? palette.accent : palette.edge}
                  strokeWidth={connected && hovered ? 1.8 : 1.2}
                />
                <path
                  d={edge.fork}
                  fill="none"
                  stroke={connected && hovered ? palette.accent : palette.edge}
                  strokeWidth={1.2}
                />
                <circle
                  cx={edge.dotX}
                  cy={edge.dotY}
                  r={3}
                  fill={palette.bg}
                  stroke={connected && hovered ? palette.accent : palette.edge}
                  strokeWidth={1.4}
                />
              </g>
            );
          })}

          {visuals.map((visual) => {
            const isHovered = hovered === visual.name;
            const isRelated = related?.has(visual.name) ?? false;
            const isMatch = matches?.has(visual.name) ?? false;
            const dimmed =
              (hovered !== null && !isRelated) ||
              (matches !== null && !isMatch);
            const stroke =
              isHovered || isRelated
                ? palette.accent
                : isMatch
                  ? palette.key
                  : palette.border;
            const title = shorten(
              visual.name,
              Math.max(8, Math.floor((visual.box.width - 30) / 7)),
            );

            return (
              <g
                key={visual.name}
                transform={`translate(${visual.box.x} ${visual.box.y})`}
                opacity={dimmed ? 0.28 : 1}
                onMouseDown={(event) => startTableDrag(event, visual)}
                onMouseEnter={() => setHovered(visual.name)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => {
                  if (suppressClickRef.current) return;
                  onOpenTable(visual.name);
                }}
                style={{ cursor: spaceDown ? "grab" : "pointer" }}
              >
                <title>{visual.name}</title>
                <rect
                  width={visual.box.width}
                  height={visual.height}
                  rx={6}
                  fill={palette.panel}
                  stroke={stroke}
                  strokeWidth={isHovered || isMatch ? 1.6 : 1}
                />
                <path
                  d={`M 0 6 Q 0 0 6 0 H ${
                    visual.box.width - 6
                  } Q ${visual.box.width} 0 ${visual.box.width} 6 V ${ERD_HEADER_HEIGHT} H 0 Z`}
                  fill={palette.panel2}
                />
                <line
                  x1={0}
                  y1={ERD_HEADER_HEIGHT}
                  x2={visual.box.width}
                  y2={ERD_HEADER_HEIGHT}
                  stroke={palette.border}
                />
                <text
                  x={10}
                  y={ERD_HEADER_HEIGHT / 2 + 4}
                  fill={palette.text}
                  fontSize={12}
                  fontWeight={600}
                  fontFamily="Inter, system-ui, sans-serif"
                >
                  {title}
                </text>

                {visual.columns.length === 0 && (
                  <text
                    x={10}
                    y={ERD_HEADER_HEIGHT + 14}
                    fill={palette.faint}
                    fontSize={10}
                    fontStyle="italic"
                  >
                    no columns
                  </text>
                )}

                {visual.columns.map((column, index) => {
                  const y = ERD_HEADER_HEIGHT + index * ERD_ROW_HEIGHT;
                  return (
                    <g key={column.name}>
                      {column.fk && !column.pk && (
                        <rect
                          x={0}
                          y={y}
                          width={2}
                          height={ERD_ROW_HEIGHT}
                          fill={palette.accent}
                        />
                      )}
                      {column.pk ? (
                        <g
                          transform={`translate(8 ${y + ERD_ROW_HEIGHT / 2 - 4})`}
                        >
                          <circle
                            cx={3}
                            cy={4}
                            r={2.6}
                            fill="none"
                            stroke={palette.key}
                            strokeWidth={1.2}
                          />
                          <path
                            d="M 5.2 4 H 11 M 8.4 4 V 6.2 M 10.2 4 V 6.2"
                            fill="none"
                            stroke={palette.key}
                            strokeWidth={1.2}
                          />
                        </g>
                      ) : column.fk ? (
                        <text
                          x={8}
                          y={y + ERD_ROW_HEIGHT / 2 + 3}
                          fill={palette.accent}
                          fontSize={8}
                          fontWeight={700}
                          fontFamily="JetBrains Mono, ui-monospace, monospace"
                        >
                          FK
                        </text>
                      ) : (
                        <circle
                          cx={10}
                          cy={y + ERD_ROW_HEIGHT / 2}
                          r={1.5}
                          fill={palette.faint}
                        />
                      )}
                      <text
                        x={column.pk || column.fk ? 24 : 18}
                        y={y + ERD_ROW_HEIGHT / 2 + 3.6}
                        fill={column.fk ? palette.accent : palette.text}
                        fontSize={11}
                        fontFamily="JetBrains Mono, ui-monospace, monospace"
                      >
                        {shorten(
                          column.name,
                          Math.max(8, Math.floor((visual.box.width - 90) / 6)),
                        )}
                      </text>
                      <text
                        x={visual.box.width - 10}
                        y={y + ERD_ROW_HEIGHT / 2 + 3.6}
                        fill={palette.muted}
                        fontSize={9.5}
                        textAnchor="end"
                        fontFamily="JetBrains Mono, ui-monospace, monospace"
                      >
                        {shorten(column.type, 18)}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </g>
      </svg>

      {loading && schema && (
        <div
          style={{
            position: "absolute",
            right: 12,
            bottom: 12,
            padding: "4px 8px",
            borderRadius: 5,
            background: "var(--sf)",
            border: "1px solid var(--bd)",
            color: "var(--mu)",
            fontSize: 11,
          }}
        >
          Refreshing…
        </div>
      )}
    </div>
  );
}
