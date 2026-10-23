import type { ErForeignKey, ErTable } from "./types";

export const ERD_HEADER_HEIGHT = 28;
export const ERD_ROW_HEIGHT = 20;
export const ERD_ROW_PAD = 6;

const MIN_TABLE_WIDTH = 190;
const MAX_TABLE_WIDTH = 320;
const GAP_X = 84;
const GAP_Y = 28;
const COMPONENT_GAP_X = 96;
const COMPONENT_GAP_Y = 112;
const ISOLATED_GAP = 28;
const WRAP_WIDTH = 2600;

export interface ErTableBox {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
}

export interface ErLayout {
  tables: ErTableBox[];
  bounds: { minX: number; minY: number; width: number; height: number };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function textWidth(value: string, size: number) {
  return value.length * size * 0.62;
}

function measure(table: ErTable) {
  let columnWidth = 0;
  for (const column of table.columns) {
    columnWidth = Math.max(
      columnWidth,
      textWidth(column.name, 11) + textWidth(column.data_type, 10) + 46,
    );
  }

  return {
    width: clamp(
      Math.max(MIN_TABLE_WIDTH, textWidth(table.name, 12) + 38, columnWidth + 20),
      MIN_TABLE_WIDTH,
      MAX_TABLE_WIDTH,
    ),
    height:
      ERD_HEADER_HEIGHT +
      Math.max(1, table.columns.length) * ERD_ROW_HEIGHT +
      ERD_ROW_PAD,
  };
}

function sortByName(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function connectedComponents(
  names: string[],
  neighbors: Map<string, string[]>,
): string[][] {
  const seen = new Set<string>();
  const components: string[][] = [];

  for (const name of names) {
    if (seen.has(name)) continue;
    const stack = [name];
    const members: string[] = [];
    seen.add(name);

    while (stack.length > 0) {
      const current = stack.pop()!;
      members.push(current);
      for (const next of neighbors.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }

    members.sort(sortByName);
    components.push(members);
  }

  return components;
}

function assignLayers(
  members: string[],
  outgoing: Map<string, string[]>,
): Map<string, number> {
  const layers = new Map<string, number>();
  const state = new Map<string, 0 | 1 | 2>();
  const memberSet = new Set(members);

  const visit = (name: string): number => {
    const current = state.get(name) ?? 0;
    if (current === 1) return layers.get(name) ?? 0;
    if (current === 2) return layers.get(name) ?? 0;

    state.set(name, 1);
    let depth = 0;
    for (const target of outgoing.get(name) ?? []) {
      if (target === name || !memberSet.has(target)) continue;
      depth = Math.max(depth, visit(target) + 1);
    }
    state.set(name, 2);
    layers.set(name, depth);
    return depth;
  };

  for (const name of members) visit(name);
  return layers;
}

function orderLayers(
  layers: string[][],
  neighbors: Map<string, string[]>,
): void {
  const position = (layer: string[]) =>
    new Map(layer.map((name, index) => [name, index]));

  for (let pass = 0; pass < 3; pass += 1) {
    if (pass % 2 === 0) {
      for (let index = 1; index < layers.length; index += 1) {
        const reference = position(layers[index - 1]);
        const original = new Map(
          layers[index].map((name, position) => [name, position]),
        );
        layers[index].sort((a, b) => {
          const values = (name: string) =>
            (neighbors.get(name) ?? [])
              .map((neighbor) => reference.get(neighbor))
              .filter((value): value is number => value !== undefined);
          const av = values(a);
          const bv = values(b);
          const aScore = av.length
            ? av.reduce((sum, value) => sum + value, 0) / av.length
            : original.get(a) ?? 0;
          const bScore = bv.length
            ? bv.reduce((sum, value) => sum + value, 0) / bv.length
            : original.get(b) ?? 0;
          return (
            aScore - bScore ||
            (original.get(a) ?? 0) - (original.get(b) ?? 0) ||
            sortByName(a, b)
          );
        });
      }
    } else {
      for (let index = layers.length - 2; index >= 0; index -= 1) {
        const reference = position(layers[index + 1]);
        const original = new Map(
          layers[index].map((name, position) => [name, position]),
        );
        layers[index].sort((a, b) => {
          const values = (name: string) =>
            (neighbors.get(name) ?? [])
              .map((neighbor) => reference.get(neighbor))
              .filter((value): value is number => value !== undefined);
          const av = values(a);
          const bv = values(b);
          const aScore = av.length
            ? av.reduce((sum, value) => sum + value, 0) / av.length
            : original.get(a) ?? 0;
          const bScore = bv.length
            ? bv.reduce((sum, value) => sum + value, 0) / bv.length
            : original.get(b) ?? 0;
          return (
            aScore - bScore ||
            (original.get(a) ?? 0) - (original.get(b) ?? 0) ||
            sortByName(a, b)
          );
        });
      }
    }
  }
}

function layoutComponent(
  members: string[],
  tableMap: Map<string, ErTable>,
  outgoing: Map<string, string[]>,
  neighbors: Map<string, string[]>,
): { boxes: ErTableBox[]; width: number; height: number } {
  const layerOf = assignLayers(members, outgoing);
  const maxLayer = Math.max(0, ...members.map((name) => layerOf.get(name) ?? 0));
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);

  for (const name of members) {
    layers[layerOf.get(name) ?? 0].push(name);
  }
  for (const layer of layers) layer.sort(sortByName);

  orderLayers(layers, neighbors);

  const sizes = new Map(
    members.map((name) => [name, measure(tableMap.get(name)!)]),
  );
  const maxHeight = Math.max(
    ...layers.map((layer) => {
      const heights = layer.map((name) => sizes.get(name)!.height);
      return (
        heights.reduce((sum, height) => sum + height, 0) +
        Math.max(0, heights.length - 1) * GAP_Y
      );
    }),
    0,
  );

  const boxes: ErTableBox[] = [];
  let cursorX = 0;

  layers.forEach((layer, layerIndex) => {
    const columnWidth = Math.max(
      ...layer.map((name) => sizes.get(name)!.width),
      MIN_TABLE_WIDTH,
    );
    const totalHeight =
      layer.reduce((sum, name) => sum + sizes.get(name)!.height, 0) +
      Math.max(0, layer.length - 1) * GAP_Y;
    let cursorY = (maxHeight - totalHeight) / 2;

    for (const name of layer) {
      const size = sizes.get(name)!;
      boxes.push({
        name,
        x: cursorX + (columnWidth - size.width) / 2,
        y: cursorY,
        width: size.width,
        height: size.height,
        layer: layerIndex,
      });
      cursorY += size.height + GAP_Y;
    }

    cursorX += columnWidth + GAP_X;
  });

  return {
    boxes,
    width: Math.max(cursorX - GAP_X, 1),
    height: Math.max(maxHeight, 1),
  };
}

/**
 * Deterministic layered ER layout. Referenced tables (no outgoing foreign
 * keys) sit on the left; referencing tables are placed by FK depth. Connected
 * components are packed separately and unconnected tables go in a grid below.
 */
export function layoutEr(
  tables: ErTable[],
  foreignKeys: ErForeignKey[],
): ErLayout {
  const tableMap = new Map<string, ErTable>();
  for (const table of tables) tableMap.set(table.name, table);
  const names = [...tableMap.keys()].sort(sortByName);

  const outgoing = new Map<string, string[]>();
  const neighbors = new Map<string, string[]>();

  for (const fk of foreignKeys) {
    if (
      fk.from_table === fk.to_table ||
      !tableMap.has(fk.from_table) ||
      !tableMap.has(fk.to_table)
    ) {
      continue;
    }
    outgoing.set(fk.from_table, [
      ...(outgoing.get(fk.from_table) ?? []),
      fk.to_table,
    ]);
    neighbors.set(fk.from_table, [
      ...(neighbors.get(fk.from_table) ?? []),
      fk.to_table,
    ]);
    neighbors.set(fk.to_table, [
      ...(neighbors.get(fk.to_table) ?? []),
      fk.from_table,
    ]);
  }

  for (const [name, list] of outgoing) {
    outgoing.set(name, [...new Set(list)].sort(sortByName));
  }
  for (const [name, list] of neighbors) {
    neighbors.set(name, [...new Set(list)].sort(sortByName));
  }

  const components = connectedComponents(names, neighbors);
  const connected = components.filter(
    (members) => members.length > 1 || neighbors.has(members[0]),
  );
  const isolated = components
    .filter((members) => !(members.length > 1 || neighbors.has(members[0])))
    .map((members) => members[0]);

  connected.sort((a, b) => {
    if (a.length !== b.length) return b.length - a.length;
    return sortByName(a[0], b[0]);
  });

  const boxes: ErTableBox[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  for (const members of connected) {
    const component = layoutComponent(
      members,
      tableMap,
      outgoing,
      neighbors,
    );
    if (cursorX > 0 && cursorX + component.width > WRAP_WIDTH) {
      cursorX = 0;
      cursorY += rowHeight + COMPONENT_GAP_Y;
      rowHeight = 0;
    }

    for (const box of component.boxes) {
      boxes.push({ ...box, x: box.x + cursorX, y: box.y + cursorY });
    }

    cursorX += component.width + COMPONENT_GAP_X;
    rowHeight = Math.max(rowHeight, component.height);
  }

  let occupiedBottom =
    connected.length > 0 ? cursorY + rowHeight : 0;

  if (isolated.length > 0) {
    const startY =
      occupiedBottom > 0 ? occupiedBottom + COMPONENT_GAP_Y : 0;
    const isoBoxes = isolated.map((name) => {
      const size = measure(tableMap.get(name)!);
      return { name, width: size.width, height: size.height };
    });
    const widest = Math.max(...isoBoxes.map((box) => box.width));
    const columns = Math.max(
      1,
      Math.floor((WRAP_WIDTH + ISOLATED_GAP) / (widest + ISOLATED_GAP)),
    );

    let column = 0;
    let x = 0;
    let y = startY;
    let lineHeight = 0;

    for (const box of isoBoxes) {
      if (column >= columns) {
        column = 0;
        x = 0;
        y += lineHeight + ISOLATED_GAP;
        lineHeight = 0;
      }
      boxes.push({
        name: box.name,
        x,
        y,
        width: box.width,
        height: box.height,
        layer: 0,
      });
      x += box.width + ISOLATED_GAP;
      lineHeight = Math.max(lineHeight, box.height);
      column += 1;
    }

    occupiedBottom = y + lineHeight;
  }

  const width = Math.max(
    ...boxes.map((box) => box.x + box.width),
    1,
  );
  const height = Math.max(
    occupiedBottom,
    ...boxes.map((box) => box.y + box.height),
    1,
  );

  const byName = new Map(boxes.map((box) => [box.name, box]));
  return {
    tables: names.map((name) => byName.get(name)!).filter(Boolean),
    bounds: { minX: 0, minY: 0, width, height },
  };
}

function overlaps(a: ErTableBox, b: ErTableBox) {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** Dev-only sanity checks: deterministic output and non-overlapping boxes. */
export function selfCheck() {
  const tables: ErTable[] = [
    {
      name: "customers",
      columns: [
        { name: "id", data_type: "int", nullable: false, pk: true },
        { name: "name", data_type: "text", nullable: false, pk: false },
      ],
    },
    {
      name: "orders",
      columns: [
        { name: "id", data_type: "int", nullable: false, pk: true },
        { name: "customer_id", data_type: "int", nullable: false, pk: false },
      ],
    },
    {
      name: "order_lines",
      columns: [
        { name: "order_id", data_type: "int", nullable: false, pk: true },
        { name: "product_id", data_type: "int", nullable: false, pk: true },
      ],
    },
    {
      name: "products",
      columns: [
        { name: "id", data_type: "int", nullable: false, pk: true },
      ],
    },
    {
      name: "audit_log",
      columns: [
        { name: "id", data_type: "int", nullable: false, pk: true },
      ],
    },
    {
      name: "settings",
      columns: [
        { name: "key", data_type: "text", nullable: false, pk: true },
      ],
    },
  ];
  const foreignKeys: ErForeignKey[] = [
    {
      name: "fk_orders_customer",
      from_table: "orders",
      from_columns: ["customer_id"],
      to_table: "customers",
      to_columns: ["id"],
    },
    {
      name: "fk_lines_order",
      from_table: "order_lines",
      from_columns: ["order_id"],
      to_table: "orders",
      to_columns: ["id"],
    },
    {
      name: "fk_lines_product",
      from_table: "order_lines",
      from_columns: ["product_id"],
      to_table: "products",
      to_columns: ["id"],
    },
  ];

  const first = layoutEr(tables, foreignKeys);
  const second = layoutEr(tables, foreignKeys);
  console.assert(
    JSON.stringify(first) === JSON.stringify(second),
    "ER layout must be deterministic",
  );
  console.assert(
    first.tables.length === tables.length,
    "ER layout must place every table",
  );

  for (let i = 0; i < first.tables.length; i += 1) {
    for (let j = i + 1; j < first.tables.length; j += 1) {
      console.assert(
        !overlaps(first.tables[i], first.tables[j]),
        `ER layout overlap: ${first.tables[i].name} / ${first.tables[j].name}`,
      );
    }
  }
}

if (import.meta.env.DEV) selfCheck();
