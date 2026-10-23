import type { CellValue } from "./types";

export type ChartType =
  | "bar"
  | "hbar"
  | "line"
  | "area"
  | "pie"
  | "donut"
  | "scatter";

export type Aggregation = "sum" | "avg" | "count" | "min" | "max";

export type ChartSort = "x" | "value";

export interface ChartConfig {
  type: ChartType;
  x: string;
  y: string[];
  aggregation: Aggregation;
  sort: ChartSort;
  topN: number;
  stacked: boolean;
}

export type ColumnKind = "numeric" | "date" | "text";

export interface ColumnProfile {
  index: number;
  name: string;
  kind: ColumnKind;
}

export interface ChartPoint {
  x: number;
  y: number;
  label: string;
}

export interface ChartSeries {
  name: string;
  values: Array<number | null>;
  points: ChartPoint[];
}

export interface ChartData {
  labels: string[];
  series: ChartSeries[];
  skippedRows: number;
  truncated: boolean;
  xNumeric: boolean;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export const DEFAULT_TOP_N = 50;
export const MAX_CHART_POINTS = 1000;

const PROFILE_ROWS = 300;

export function parseNumeric(value: CellValue): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseDateValue(value: CellValue): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match =
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(
      text,
    );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const stamp = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(stamp) ? stamp : null;
}

function labelText(value: CellValue): string {
  if (value === null || value === undefined) return "(null)";
  if (value === true) return "true";
  if (value === false) return "false";
  const text = String(value);
  return text.length > 0 ? text : "(empty)";
}

export function profileColumns(
  columns: string[],
  rows: CellValue[][],
): ColumnProfile[] {
  const sample = rows.slice(0, PROFILE_ROWS);
  return columns.map((name, index) => {
    let numeric = 0;
    let dates = 0;
    let filled = 0;
    for (const row of sample) {
      const value = row[index];
      if (value === null || value === undefined || value === "") continue;
      filled += 1;
      if (parseNumeric(value) !== null) numeric += 1;
      else if (parseDateValue(value) !== null) dates += 1;
    }
    let kind: ColumnKind = "text";
    if (filled > 0 && numeric / filled >= 0.8) kind = "numeric";
    else if (filled > 0 && dates / filled >= 0.8) kind = "date";
    return { index, name, kind };
  });
}

function columnIndex(columns: string[], name: string): number {
  return columns.indexOf(name);
}

export function autoChartConfig(
  columns: string[],
  rows: CellValue[][],
): ChartConfig {
  const profiles = profileColumns(columns, rows);
  const numeric = profiles.filter((profile) => profile.kind === "numeric");
  const labels = profiles.filter((profile) => profile.kind !== "numeric");
  const rowCount = rows.length;

  let type: ChartType = "bar";
  let x = labels[0]?.name ?? numeric[0]?.name ?? columns[0] ?? "";

  if (labels.length === 0 && numeric.length >= 2) {
    type = "scatter";
    x = numeric[0].name;
  } else if (labels.length > 0 && numeric.length === 1) {
    type = rowCount <= 8 ? "donut" : "bar";
  }
  if (type === "bar" && labels[0]?.kind === "date" && rowCount > 12) {
    type = "line";
  }

  const y = numeric
    .filter((profile) => profile.name !== x)
    .slice(0, 3)
    .map((profile) => profile.name);
  const usableY = y.length > 0 ? y : numeric.slice(0, 1).map((p) => p.name);

  return {
    type,
    x,
    y: usableY,
    aggregation: usableY.length > 0 ? "sum" : "count",
    sort: "x",
    topN: DEFAULT_TOP_N,
    stacked: false,
  };
}

export function normalizeConfig(
  columns: string[],
  rows: CellValue[][],
  config: ChartConfig | null,
): ChartConfig {
  if (!config) return autoChartConfig(columns, rows);
  const fallback = autoChartConfig(columns, rows);
  const profiles = profileColumns(columns, rows);
  let x = columns.includes(config.x) ? config.x : fallback.x;
  if (config.type === "scatter") {
    const kind = profiles.find((profile) => profile.name === x)?.kind;
    if (kind !== "numeric") {
      x = profiles.find((profile) => profile.kind === "numeric")?.name ?? x;
    }
  }
  const y = config.y.filter((name) => columns.includes(name));
  return {
    ...config,
    x,
    y: y.length > 0 || config.y.length === 0 ? y : fallback.y,
    topN: Math.max(1, Math.min(MAX_CHART_POINTS, config.topN || DEFAULT_TOP_N)),
  };
}

