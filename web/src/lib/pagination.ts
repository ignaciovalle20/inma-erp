/**
 * The API answers at most 1000 rows per request (max_rows) and does not say
 * when it cut: a table with years of history would come back truncated, and
 * every total built from it would be wrong without any error. These helpers
 * read page after page until a short one.
 */
export const API_PAGE_SIZE = 1000;

type ApiError = { message: string };

/**
 * Reads every page of a query. `fetchPage` must ask for rows from..to
 * (inclusive) of a query with a stable order, so pages never overlap or skip.
 * Stops at the first error and returns it together with what was read.
 */
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: ApiError | null }>,
): Promise<{ data: T[]; error: ApiError | null }> {
  const all: T[] = [];

  for (let from = 0; ; from += API_PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + API_PAGE_SIZE - 1);
    if (error) return { data: all, error };
    all.push(...(data ?? []));
    if (!data || data.length < API_PAGE_SIZE) return { data: all, error: null };
  }
}

type Pageable = {
  order(column: string): unknown;
  range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: ApiError | null }>;
};

type RowsOf<Q> = Q extends { range(from: number, to: number): PromiseLike<infer R> }
  ? R extends { data: infer D }
    ? NonNullable<D> extends unknown[]
      ? NonNullable<D>
      : never
    : never
  : never;

/**
 * Reads every row of a list query built with the Supabase client, keeping the
 * row types of its select(). Drop-in for `await query`: same `{ data, error }`
 * result, but complete. Orders by id (after any order the query has) so the
 * pages are stable. Not for count/head queries or single-row reads.
 */
export async function selectAll<Q extends Pageable>(
  query: Q,
): Promise<{ data: RowsOf<Q>; error: ApiError | null }> {
  const ordered = query.order("id") as Pageable;
  const result = await fetchAllPages((from, to) => ordered.range(from, to));
  return result as { data: RowsOf<Q>; error: ApiError | null };
}
