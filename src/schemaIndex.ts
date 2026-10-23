import { listAllTables, listDatabases, listTables } from "./ipc";
import { useAppStore } from "./store";
import type { DatabaseTable } from "./types";

const CONNECTION_CONCURRENCY = 2;
const DATABASE_CONCURRENCY = 2;

const inFlight = new Map<string, Promise<void>>();

function connectedIds(): string[] {
  const state = useAppStore.getState();
  return Object.keys(state.connected).filter(
    (id) =>
      state.connected[id] &&
      state.connections.some((connection) => connection.id === id),
  );
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run()),
  );
}

async function indexConnection(connId: string): Promise<void> {
  const existing = inFlight.get(connId);
  if (existing) return existing;

  const task = (async () => {
    const state = useAppStore.getState();
    const connection = state.connections.find((item) => item.id === connId);
    if (!connection) return;

    let databases: string[] = [];
    try {
      databases = await listDatabases(connId);
      state.setIndexProgress(connId, { done: 0, total: databases.length });

      if (connection.dialect === "sqlite") {
        const collected: DatabaseTable[] = [];
        let done = 0;
        await mapLimit(databases, DATABASE_CONCURRENCY, async (database) => {
          try {
            const tables = await listTables(connId, database);
            collected.push(
              ...tables.map((table) => ({
                database,
                name: table.name,
                kind: table.kind,
              })),
            );
          } catch {}
          done += 1;
          const current = useAppStore.getState();
          current.setIndexProgress(connId, { done, total: databases.length });
          current.setTableIndex(connId, {
            databases,
            tables: [...collected],
            loadedAt: Date.now(),
          });
        });
        useAppStore.getState().setTableIndex(connId, {
          databases,
          tables: collected,
          loadedAt: Date.now(),
        });
      } else {
        const tables = await listAllTables(connId);
        const current = useAppStore.getState();
        current.setIndexProgress(connId, {
          done: databases.length,
          total: databases.length,
        });
        current.setTableIndex(connId, {
          databases,
          tables,
          loadedAt: Date.now(),
        });
      }
    } catch {
      const current = useAppStore.getState();
      if (!current.tableIndex[connId]) {
        current.setTableIndex(connId, {
          databases,
          tables: [],
          loadedAt: Date.now(),
        });
      }
    } finally {
      useAppStore.getState().setIndexProgress(connId, null);
      inFlight.delete(connId);
    }
  })();

  inFlight.set(connId, task);
  return task;
}

export function ensureSchemaIndex(
  force = false,
  only?: readonly string[],
): void {
  const state = useAppStore.getState();
  const targets = (only ?? connectedIds()).filter(
    (id) => state.connected[id] && !inFlight.has(id),
  );
  const pending = force
    ? targets
    : targets.filter((id) => !state.tableIndex[id]);

  if (pending.length === 0) return;

  void (async () => {
    await mapLimit(pending, CONNECTION_CONCURRENCY, async (connId) => {
      await indexConnection(connId);
    });
  })();
}