function aggregate(values: number[], mode: Aggregation): number | null {
  if (values.length === 0) return null;
  if (mode === "count") return values.length;
  if (mode === "sum") return values.reduce((sum, value) => sum + value, 0);
  if (mode === "avg") {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  if (mode === "min") return Math.min(...values);
  return Math.max(...values);
}

interface Group {
  label: string;
  sortKey: number | string;
  values: number[][];
  counts: number[];
}

function compareKeys(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function buildChartData(
  columns: string[],
  rows: CellValue[][],
  config: ChartConfig,
): ChartData {
  const topN = Math.max(1, Math.min(MAX_CHART_POINTS, config.topN));
  const xIndex = columnIndex(columns, config.x);
  const yIndexes = config.y
    .map((name) => columnIndex(columns, name))
    .filter((index) => index >= 0);
  const seriesCount = Math.max(1, yIndexes.length);
  const pointBudget = Math.max(
    1,
    Math.min(topN, Math.floor(MAX_CHART_POINTS / seriesCount)),
  );

  if (config.type === "scatter") {
    const points: ChartPoint[][] = yIndexes.map(() => []);
    const skipped = new Set<number>();
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const xValue = parseNumeric(row[xIndex]);
      if (xValue === null) {
        skipped.add(rowIndex);
        continue;
      }
      let valid = false;
      yIndexes.forEach((column, seriesIndex) => {
        const yValue = parseNumeric(row[column]);
        if (yValue === null) return;
        valid = true;
        points[seriesIndex].push({
          x: xValue,
          y: yValue,
          label: labelText(row[xIndex]),
        });
      });
      if (!valid) skipped.add(rowIndex);
    }

    let truncated = false;
    const series: ChartSeries[] = points.map((seriesPoints, index) => {
      const sorted = [...seriesPoints].sort((a, b) =>
        config.sort === "value" ? b.y - a.y : a.x - b.x,
      );
      if (sorted.length > pointBudget) truncated = true;
      return {
        name: config.y[index] ?? `Series ${index + 1}`,
        values: [],
        points: sorted.slice(0, pointBudget),
      };
    });

    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const item of series) {
      for (const point of item.points) {
        xMin = Math.min(xMin, point.x);
        xMax = Math.max(xMax, point.x);
        yMin = Math.min(yMin, point.y);
        yMax = Math.max(yMax, point.y);
      }
    }
    if (!Number.isFinite(xMin)) {
      xMin = 0;
      xMax = 1;
      yMin = 0;
      yMax = 1;
    }

    return {
      labels: [],
      series,
      skippedRows: skipped.size,
      truncated,
      xNumeric: true,
      xMin,
      xMax,
      yMin,
      yMax,
    };
  }

  const profiles = profileColumns(columns, rows);
  const xProfile = profiles.find((profile) => profile.name === config.x);
  const groups = new Map<string, Group>();
  const skipped = new Set<number>();

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const rawLabel = labelText(row[xIndex]);
    const sortKey =
      xProfile?.kind === "date"
        ? (parseDateValue(row[xIndex]) ?? rawLabel)
        : xProfile?.kind === "numeric"
          ? (parseNumeric(row[xIndex]) ?? rawLabel)
          : rawLabel;
    let group = groups.get(rawLabel);
    if (!group) {
      group = {
        label: rawLabel,
        sortKey,
        values: yIndexes.map(() => []),
        counts: yIndexes.length > 0 ? yIndexes.map(() => 0) : [0],
      };
      groups.set(rawLabel, group);
    }

    if (yIndexes.length === 0) {
      group.counts[0] = (group.counts[0] ?? 0) + 1;
    }

    let rowSkipped = false;
    yIndexes.forEach((column, seriesIndex) => {
      if (config.aggregation === "count") {
        group!.counts[seriesIndex] += 1;
        return;
      }
      const value = parseNumeric(row[column]);
      if (value === null) {
        rowSkipped = true;
        return;
      }
      group!.values[seriesIndex].push(value);
    });
    if (rowSkipped) skipped.add(rowIndex);
  }

  let grouped = Array.from(groups.values());
  const seriesNames = yIndexes.length > 0 ? config.y : ["Count"];

  if (config.sort === "value") {
    grouped.sort((a, b) => {
      const total = (group: Group) =>
        yIndexes.length === 0
          ? group.counts[0] ?? 0
          : yIndexes.reduce((sum, _, index) => {
              const value =
                config.aggregation === "count"
                  ? group.counts[index]
                  : aggregate(group.values[index], config.aggregation) ?? 0;
              return sum + value;
            }, 0);
      return total(b) - total(a);
    });
  } else {
    grouped.sort((a, b) => compareKeys(a.sortKey, b.sortKey));
  }

  const limit = Math.min(topN, pointBudget);
  const truncated = grouped.length > limit;
  grouped = grouped.slice(0, limit);

  const labels = grouped.map((group) => group.label);
  const series: ChartSeries[] = seriesNames.map((name, seriesIndex) => ({
    name,
    values: grouped.map((group) => {
      if (yIndexes.length === 0) return group.counts[0] ?? 0;
      if (config.aggregation === "count") {
        return group.counts[seriesIndex] ?? 0;
      }
      return aggregate(group.values[seriesIndex], config.aggregation);
    }),
    points: [],
  }));

  let yMin = Infinity;
  let yMax = -Infinity;
  for (const item of series) {
    for (const value of item.values) {
      if (value === null) continue;
      yMin = Math.min(yMin, value);
      yMax = Math.max(yMax, value);
    }
  }
  if (!Number.isFinite(yMin)) {
    yMin = 0;
    yMax = 1;
  }

  return {
    labels,
    series,
    skippedRows: skipped.size,
    truncated,
    xNumeric: false,
    xMin: 0,
    xMax: Math.max(1, labels.length - 1),
    yMin,
    yMax,
  };
}

