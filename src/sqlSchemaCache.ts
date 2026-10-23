import { listColumns, listTables } from "./ipc";
import { baseTableName } from "./sqlComplete";

interface SchemaBucket {
  tables: string[] | null;
  tablesPending: Promise<void> | null;
  tablesFailedAt: number;
  columns: Map<string, string[]>;
  columnPending: Map<string, Promise<void>>;
  columnFailedAt: Map<string, number>;
}

const FAILURE_RETRY_MS = 30_000;
const buckets = new Map<string, SchemaBucket>();

function bucketFor(connId: string, database: string): SchemaBucket {
  const key = `${connId}\u0000${database}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      tables: null,
      tablesPending: null,
      tablesFailedAt: 0,
      columns: new Map(),
      columnPending: new Map(),
      columnFailedAt: new Map(),
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

function tableKey(table: string): string {
  return baseTableName(table).toLowerCase();
}

function tablesAreStale(bucket: SchemaBucket): boolean {
  return (
    bucket.tables !== null &&
    bucket.tablesFailedAt > 0 &&
    Date.now() - bucket.tablesFailedAt > FAILURE_RETRY_MS
  );
}

function columnsAreStale(bucket: SchemaBucket, key: string): boolean {
  const failedAt = bucket.columnFailedAt.get(key) ?? 0;
  return failedAt > 0 && Date.now() - failedAt > FAILURE_RETRY_MS;
}

export function cachedTables(
  connId: string,
  database: string,
): string[] | null {
  const bucket = bucketFor(connId, database);
  if (tablesAreStale(bucket)) {
    bucket.tables = null;
    bucket.tablesFailedAt = 0;
  }
  return bucket.tables;
}

export function ensureTables(
  connId: string,
  database: string,
): Promise<void> {
  const bucket = bucketFor(connId, database);
  if (bucket.tables !== null) {
    if (!tablesAreStale(bucket)) return Promise.resolve();
    bucket.tables = null;
    bucket.tablesFailedAt = 0;
  }
  if (bucket.tablesPending) return bucket.tablesPending;

  const pending = listTables(connId, database)
    .then((items) => {
      bucket.tables = items.map((item) => item.name);
      bucket.tablesFailedAt = 0;
    })
    .catch(() => {
      // Cache the miss (briefly) so typing does not retry IPC every keystroke.
      bucket.tables = [];
      bucket.tablesFailedAt = Date.now();
    })
    .finally(() => {
      bucket.tablesPending = null;
    });

  bucket.tablesPending = pending;
  return pending;
}

export function cachedColumns(
  connId: string,
  database: string,
  table: string,
): string[] | null {
  const bucket = bucketFor(connId, database);
  const key = tableKey(table);
  const columns = bucket.columns.get(key);
  if (columns === undefined) return null;
  if (columnsAreStale(bucket, key)) {
    bucket.columns.delete(key);
    bucket.columnFailedAt.delete(key);
    return null;
  }
  return columns;
}

export function ensureColumns(
  connId: string,
  database: string,
  table: string,
): Promise<void> {
  const bucket = bucketFor(connId, database);
  const key = tableKey(table);

  if (bucket.columns.has(key)) {
    if (!columnsAreStale(bucket, key)) return Promise.resolve();
    bucket.columns.delete(key);
    bucket.columnFailedAt.delete(key);
  }

  const pending = bucket.columnPending.get(key);
  if (pending) return pending;

  const request = listColumns(connId, database, baseTableName(table))
    .then((items) => {
      bucket.columns.set(
        key,
        items.map((item) => item.name),
      );
      bucket.columnFailedAt.delete(key);
    })
    .catch(() => {
      bucket.columns.set(key, []);
      bucket.columnFailedAt.set(key, Date.now());
    })
    .finally(() => {
      bucket.columnPending.delete(key);
    });

  bucket.columnPending.set(key, request);
  return request;
}
