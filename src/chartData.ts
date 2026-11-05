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
  /** Distinct non-empty values in the profiled sample. */
  distinct: number;
  /** Key columns (id, user_id, userId): numeric, but summing them means nothing. */
  idLike: boolean;
}

export type DateBucket = "none" | "hour" | "day" | "month" | "year";

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
  /** Grain dates were grouped by so a time axis fits the point budget. */
  bucket: DateBucket;
  xNumeric: boolean;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export const DEFAULT_TOP_N = 50;
export const MAX_CHART_POINTS = 1000;

const PROFILE_ROWS = 300;
const PIE_SLICES = 8;

const ID_NAME = /^id$|_id$|[a-z0-9]Id$/;
const TIME_NAME = /^(year|month|quarter|week|day|hour|il|ay|gün)$|_(year|month)$/i;

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
    const seen = new Set<string>();
    for (const row of sample) {
      const value = row[index];
      if (value === null || value === undefined || value === "") continue;
      filled += 1;
      seen.add(String(value));
      if (parseNumeric(value) !== null) numeric += 1;
      else if (parseDateValue(value) !== null) dates += 1;
    }
    let kind: ColumnKind = "text";
    if (filled > 0 && numeric / filled >= 0.8) kind = "numeric";
    else if (filled > 0 && dates / filled >= 0.8) kind = "date";
    return {
      index,
      name,
      kind,
      distinct: seen.size,
      idLike: kind === "numeric" && ID_NAME.test(name),
    };
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
  const measures = profiles.filter((p) => p.kind === "numeric" && !p.idLike);
  const date = profiles.find((p) => p.kind === "date");
  // The fewest distinct values makes the most readable category axis
  // (status, country) rather than one bar per row (email, name).
  const category = profiles
    .filter((p) => p.kind === "text" && p.distinct > 0)
    .sort((a, b) => a.distinct - b.distinct)[0];
  const timeNumber = measures.find((p) => TIME_NAME.test(p.name));

  let type: ChartType = "bar";
  let sort: ChartSort = "x";
  let x: string;
  if (date) {
    x = date.name;
    type = "line";
  } else if (category) {
    x = category.name;
    sort = "value";
  } else if (timeNumber && measures.length >= 2) {
    x = timeNumber.name;
    type = "line";
  } else if (measures.length >= 2) {
    x = measures[0].name;
    type = "scatter";
  } else {
    x = profiles.find((p) => p.idLike)?.name ?? columns[0] ?? "";
  }

  const y = measures
    .filter((p) => p.name !== x)
    .slice(0, 3)
    .map((p) => p.name);

  if (
    type === "bar" &&
    category?.name === x &&
    y.length <= 1 &&
    category.distinct <= PIE_SLICES &&
    rows.every((row) => {
      const value = y.length ? parseNumeric(row[columns.indexOf(y[0])]) : 1;
      return value === null || value >= 0;
    })
  ) {
    type = "donut";
  }

  return {
    type,
    x,
    y,
    aggregation: y.length > 0 ? "sum" : "count",
    sort,
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
  // reduce, not Math.min(...values): spreading 100k+ values overflows the stack.
  if (mode === "min") return values.reduce((a, b) => (b < a ? b : a));
  return values.reduce((a, b) => (b > a ? b : a));
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

const BUCKETS: DateBucket[] = ["none", "hour", "day", "month", "year"];

function bucketLabel(stamp: number, bucket: DateBucket): string {
  const iso = new Date(stamp).toISOString();
  if (bucket === "hour") return `${iso.slice(0, 13)}:00`;
  if (bucket === "day") return iso.slice(0, 10);
  if (bucket === "month") return iso.slice(0, 7);
  return iso.slice(0, 4);
}

function bucketStart(stamp: number, bucket: DateBucket): number {
  const d = new Date(stamp);
  if (bucket === "hour") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
  if (bucket === "day") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (bucket === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return Date.UTC(d.getUTCFullYear(), 0, 1);
}

/** Finest grain whose distinct periods fit the budget, so a time axis shows the whole range. */
function pickBucket(stamps: number[], budget: number): DateBucket {
  for (const bucket of BUCKETS) {
    const keys = new Set(
      bucket === "none" ? stamps : stamps.map((stamp) => bucketStart(stamp, bucket)),
    );
    if (keys.size <= budget) return bucket;
  }
  return "year";
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
      bucket: "none",
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
  const isPie = config.type === "pie" || config.type === "donut";
  const limit = Math.min(topN, pointBudget);

  let bucket: DateBucket = "none";
  if (xProfile?.kind === "date") {
    const stamps: number[] = [];
    for (const row of rows) {
      const stamp = parseDateValue(row[xIndex]);
      if (stamp !== null) stamps.push(stamp);
    }
    bucket = pickBucket(stamps, limit);
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    let rawLabel = labelText(row[xIndex]);
    let sortKey: number | string = rawLabel;
    if (xProfile?.kind === "date") {
      const stamp = parseDateValue(row[xIndex]);
      if (stamp !== null) {
        sortKey = bucket === "none" ? stamp : bucketStart(stamp, bucket);
        if (bucket !== "none") rawLabel = bucketLabel(stamp, bucket);
      }
    } else if (xProfile?.kind === "numeric") {
      sortKey = parseNumeric(row[xIndex]) ?? rawLabel;
    }
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
  // A pie shows one measure: the first selected column.
  const seriesNames = yIndexes.length > 0 ? config.y : ["Count"];
  const seriesValue = (group: Group, index: number): number | null => {
    if (yIndexes.length === 0) return group.counts[0] ?? 0;
    if (config.aggregation === "count") return group.counts[index] ?? 0;
    return aggregate(group.values[index], config.aggregation);
  };
  const total = (group: Group) =>
    isPie
      ? seriesValue(group, 0) ?? 0
      : seriesNames.reduce((sum, _, index) => sum + (seriesValue(group, index) ?? 0), 0);
  const byValue = (a: Group, b: Group) => total(b) - total(a);
  const byX = (a: Group, b: Group) => compareKeys(a.sortKey, b.sortKey);

  const cap = isPie ? Math.min(limit, PIE_SLICES) : limit;
  const truncated = grouped.length > cap;
  let rest: Group[] = [];
  if (truncated) {
    // Time and number axes keep their order; categories keep the biggest groups,
    // not the alphabetically first ones.
    grouped.sort(xProfile?.kind === "text" ? byValue : byX);
    rest = grouped.slice(cap);
    grouped = grouped.slice(0, cap);
  }
  grouped.sort(config.sort === "value" ? byValue : byX);

  const labels = grouped.map((group) => group.label);
  const series: ChartSeries[] = (isPie ? seriesNames.slice(0, 1) : seriesNames).map(
    (name, seriesIndex) => ({
      name,
      values: grouped.map((group) => seriesValue(group, seriesIndex)),
      points: [],
    }),
  );
  // Sums and counts add up, so the slices left out of a pie still show as "Other".
  if (isPie && rest.length > 0 && ["sum", "count"].includes(config.aggregation)) {
    labels.push(`Other (${rest.length})`);
    series[0].values.push(rest.reduce((sum, group) => sum + (seriesValue(group, 0) ?? 0), 0));
  }

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
    bucket,
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
    autoChartConfig(["at", "n"], [["2024-01-01", "1"], ["2024-01-02", "2"]]).type === "line",
    "autoChartConfig dates make a line, never a pie",
  );
  const users = autoChartConfig(
    ["id", "email", "status", "age"],
    [
      ["1", "a@x.az", "active", "30"],
      ["2", "b@x.az", "active", "41"],
      ["3", "c@x.az", "banned", "25"],
    ],
  );
  console.assert(
    users.x === "status" && !users.y.includes("id"),
    "autoChartConfig groups by the low-cardinality column and never sums ids",
  );
  const stamps = Array.from({ length: 400 }, (_, i) => [
    new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10),
    "1",
  ]);
  const daily = buildChartData(["d", "n"], stamps, {
    ...config,
    type: "line",
    x: "d",
    y: ["n"],
  });
  console.assert(
    daily.bucket === "month" && daily.labels[0] === "2024-01" && !daily.truncated,
    "buildChartData buckets long date ranges instead of cutting them",
  );
  const many = buildChartData(
    ["k", "n"],
    [["a", "1"], ["b", "1"], ["c", "1"], ["d", "1"], ["e", "1"], ["f", "1"], ["g", "1"], ["h", "1"], ["z", "100"]],
    { ...config, type: "pie", x: "k", y: ["n"] },
  );
  console.assert(
    many.labels.includes("z") && many.labels[many.labels.length - 1] === "Other (1)",
    "pie keeps the biggest slices and folds the rest into Other",
  );
}

if (import.meta.env.DEV) selfCheck();
