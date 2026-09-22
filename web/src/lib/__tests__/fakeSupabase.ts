/**
 * A stand-in for the Supabase client used by reporting.ts's own direct
 * queries -- NOT a PostgREST/SQL simulator. Each `.from(table)` call
 * returns the next `{ data, error }` queued for that table, in the
 * exact order reporting.ts issues its Promise.all queries; every
 * chained filter method (`.select`, `.eq`, `.is`, `.or`, `.not`, `.in`,
 * `.gte`, `.lt`, `.order`, `.range`, `.single`, `.maybeSingle`) is a no-op that
 * returns the same builder -- the queued value already represents
 * whatever the real call would resolve to (an array for a plain
 * `.select()`, a single object or null for `.maybeSingle()`), so
 * there's nothing left for these to do.
 *
 * This only proves the *arithmetic* in reporting.ts is correct for a
 * given set of rows (per spec Decisions/the informe's own G.2
 * methodology) -- it says nothing about whether the real SQL filters
 * actually select those rows. Master-data helpers (getClients,
 * getProjects, getBusinessAreas, getUserCompanies,
 * getProjectCostStatus, getSession) are mocked separately at the
 * `@/lib/dal` module level, not through this fake client, so their
 * own (differently-shaped) queries never need to go through here.
 */
export type FakeResult<T = unknown> = { data: T | null; error: unknown };

export function createFakeSupabase(
  queues: Record<string, FakeResult[]>,
) {
  const from = (table: string) => {
    const builder: PromiseLike<FakeResult> & Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      or: () => builder,
      not: () => builder,
      in: () => builder,
      gte: () => builder,
      lt: () => builder,
      order: () => builder,
      // selectAll() pages a list with .range(); every awaited page consumes the
      // next queued response, so a test queues one entry per page.
      range: () => builder,
      single: () => builder,
      maybeSingle: () => builder,
      then<TResult1 = FakeResult, TResult2 = never>(
        onFulfilled?:
          | ((value: FakeResult) => TResult1 | PromiseLike<TResult1>)
          | null,
        onRejected?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null,
      ) {
        const queue = queues[table];
        if (!queue || queue.length === 0) {
          throw new Error(
            `fakeSupabase: no queued response left for table "${table}"`,
          );
        }
        return Promise.resolve(queue.shift()!).then(onFulfilled, onRejected);
      },
    };
    return builder;
  };

  return { from };
}
