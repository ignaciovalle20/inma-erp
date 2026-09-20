/**
 * The API cuts every answer at 1000 rows without saying so (docs/plan-sistema-v3.md,
 * B3). Pages are read until a short one; a total over 2,500 rows must equal
 * the plain sum of the rows.
 */
import { describe, it, expect } from "vitest";
import { API_PAGE_SIZE, fetchAllPages, selectAll } from "@/lib/pagination";

type Row = { id: number; net_amount: number };

/** A table of `n` rows served the way PostgREST serves it: pages of at most 1000. */
function table(n: number): Row[] {
  return Array.from({ length: n }, (_, index) => ({ id: index + 1, net_amount: (index % 7) + 1 }));
}

function pageOf(rows: Row[]) {
  return (from: number, to: number) => Promise.resolve({ data: rows.slice(from, to + 1), error: null });
}

describe("fetchAllPages", () => {
  it.each([0, 1, 999, 1000, 1001, 2000, 2500])("returns all %i rows, once each", async (n) => {
    const rows = table(n);
    const { data, error } = await fetchAllPages(pageOf(rows));

    expect(error).toBeNull();
    expect(data).toHaveLength(n);
    expect(new Set(data.map((row) => row.id)).size).toBe(n);
  });

  it("gives the same total as the plain sum with more than 1,000 documents", async () => {
    const rows = table(2500);
    const { data } = await fetchAllPages(pageOf(rows));

    const summed = data.reduce((sum, row) => sum + row.net_amount, 0);
    expect(summed).toBe(rows.reduce((sum, row) => sum + row.net_amount, 0));
    // What reading only the first page (the old behavior) would have shown.
    expect(rows.slice(0, API_PAGE_SIZE).reduce((sum, row) => sum + row.net_amount, 0)).toBeLessThan(summed);
  });

  it("stops at the first error and returns it with what was read", async () => {
    const rows = table(2500);
    const result = await fetchAllPages((from, to) =>
      from >= 1000 ? Promise.resolve({ data: null, error: { message: "timeout" } }) : pageOf(rows)(from, to),
    );

    expect(result.error).toEqual({ message: "timeout" });
    expect(result.data).toHaveLength(1000);
  });

  it("asks a full page after a full page, and no more than needed", async () => {
    const asked: [number, number][] = [];
    const rows = table(2000);
    await fetchAllPages((from, to) => {
      asked.push([from, to]);
      return pageOf(rows)(from, to);
    });

    // 2000 rows = two full pages, then the empty one that proves it is over.
    expect(asked).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });
});

/** The slice of the Supabase builder the helper relies on. */
function fakeQuery(rows: Row[]) {
  const seen: { order: string[]; ranges: [number, number][] } = { order: [], ranges: [] };
  const query = {
    order(column: string) {
      seen.order.push(column);
      return query;
    },
    range(from: number, to: number) {
      seen.ranges.push([from, to]);
      return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
    },
  };
  return { query, seen };
}

describe("selectAll", () => {
  it("is a drop-in for awaiting the query: same shape, complete, ordered by id", async () => {
    const rows = table(2300);
    const { query, seen } = fakeQuery(rows);

    const { data, error } = await selectAll(query);

    expect(error).toBeNull();
    expect(data).toHaveLength(2300);
    expect(seen.order).toEqual(["id"]);
    expect(seen.ranges.map(([from]) => from)).toEqual([0, 1000, 2000]);
    expect(data.reduce((sum, row) => sum + row.net_amount, 0)).toBe(rows.reduce((sum, row) => sum + row.net_amount, 0));
  });

  it("returns the error instead of a partial result that reads as complete", async () => {
    const failing = {
      order: () => failing,
      range: () => Promise.resolve({ data: null, error: { message: "permission denied" } }),
    };
    const { error, data } = await selectAll(failing);

    expect(error).toEqual({ message: "permission denied" });
    expect(data).toEqual([]);
  });
});
