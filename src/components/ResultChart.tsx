import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from "react";
import {
  MAX_CHART_POINTS,
  buildChartData,
  formatAxisNumber,
  formatChartNumber,
  niceTicks,
  normalizeConfig,
  profileColumns,
  truncateLabel,
} from "../chartData";
import type {
  Aggregation,
  ChartConfig,
  ChartData,
  ChartSort,
  ChartType,
  ColumnKind,
} from "../chartData";
import { errorMessage, saveErd } from "../ipc";
import { notify } from "../notifications";
import type { QueryResult } from "../types";

interface Props {
  result: QueryResult;
  config: ChartConfig | null;
  theme: "dark" | "light";
  onConfigChange: (config: ChartConfig) => void;
}

interface TipRow {
  name: string;
  value: string;
  color: string;
}

interface HoverTip {
  x: number;
  y: number;
  title: string;
  rows: TipRow[];
}

interface ChartPalette {
  bg: string;
  text: string;
  muted: string;
  border: string;
  grid: string;
  series: string[];
  font: string;
}

const DEFAULT_PALETTE: ChartPalette = {
  bg: "#0f1115",
  text: "#dfe3e8",
  muted: "#8b929c",
  border: "#2f343c",
  grid: "#24282f",
  series: [
    "#6ea8fe",
    "#4ec9a7",
    "#f0a35e",
    "#e07a9c",
    "#b89cf5",
    "#a3c76a",
  ],
  font: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const CHART_TYPES: Array<{ value: ChartType; label: string }> = [
  { value: "bar", label: "Bar" },
  { value: "hbar", label: "Horizontal bar" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
  { value: "pie", label: "Pie" },
  { value: "donut", label: "Donut" },
  { value: "scatter", label: "Scatter" },
];

const AGGREGATIONS: Array<{ value: Aggregation; label: string }> = [
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "count", label: "Count" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
];

const SORTS: Array<{ value: ChartSort; label: string }> = [
  { value: "x", label: "By X" },
  { value: "value", label: "By value" },
];

const selectStyle = {
  height: 24,
  maxWidth: 160,
  border: "1px solid var(--bd2)",
  borderRadius: 4,
  background: "var(--bg)",
  color: "var(--tx)",
  fontSize: 11.5,
  padding: "0 5px",
} as const;

const toolbarButtonStyle = {
  height: 24,
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "0 7px",
  border: "1px solid var(--bd2)",
  borderRadius: 4,
  background: "transparent",
  color: "var(--tx)",
  fontSize: 11.5,
  cursor: "default",
  whiteSpace: "nowrap",
} as const;

const fieldStyle = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  color: "var(--mu)",
  whiteSpace: "nowrap",
} as const;

const fieldLabelStyle = {
  fontSize: 10.5,
  color: "var(--fa)",
} as const;

const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

function readPalette(
  element: HTMLElement | null,
  theme: "dark" | "light",
): ChartPalette {
  if (!element) return DEFAULT_PALETTE;
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  const dark = theme === "dark";
  return {
    bg: read("--bg", dark ? "#0f1115" : "#ffffff"),
    text: read("--tx", dark ? "#dfe3e8" : "#1a1d21"),
    muted: read("--mu", dark ? "#8b929c" : "#616770"),
    border: read("--bd2", dark ? "#2f343c" : "#d7dade"),
    grid: read("--bd", dark ? "#24282f" : "#e6e8ec"),
    series: [
      read("--chart-1", DEFAULT_PALETTE.series[0]),
      read("--chart-2", DEFAULT_PALETTE.series[1]),
      read("--chart-3", DEFAULT_PALETTE.series[2]),
      read("--chart-4", DEFAULT_PALETTE.series[3]),
      read("--chart-5", DEFAULT_PALETTE.series[4]),
      read("--chart-6", DEFAULT_PALETTE.series[5]),
    ],
    font: read("--mono", DEFAULT_PALETTE.font),
  };
}

function seriesColor(palette: ChartPalette, index: number): string {
  return palette.series[index % palette.series.length];
}

function valueText(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "—"
    : formatChartNumber(value);
}

interface ChartSvgProps {
  data: ChartData;
  config: ChartConfig;
  width: number;
  height: number;
  palette: ChartPalette;
  onEnter: (
    event: ReactPointerEvent<SVGElement>,
    title: string,
    rows: TipRow[],
  ) => void;
  onLeave: () => void;
}

const ChartSvg = memo(function ChartSvg({
  data,
  config,
  width,
  height,
  palette,
  onEnter,
  onLeave,
}: ChartSvgProps) {
  const isPie = config.type === "pie" || config.type === "donut";
  const isScatter = config.type === "scatter";
  const isHorizontal = config.type === "hbar";
  const showLegend = !isPie && data.series.length > 1;
  const legendHeight = showLegend ? 22 : 0;
  const longestLabel = data.labels.reduce(
    (max, label) => Math.max(max, label.length),
    3,
  );
  const leftMargin = isHorizontal
    ? Math.min(170, Math.max(64, Math.min(longestLabel, 22) * 6.4 + 16))
    : 58;
  const margin = isPie
    ? { top: 12, right: 18, bottom: 12, left: 12 }
    : {
        top: 12,
        right: 18,
        bottom: (isHorizontal || isScatter ? 32 : 40) + legendHeight,
        left: leftMargin,
      };
  const plotW = Math.max(10, width - margin.left - margin.right);
  const plotH = Math.max(10, height - margin.top - margin.bottom);
  const left = margin.left;
  const top = margin.top;
  const plotBottom = top + plotH;

  const stacked =
    config.stacked &&
    (config.type === "bar" ||
      config.type === "hbar" ||
      config.type === "area");

  let domainMin = data.yMin;
  let domainMax = data.yMax;
  if (stacked) {
    let min = 0;
    let max = 0;
    data.labels.forEach((_, index) => {
      let positive = 0;
      let negative = 0;
      data.series.forEach((series) => {
        const value = series.values[index] ?? 0;
        if (value >= 0) positive += value;
        else negative += value;
      });
      max = Math.max(max, positive);
      min = Math.min(min, negative);
    });
    domainMin = min;
    domainMax = max;
  }
  const forceZero =
    config.type === "bar" || config.type === "hbar" || config.type === "area";
  if (forceZero) {
    domainMin = Math.min(0, domainMin);
    domainMax = Math.max(0, domainMax);
  }
  const yScaleTicks = niceTicks(domainMin, domainMax, 5);
  const yScale = (value: number) =>
    plotBottom -
    ((value - yScaleTicks.min) / (yScaleTicks.max - yScaleTicks.min)) *
      plotH;

  const xTicks = isScatter ? niceTicks(data.xMin, data.xMax, 5) : null;
  const numericX = xTicks ?? yScaleTicks;
  const xScale = (value: number) =>
    left +
    ((value - numericX.min) / Math.max(1e-9, numericX.max - numericX.min)) *
      plotW;

  const band = plotW / Math.max(1, data.labels.length);
  const centerX = (index: number) => left + (index + 0.5) * band;
  const lineX = (index: number) => centerX(index);

  const gridLines: ReactNode[] = [];
  if (isPie) {
    // Pie and donut charts have no cartesian axes.
  } else if (isScatter) {
    for (const tick of yScaleTicks.ticks) {
      const y = yScale(tick);
      gridLines.push(
        <line
          key={`gy-${tick}`}
          x1={left}
          x2={left + plotW}
          y1={y}
          y2={y}
          stroke={palette.grid}
          strokeWidth={1}
        />,
      );
    }
    for (const tick of xTicks?.ticks ?? []) {
      const x = xScale(tick);
      gridLines.push(
        <line
          key={`gx-${tick}`}
          x1={x}
          x2={x}
          y1={top}
          y2={plotBottom}
          stroke={palette.grid}
          strokeWidth={1}
        />,
      );
    }
  } else if (isHorizontal) {
    for (const tick of yScaleTicks.ticks) {
      const x = xScale(tick);
      gridLines.push(
        <line
          key={`gx-${tick}`}
          x1={x}
          x2={x}
          y1={top}
          y2={plotBottom}
          stroke={palette.grid}
          strokeWidth={1}
        />,
      );
    }
  } else {
    for (const tick of yScaleTicks.ticks) {
      const y = yScale(tick);
      gridLines.push(
        <line
          key={`gy-${tick}`}
          x1={left}
          x2={left + plotW}
          y1={y}
          y2={y}
          stroke={palette.grid}
          strokeWidth={1}
        />,
      );
    }
  }

  const valueAxis = isPie ? null : isScatter ? (
    <g>
      <line
        x1={left}
        x2={left + plotW}
        y1={plotBottom}
        y2={plotBottom}
        stroke={palette.border}
        strokeWidth={1}
      />
      <line
        x1={left}
        x2={left}
        y1={top}
        y2={plotBottom}
        stroke={palette.border}
        strokeWidth={1}
      />
      {(xTicks?.ticks ?? []).map((tick) => (
        <text
          key={`xt-${tick}`}
          x={xScale(tick)}
          y={plotBottom + 15}
          textAnchor="middle"
          fill={palette.muted}
          fontSize={10}
          fontFamily={palette.font}
        >
          {formatAxisNumber(tick)}
        </text>
      ))}
      {yScaleTicks.ticks.map((tick) => (
        <text
          key={`yt-${tick}`}
          x={left - 7}
          y={yScale(tick) + 3.5}
          textAnchor="end"
          fill={palette.muted}
          fontSize={10}
          fontFamily={palette.font}
        >
          {formatAxisNumber(tick)}
        </text>
      ))}
    </g>
  ) : isHorizontal ? (
    <g>
      <line
        x1={left}
        x2={left + plotW}
        y1={plotBottom}
        y2={plotBottom}
        stroke={palette.border}
        strokeWidth={1}
      />
      {yScaleTicks.ticks.map((tick) => (
        <text
          key={`xt-${tick}`}
          x={xScale(tick)}
          y={plotBottom + 15}
          textAnchor="middle"
          fill={palette.muted}
          fontSize={10}
          fontFamily={palette.font}
        >
          {formatAxisNumber(tick)}
        </text>
      ))}
    </g>
  ) : (
    <g>
      <line
        x1={left}
        x2={left}
        y1={top}
        y2={plotBottom}
        stroke={palette.border}
        strokeWidth={1}
      />
      {yScaleTicks.ticks.map((tick) => (
        <text
          key={`yt-${tick}`}
          x={left - 7}
          y={yScale(tick) + 3.5}
          textAnchor="end"
          fill={palette.muted}
          fontSize={10}
          fontFamily={palette.font}
        >
          {formatAxisNumber(tick)}
        </text>
      ))}
    </g>
  );

  const categoryAxis = !isScatter && !isPie && !isHorizontal && (
    <g>
      <line
        x1={left}
        x2={left + plotW}
        y1={plotBottom}
        y2={plotBottom}
        stroke={palette.border}
        strokeWidth={1}
      />
      {data.labels.map((label, index) => {
        const step = Math.max(
          1,
          Math.ceil(data.labels.length / Math.max(1, Math.floor(plotW / 58))),
        );
        if (index % step !== 0) return null;
        const maxChars = Math.max(4, Math.floor((band * step) / 6.3));
        return (
          <text
            key={`xl-${index}`}
            x={centerX(index)}
            y={plotBottom + 16}
            textAnchor="middle"
            fill={palette.muted}
            fontSize={10}
            fontFamily={palette.font}
          >
            {truncateLabel(label, maxChars)}
          </text>
        );
      })}
    </g>
  );

  const horizontalAxis = isHorizontal && (
    <g>
      {data.labels.map((label, index) => {
        const step = Math.max(
          1,
          Math.ceil(data.labels.length / Math.max(1, Math.floor(plotH / 20))),
        );
        if (index % step !== 0) return null;
        return (
          <text
            key={`yl-${index}`}
            x={left - 8}
            y={top + (index + 0.5) * (plotH / Math.max(1, data.labels.length)) + 3.5}
            textAnchor="end"
            fill={palette.muted}
            fontSize={10}
            fontFamily={palette.font}
          >
            {truncateLabel(label, 18)}
          </text>
        );
      })}
      <line
        x1={left}
        x2={left}
        y1={top}
        y2={plotBottom}
        stroke={palette.border}
        strokeWidth={1}
      />
    </g>
  );

  const hoverBands = !isScatter && !isPie && (
    <g>
      {data.labels.map((label, index) => {
        const rows = data.series.map((series, seriesIndex) => ({
          name: series.name,
          value: valueText(series.values[index]),
          color: seriesColor(palette, seriesIndex),
        }));
        const x = isHorizontal ? left : left + index * band;
        const y = isHorizontal ? top + index * band : top;
        const bandWidth = isHorizontal ? plotW : band;
        const bandHeight = isHorizontal ? band : plotH;
        return (
          <rect
            key={`hover-${index}`}
            x={x}
            y={y}
            width={bandWidth}
            height={bandHeight}
            fill="transparent"
            pointerEvents="all"
            onPointerEnter={(event) => onEnter(event, label, rows)}
            onPointerLeave={onLeave}
          />
        );
      })}
    </g>
  );

  let marks: ReactNode = null;

  if (isPie) {
    const values = data.series[0]?.values ?? [];
    const total = values.reduce<number>(
      (sum, value) => sum + Math.max(0, value ?? 0),
      0,
    );
    const cx = left + plotW / 2;
    const cy = top + plotH / 2;
    const radius = Math.max(10, Math.min(plotW, plotH) / 2 - 8);
    const inner =
      config.type === "donut" ? Math.max(4, radius * 0.55) : 0;
    if (total <= 0) {
      marks = (
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          fill={palette.muted}
          fontSize={12}
          fontFamily={palette.font}
        >
          No positive values to chart
        </text>
      );
    } else {
      let angle = -Math.PI / 2;
      marks = (
        <g>
          {values.map((rawValue, index) => {
            const value = Math.max(0, rawValue ?? 0);
            if (value <= 0) return null;
            const color = seriesColor(palette, index);
            const title = data.labels[index] ?? `Row ${index + 1}`;
            const rows: TipRow[] = [
              {
                name: data.series[0]?.name ?? "Value",
                value: formatChartNumber(value),
                color,
              },
              {
                name: "Share",
                value: `${((value / total) * 100).toFixed(1)}%`,
                color,
              },
            ];
            const full = value >= total - 1e-9;
            if (full) {
              return config.type === "donut" ? (
                <circle
                  key={`slice-${index}`}
                  cx={cx}
                  cy={cy}
                  r={(radius + inner) / 2}
                  fill="none"
                  stroke={color}
                  strokeWidth={Math.max(1, radius - inner)}
                  onPointerEnter={(event) => onEnter(event, title, rows)}
                  onPointerLeave={onLeave}
                />
              ) : (
                <circle
                  key={`slice-${index}`}
                  cx={cx}
                  cy={cy}
                  r={radius}
                  fill={color}
                  onPointerEnter={(event) => onEnter(event, title, rows)}
                  onPointerLeave={onLeave}
                />
              );
            }
            const start = angle;
            const end = angle + (value / total) * Math.PI * 2;
            angle = end;
            const large = end - start > Math.PI ? 1 : 0;
            const x0 = cx + radius * Math.cos(start);
            const y0 = cy + radius * Math.sin(start);
            const x1 = cx + radius * Math.cos(end);
            const y1 = cy + radius * Math.sin(end);
            const path =
              inner > 0
                ? `M ${x0} ${y0} A ${radius} ${radius} 0 ${large} 1 ${x1} ${y1} L ${
                    cx + inner * Math.cos(end)
                  } ${cy + inner * Math.sin(end)} A ${inner} ${inner} 0 ${large} 0 ${
                    cx + inner * Math.cos(start)
                  } ${cy + inner * Math.sin(start)} Z`
                : `M ${cx} ${cy} L ${x0} ${y0} A ${radius} ${radius} 0 ${large} 1 ${x1} ${y1} Z`;
            return (
              <path
                key={`slice-${index}`}
                d={path}
                fill={color}
                stroke={palette.bg}
                strokeWidth={1}
                onPointerEnter={(event) => onEnter(event, title, rows)}
                onPointerLeave={onLeave}
              />
            );
          })}
          {config.type === "donut" && (
            <text
              x={cx}
              y={cy + 4}
              textAnchor="middle"
              fill={palette.text}
              fontSize={12}
              fontFamily={palette.font}
            >
              {formatAxisNumber(total)}
            </text>
          )}
        </g>
      );
    }
  } else if (isScatter) {
    marks = (
      <g>
        {data.series.map((series, seriesIndex) => {
          const color = seriesColor(palette, seriesIndex);
          return (
            <g key={`series-${seriesIndex}`}>
              {series.points.map((point, pointIndex) => {
                const rows: TipRow[] = [
                  {
                    name: config.x,
                    value: point.label,
                    color,
                  },
                  {
                    name: series.name,
                    value: formatChartNumber(point.y),
                    color,
                  },
                ];
                return (
                  <circle
                    key={`point-${seriesIndex}-${pointIndex}`}
                    cx={xScale(point.x)}
                    cy={yScale(point.y)}
                    r={3.4}
                    fill={color}
                    fillOpacity={0.86}
                    stroke={palette.bg}
                    strokeWidth={0.5}
                    onPointerEnter={(event) =>
                      onEnter(event, point.label, rows)
                    }
                    onPointerLeave={onLeave}
                  />
                );
              })}
            </g>
          );
        })}
      </g>
    );
  } else if (isHorizontal) {
    const categoryCount = Math.max(1, data.labels.length);
    const rowHeight = plotH / categoryCount;
    const groupHeight = rowHeight * 0.72;
    const seriesHeight = groupHeight / Math.max(1, data.series.length);
    const stacks = data.labels.map(() => ({ positive: 0, negative: 0 }));
    marks = (
      <g>
        {data.labels.map((_, categoryIndex) => {
          const stack = stacks[categoryIndex];
          return data.series.map((series, seriesIndex) => {
            const value = series.values[categoryIndex] ?? 0;
            const color = seriesColor(palette, seriesIndex);
            const base = stacked
              ? value >= 0
                ? stack.positive
                : stack.negative
              : 0;
            const next = base + value;
            if (stacked) {
              if (value >= 0) stack.positive = next;
              else stack.negative = next;
              if (value === 0) return null;
            }
            const x0 = xScale(Math.min(base, next));
            const x1 = xScale(Math.max(base, next));
            const width = Math.max(value === 0 ? 0 : 1, x1 - x0);
            const y = stacked
              ? top + categoryIndex * rowHeight + (rowHeight - groupHeight) / 2
              : top +
                categoryIndex * rowHeight +
                (rowHeight - groupHeight) / 2 +
                seriesIndex * seriesHeight;
            const height = stacked
              ? Math.max(1, groupHeight)
              : Math.max(1, seriesHeight - 1);
            if (width <= 0) return null;
            return (
              <rect
                key={`bar-${categoryIndex}-${seriesIndex}`}
                x={x0}
                y={y}
                width={width}
                height={height}
                rx={1.5}
                fill={color}
              />
            );
          });
        })}
      </g>
    );
  } else if (config.type === "bar") {
    const groupWidth = band * 0.72;
    const barWidth = groupWidth / Math.max(1, data.series.length);
    const stacks = data.labels.map(() => ({ positive: 0, negative: 0 }));
    marks = (
      <g>
        {data.labels.map((_, categoryIndex) => {
          const stack = stacks[categoryIndex];
          return data.series.map((series, seriesIndex) => {
            const value = series.values[categoryIndex] ?? 0;
            const color = seriesColor(palette, seriesIndex);
            const base = stacked
              ? value >= 0
                ? stack.positive
                : stack.negative
              : 0;
            const next = base + value;
            if (stacked) {
              if (value >= 0) stack.positive = next;
              else stack.negative = next;
            }
            const y0 = yScale(base);
            const y1 = yScale(next);
            const heightValue = Math.abs(y0 - y1);
            const x = stacked
              ? left + categoryIndex * band + (band - groupWidth) / 2
              : left +
                categoryIndex * band +
                (band - groupWidth) / 2 +
                seriesIndex * barWidth;
            const width = stacked ? groupWidth : Math.max(1, barWidth - 1);
            if (value === 0) return null;
            return (
              <rect
                key={`bar-${categoryIndex}-${seriesIndex}`}
                x={x}
                y={Math.min(y0, y1)}
                width={width}
                height={Math.max(1, heightValue)}
                rx={1.5}
                fill={color}
              />
            );
          });
        })}
      </g>
    );
  } else {
    const stacks = data.labels.map(() => ({ positive: 0, negative: 0 }));
    const lines: ReactNode[] = [];
    const areas: ReactNode[] = [];
    let runIndex = 0;
    data.series.forEach((series, seriesIndex) => {
      const color = seriesColor(palette, seriesIndex);
      let run: Array<{ x: number; y: number; base: number }> = [];
      const flush = () => {
        if (run.length === 0) return;
        runIndex += 1;
        if (run.length === 1) {
          lines.push(
            <circle
              key={`point-${seriesIndex}-${runIndex}`}
              cx={run[0].x}
              cy={run[0].y}
              r={2.5}
              fill={color}
            />,
          );
          run = [];
          return;
        }
        const linePath = run
          .map(
            (point, index) =>
              `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`,
          )
          .join(" ");
        lines.push(
          <path
            key={`line-${seriesIndex}-${runIndex}`}
            d={linePath}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />,
        );
        if (config.type === "area") {
          const topPath = run
            .map(
              (point, index) =>
                `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`,
            )
            .join(" ");
          const bottomPath = [...run]
            .reverse()
            .map((point) => `L ${point.x} ${point.base}`)
            .join(" ");
          areas.push(
            <path
              key={`area-${seriesIndex}-${runIndex}`}
              d={`${topPath} ${bottomPath} Z`}
              fill={color}
              fillOpacity={0.22}
              stroke="none"
            />,
          );
        }
        run = [];
      };
      series.values.forEach((rawValue, index) => {
        if (rawValue === null) {
          flush();
          return;
        }
        const value = rawValue;
        const stack = stacks[index];
        const base = stacked
          ? value >= 0
            ? stack.positive
            : stack.negative
          : 0;
        const next = base + value;
        if (stacked) {
          if (value >= 0) stack.positive = next;
          else stack.negative = next;
        }
        run.push({
          x: lineX(index),
          y: yScale(stacked ? next : value),
          base: yScale(base),
        });
      });
      flush();
    });
    marks = (
      <g>
        {areas}
        {lines}
      </g>
    );
  }

  const legend = showLegend && (
    <g>
      {(() => {
        const items = data.series.map((series, index) => ({
          name: truncateLabel(series.name, 20),
          color: seriesColor(palette, index),
          width: Math.min(150, truncateLabel(series.name, 20).length * 6.2 + 19),
        }));
        const total = items.reduce((sum, item) => sum + item.width + 10, 0);
        let x = Math.max(left, left + plotW / 2 - total / 2);
        const y = height - 10;
        return items.map((item, index) => {
          const itemX = x;
          x += item.width + 10;
          return (
            <g key={`legend-${index}`}>
              <rect
                x={itemX}
                y={y - 8}
                width={9}
                height={9}
                rx={2}
                fill={item.color}
              />
              <text
                x={itemX + 13}
                y={y}
                fill={palette.muted}
                fontSize={10.5}
                fontFamily={palette.font}
              >
                {item.name}
              </text>
            </g>
          );
        });
      })()}
    </g>
  );

  return (
    <g>
      {gridLines}
      {valueAxis}
      {categoryAxis}
      {horizontalAxis}
      {marks}
      {hoverBands}
      {legend}
    </g>
  );
});

interface ChartCanvasProps {
  data: ChartData;
  config: ChartConfig;
  width: number;
  height: number;
  palette: ChartPalette;
  svgRef: RefObject<SVGSVGElement>;
  summary: string;
  hasChartData: boolean;
}

function ChartCanvas({
  data,
  config,
  width,
  height,
  palette,
  svgRef,
  summary,
  hasChartData,
}: ChartCanvasProps) {
  const [tip, setTip] = useState<HoverTip | null>(null);

  const handleEnter = useCallback(
    (
      event: ReactPointerEvent<SVGElement>,
      title: string,
      rows: TipRow[],
    ) => {
      const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
      setTip({
        x: rect ? event.clientX - rect.left : 0,
        y: rect ? event.clientY - rect.top : 0,
        title,
        rows,
      });
    },
    [],
  );

  const handleLeave = useCallback(() => setTip(null), []);

  const tipHeight = 26 + (tip?.rows.length ?? 0) * 16;
  const tipTop = tip
    ? tip.y + 14 + tipHeight > height - 8
      ? Math.max(8, tip.y - tipHeight - 14)
      : tip.y + 14
    : 0;
  const tipLeft = tip ? Math.max(8, Math.min(tip.x + 12, width - 226)) : 0;

  return (
    <>
      {hasChartData ? (
        <svg
          ref={svgRef}
          role="img"
          aria-label={summary}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ display: "block", width: "100%", height: "100%" }}
        >
          <rect width={width} height={height} fill={palette.bg} />
          <ChartSvg
            data={data}
            config={config}
            width={width}
            height={height}
            palette={palette}
            onEnter={handleEnter}
            onLeave={handleLeave}
          />
        </svg>
      ) : (
        <div
          style={{
            height: "100%",
            display: "grid",
            placeItems: "center",
            color: "var(--mu)",
            fontFamily: "var(--mono)",
            fontSize: 12,
            textAlign: "center",
            padding: 16,
          }}
        >
          No numeric values to chart — pick numeric Y columns or a different
          X column.
        </div>
      )}

      {tip && (
        <div
          style={{
            position: "absolute",
            left: tipLeft,
            top: tipTop,
            zIndex: 4,
            minWidth: 130,
            maxWidth: 218,
            padding: "6px 8px",
            border: "1px solid var(--bd2)",
            borderRadius: 4,
            background: "var(--sf2)",
            boxShadow: "var(--sh)",
            pointerEvents: "none",
            fontSize: 11.5,
            lineHeight: 1.45,
          }}
        >
          <div
            style={{
              color: "var(--tx)",
              fontFamily: "var(--mono)",
              marginBottom: 3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={tip.title}
          >
            {tip.title}
          </div>
          {tip.rows.map((row) => (
            <div
              key={row.name}
              style={{ display: "flex", alignItems: "center", gap: 5 }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: row.color,
                  flex: "none",
                }}
              />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--mu)",
                }}
              >
                {row.name}
              </span>
              <span
                style={{
                  color: "var(--tx)",
                  fontFamily: "var(--mono)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {row.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default function ResultChart({
  result,
  config: configProp,
  theme,
  onConfigChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const yButtonRef = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState({ width: 640, height: 360 });
  const [palette, setPalette] = useState<ChartPalette>(DEFAULT_PALETTE);
  const [exporting, setExporting] = useState<
    "png" | "svg" | "copy" | null
  >(null);
  const [canCopy, setCanCopy] = useState(
    () => typeof ClipboardItem !== "undefined",
  );
  const [yOpen, setYOpen] = useState(false);
  const [yPosition, setYPosition] = useState({ x: 0, y: 0 });

  const config = useMemo(
    () => normalizeConfig(result.columns, result.rows, configProp),
    [result.columns, result.rows, configProp],
  );
  const data = useMemo(
    () => buildChartData(result.columns, result.rows, config),
    [result.columns, result.rows, config],
  );
  const profiles = useMemo(
    () => profileColumns(result.columns, result.rows),
    [result.columns, result.rows],
  );
  const numericColumns = useMemo(
    () => profiles.filter((profile) => profile.kind === "numeric"),
    [profiles],
  );
  const profileKind = useCallback(
    (name: string): ColumnKind | null =>
      profiles.find((profile) => profile.name === name)?.kind ?? null,
    [profiles],
  );

  useLayoutEffect(() => {
    setPalette(readPalette(containerRef.current, theme));
  }, [theme]);

  useEffect(() => {
    const element = plotRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize({
        width: Math.max(280, Math.round(rect.width)),
        height: Math.max(220, Math.round(rect.height)),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    void import("@tauri-apps/plugin-clipboard-manager")
      .then((module) => {
        const api = module as unknown as {
          writeImage?: (image: Uint8Array | number[]) => Promise<void>;
        };
        if (active && typeof api.writeImage === "function") setCanCopy(true);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const change = useCallback(
    (patch: Partial<ChartConfig>) => {
      onConfigChange({ ...config, ...patch });
    },
    [config, onConfigChange],
  );

  const changeType = (type: ChartType) => {
    const x =
      type === "scatter" && profileKind(config.x) !== "numeric"
        ? numericColumns[0]?.name ?? config.x
        : config.x;
    change({ type, x });
  };

  const toggleY = (name: string) => {
    const next = config.y.includes(name)
      ? config.y.filter((item) => item !== name)
      : [...config.y, name];
    change({
      y: next,
      ...(next.length === 0 ? { aggregation: "count" as Aggregation } : {}),
    });
  };

  const openYMenu = () => {
    const rect = yButtonRef.current?.getBoundingClientRect();
    setYPosition({
      x: Math.max(8, Math.min(rect?.left ?? 8, window.innerWidth - 230)),
      y: Math.max(8, Math.min((rect?.bottom ?? 40) + 4, window.innerHeight - 280)),
    });
    setYOpen(true);
  };

  const collectSvg = useCallback(() => {
    const node = svgRef.current;
    if (!node) return null;
    const clone = node.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(size.width));
    clone.setAttribute("height", String(size.height));
    clone.removeAttribute("style");
    return new XMLSerializer().serializeToString(clone);
  }, [size.height, size.width]);

  const rasterize = useCallback(async () => {
    const markup = collectSvg();
    if (!markup) throw new Error("Chart is not ready");
    const blob = new Blob([markup], {
      type: "image/svg+xml;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Could not rasterize chart"));
        image.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = size.width * 2;
      canvas.height = size.height * 2;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is not available");
      context.fillStyle = palette.bg;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/png");
      const png = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (resultBlob) =>
            resultBlob
              ? resolve(resultBlob)
              : reject(new Error("Could not encode PNG")),
          "image/png",
        ),
      );
      return { dataUrl, png };
    } finally {
      URL.revokeObjectURL(url);
    }
  }, [collectSvg, palette.bg, size.height, size.width]);

  const exportSvg = async () => {
    setExporting("svg");
    try {
      const markup = collectSvg();
      if (!markup) return;
      const saved = await saveErd("svg", markup, "dataforge-chart.svg");
      if (saved) void notify("DataForge", "Chart exported.");
    } catch (error) {
      void notify("DataForge", "Export failed: " + errorMessage(error));
    } finally {
      setExporting(null);
    }
  };

  const exportPng = async () => {
    setExporting("png");
    try {
      const { dataUrl } = await rasterize();
      const saved = await saveErd("png", dataUrl, "dataforge-chart.png");
      if (saved) void notify("DataForge", "Chart exported.");
    } catch (error) {
      void notify("DataForge", "Export failed: " + errorMessage(error));
    } finally {
      setExporting(null);
    }
  };

  const copyPng = async () => {
    setExporting("copy");
    let copied = false;
    try {
      const { png } = await rasterize();
      try {
        const module = await import("@tauri-apps/plugin-clipboard-manager");
        const api = module as unknown as {
          writeImage?: (image: Uint8Array | number[]) => Promise<void>;
        };
        if (typeof api.writeImage === "function") {
          await api.writeImage(new Uint8Array(await png.arrayBuffer()));
          copied = true;
        }
      } catch {
        copied = false;
      }
      if (
        !copied &&
        typeof ClipboardItem !== "undefined" &&
        navigator.clipboard?.write
      ) {
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ "image/png": png }),
          ]);
          copied = true;
        } catch {
          copied = false;
        }
      }
      void notify(
        "DataForge",
        copied
          ? "Chart copied to clipboard."
          : "Copying images is not supported on this platform.",
      );
    } catch (error) {
      void notify("DataForge", "Copy failed: " + errorMessage(error));
    } finally {
      setExporting(null);
    }
  };

  const typeLabel =
    CHART_TYPES.find((item) => item.value === config.type)?.label ?? "Chart";
  const summary =
    config.type === "scatter"
      ? `${typeLabel} chart of ${config.y.join(", ") || "values"} against ${
          config.x
        }, ${data.series.reduce(
          (sum, series) => sum + series.points.length,
          0,
        )} points${data.skippedRows > 0 ? `, ${data.skippedRows} rows skipped` : ""}.`
      : `${typeLabel} chart of ${
          config.y.join(", ") || "row count"
        } by ${config.x}, ${data.labels.length} categories, ${
          data.series.length
        } series${data.skippedRows > 0 ? `, ${data.skippedRows} rows skipped` : ""}.`;

  const hasChartData =
    config.type === "scatter"
      ? data.series.some((series) => series.points.length > 0)
      : data.labels.length > 0 &&
        data.series.some((series) =>
          series.values.some((value) => value !== null),
        );

  const tableHeaders =
    config.type === "scatter"
      ? [config.x, "Series", "Y"]
      : [config.x, ...data.series.map((series) => series.name)];
  const tableRows =
    config.type === "scatter"
      ? data.series.flatMap((series) =>
          series.points.map((point) => [
            point.label,
            series.name,
            formatChartNumber(point.y),
          ]),
        )
      : data.labels.map((label, index) => [
          label,
          ...data.series.map((series) => valueText(series.values[index])),
        ]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        position: "relative",
      }}
    >
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
          padding: "5px 10px",
          borderBottom: "1px solid var(--bd)",
          background: "var(--sf)",
          fontFamily: "var(--ui)",
          fontSize: 11.5,
        }}
      >
        <label style={fieldStyle}>
          <span style={fieldLabelStyle}>Type</span>
          <select
            value={config.type}
            onChange={(event) => changeType(event.target.value as ChartType)}
            style={selectStyle}
            title="Chart type"
          >
            {CHART_TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <label style={fieldStyle}>
          <span style={fieldLabelStyle}>X</span>
          <select
            value={config.x}
            onChange={(event) => change({ x: event.target.value })}
            style={selectStyle}
            title="X (label) column"
          >
            {(config.type === "scatter"
              ? numericColumns.map((profile) => profile.name)
              : result.columns
            ).map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        </label>

        <div style={{ ...fieldStyle, position: "relative" }}>
          <span style={fieldLabelStyle}>Y</span>
          <button
            ref={yButtonRef}
            type="button"
            onClick={openYMenu}
            style={{
              ...toolbarButtonStyle,
              maxWidth: 190,
              overflow: "hidden",
            }}
            title="Y columns"
          >
            <span
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {config.y.length > 0 ? config.y.join(", ") : "Count rows"}
            </span>
            <i className="icon-chevron-down" style={{ fontSize: 10 }} />
          </button>
        </div>

        <label style={fieldStyle}>
          <span style={fieldLabelStyle}>Agg</span>
          <select
            value={config.aggregation}
            onChange={(event) =>
              change({ aggregation: event.target.value as Aggregation })
            }
            style={selectStyle}
            title="Aggregation when X repeats"
          >
            {AGGREGATIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <label style={fieldStyle}>
          <span style={fieldLabelStyle}>Sort</span>
          <select
            value={config.sort}
            onChange={(event) =>
              change({ sort: event.target.value as ChartSort })
            }
            style={selectStyle}
            title="Sort order"
          >
            {SORTS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <label style={fieldStyle}>
          <span style={fieldLabelStyle}>Top</span>
          <input
            type="number"
            min={1}
            max={MAX_CHART_POINTS}
            value={config.topN}
            onChange={(event) =>
              change({
                topN: Math.max(
                  1,
                  Math.min(
                    MAX_CHART_POINTS,
                    Number(event.target.value) || 1,
                  ),
                ),
              })
            }
            style={{
              width: 58,
              height: 24,
              border: "1px solid var(--bd2)",
              borderRadius: 4,
              background: "var(--bg)",
              color: "var(--tx)",
              fontSize: 11.5,
              padding: "0 5px",
            }}
            title="Top N points (max 1000)"
          />
        </label>

        {(config.type === "bar" ||
          config.type === "hbar" ||
          config.type === "area") && (
          <label
            style={{
              ...fieldStyle,
              gap: 5,
              color:
                config.stacked && !["bar", "hbar", "area"].includes(config.type)
                  ? "var(--fa)"
                  : "var(--tx)",
            }}
          >
            <input
              type="checkbox"
              checked={config.stacked}
              onChange={(event) => change({ stacked: event.target.checked })}
            />
            <span>Stacked</span>
          </label>
        )}

        <div style={{ flex: 1, minWidth: 8 }} />

        {data.skippedRows > 0 && (
          <span
            style={{
              color: "var(--wn)",
              fontFamily: "var(--mono)",
              fontSize: 10.5,
            }}
            title="Rows with non-numeric Y values were not charted"
          >
            {data.skippedRows.toLocaleString("en-US")} rows skipped
          </span>
        )}
        {data.truncated && (
          <span
            style={{
              color: "var(--fa)",
              fontFamily: "var(--mono)",
              fontSize: 10.5,
            }}
          >
            top {config.topN.toLocaleString("en-US")}
          </span>
        )}

        <button
          type="button"
          className="v2-btn"
          onClick={() => void exportPng()}
          disabled={exporting !== null}
          style={toolbarButtonStyle}
          title="Save chart as PNG"
        >
          <i className="icon-download" style={{ fontSize: 12 }} />
          <span>{exporting === "png" ? "Saving…" : "Save PNG"}</span>
        </button>
        <button
          type="button"
          className="v2-btn"
          onClick={() => void exportSvg()}
          disabled={exporting !== null}
          style={toolbarButtonStyle}
          title="Save chart as SVG"
        >
          <i className="icon-file-code" style={{ fontSize: 12 }} />
          <span>{exporting === "svg" ? "Saving…" : "Save SVG"}</span>
        </button>
        {canCopy && (
          <button
            type="button"
            className="v2-btn"
            onClick={() => void copyPng()}
            disabled={exporting !== null}
            style={toolbarButtonStyle}
            title="Copy chart PNG to clipboard"
          >
            <i className="icon-copy" style={{ fontSize: 12 }} />
            <span>{exporting === "copy" ? "Copying…" : "Copy PNG"}</span>
          </button>
        )}
      </div>

      <div
        ref={plotRef}
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <ChartCanvas
          data={data}
          config={config}
          width={size.width}
          height={size.height}
          palette={palette}
          svgRef={svgRef}
          summary={summary}
          hasChartData={hasChartData}
        />
      </div>

      <table style={srOnly} aria-label="Chart data">
        <thead>
          <tr>
            {tableHeaders.map((header, index) => (
              <th key={`${header}-${index}`}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tableRows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {yOpen && (
        <>
          <div
            onMouseDown={() => setYOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 60 }}
          />
          <div
            style={{
              position: "fixed",
              left: yPosition.x,
              top: yPosition.y,
              zIndex: 61,
              minWidth: 200,
              maxHeight: 300,
              overflow: "auto",
              padding: 4,
              border: "1px solid var(--bd2)",
              borderRadius: 6,
              background: "var(--sf2)",
              boxShadow: "var(--sh)",
              fontSize: 12,
            }}
          >
            {numericColumns.length === 0 && (
              <div style={{ padding: "5px 7px", color: "var(--mu)" }}>
                No numeric columns
              </div>
            )}
            {numericColumns.map((profile) => (
              <label
                key={profile.name}
                className="df2-menu-item"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 7px",
                  borderRadius: 4,
                  color: "var(--tx)",
                  cursor: "default",
                }}
              >
                <input
                  type="checkbox"
                  checked={config.y.includes(profile.name)}
                  onChange={() => toggleY(profile.name)}
                />
                <span>{profile.name}</span>
              </label>
            ))}
            <div
              style={{
                margin: "4px 7px 3px",
                paddingTop: 4,
                borderTop: "1px solid var(--bd)",
                color: "var(--fa)",
                fontSize: 10.5,
              }}
            >
              No selection counts rows
            </div>
          </div>
        </>
      )}
    </div>
  );
}