export function formatAxisNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = abs === 0 ? 0 : abs < 0.01 ? 6 : abs < 1 ? 4 : abs < 1000 ? 2 : 0;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatChartNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 10,
  }).format(value);
}

export interface TickScale {
  min: number;
  max: number;
  ticks: number[];
}

export function niceTicks(min: number, max: number, count = 5): TickScale {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1, ticks: [0, 1] };
  }
  let low = Math.min(min, max);
  let high = Math.max(min, max);
  if (low === high) {
    const pad = Math.abs(low) * 0.1 || 1;
    low -= pad;
    high += pad;
  }
  const step0 = (high - low) / Math.max(1, count);
  const magnitude = Math.pow(10, Math.floor(Math.log10(step0)));
  const normalized = step0 / magnitude;
  const step =
    (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) *
    magnitude;
  const niceMin = Math.floor(low / step) * step;
  const niceMax = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  const limit = 100;
  for (let index = 0; index <= limit; index += 1) {
    const value = niceMin + index * step;
    if (value > niceMax + step * 0.5) break;
    ticks.push(Number(value.toFixed(10)));
  }
  return { min: niceMin, max: niceMax, ticks };
}

export function truncateLabel(label: string, max: number): string {
  if (max <= 0) return "";
  if (label.length <= max) return label;
  return `${label.slice(0, Math.max(1, max - 1))}…`;
}

export function selfCheck(): void {
  console.assert(parseNumeric("42") === 42, "parseNumeric integer");
  console.assert(parseNumeric(" 3.25 ") === 3.25, "parseNumeric decimal");
  console.assert(parseNumeric("1e3") === 1000, "parseNumeric exponent");
  console.assert(parseNumeric("abc") === null, "parseNumeric rejects text");
  console.assert(parseNumeric("9007199254740993") !== null, "parseNumeric big int");
  console.assert(parseDateValue("2024-01-02") !== null, "parseDateValue date");
  console.assert(
    parseDateValue("2024-01-02T03:04:05") !== null,
    "parseDateValue timestamp",
  );
  console.assert(parseDateValue("hello") === null, "parseDateValue rejects text");

  const ticks = niceTicks(0, 97);
  console.assert(ticks.min <= 0 && ticks.max >= 97, "niceTicks covers range");
  console.assert(
    ticks.ticks.every((value, index) => index === 0 || value > ticks.ticks[index - 1]),
    "niceTicks ascending",
  );

  const columns = ["day", "value"];
  const rows: CellValue[][] = [
    ["Mon", "10"],
    ["Tue", "5"],
    ["Mon", "4"],
    ["Tue", "oops"],
  ];
  const config: ChartConfig = {
    type: "bar",
    x: "day",
    y: ["value"],
    aggregation: "sum",
    sort: "x",
    topN: 50,
    stacked: false,
  };
  const data = buildChartData(columns, rows, config);
  console.assert(data.labels.length === 2, "buildChartData groups labels");
  console.assert(data.series[0].values[0] === 14, "buildChartData sums");
  console.assert(data.skippedRows === 1, "buildChartData tracks skipped rows");
  console.assert(
    autoChartConfig(["at", "n"], [["2024-01-01", "1"], ["2024-01-02", "2"]]).type === "donut",
    "autoChartConfig small label+number is donut",
  );
}

if (import.meta.env.DEV) selfCheck();
