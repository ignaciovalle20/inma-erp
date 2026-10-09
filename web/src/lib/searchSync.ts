/**
 * Keeps a debounced search box and the URL's ?q= in step (projects list).
 *
 * The box sends one navigation per pause in typing, and each one comes back
 * as a new `query` prop when it lands -- possibly after the user has typed
 * more. Those echoes must never overwrite the box: only a change that did
 * not come from it (a tab link clearing q, back/forward) may.
 *
 * `inFlight` holds every value sent and not yet confirmed by the echo of
 * the latest one, oldest first.
 */
export type SearchSyncState = { lastSent: string; inFlight: string[] };

export function initialSearchSync(query: string): SearchSyncState {
  return { lastSent: query, inFlight: [] };
}

/** The box sends `value` to the URL. */
export function searchSent(state: SearchSyncState, value: string): SearchSyncState {
  return { lastSent: value, inFlight: [...state.inFlight, value] };
}

/**
 * The URL's query became `query`. `adopt` is the text the box must show
 * now, or null to leave what the user is typing alone.
 */
export function searchQueryChanged(
  state: SearchSyncState,
  query: string,
): { state: SearchSyncState; adopt: string | null } {
  if (query === state.lastSent) {
    // The latest send landed: anything older still in flight is moot.
    return { state: { lastSent: query, inFlight: [] }, adopt: null };
  }
  const index = state.inFlight.indexOf(query);
  if (index !== -1) {
    // An older send landing late: keep waiting for the newer ones.
    return { state: { ...state, inFlight: state.inFlight.slice(index + 1) }, adopt: null };
  }
  // Changed from outside the box.
  return { state: initialSearchSync(query), adopt: query };
}
