import { describe, it, expect } from "vitest";
import { initialSearchSync, searchQueryChanged, searchSent } from "@/lib/searchSync";

describe("search box <-> ?q= sync", () => {
  it("ignores late echoes of older searches while the user keeps typing", () => {
    // Typed "ins" (sent), then "instala" (sent), then kept typing.
    let state = searchSent(searchSent(initialSearchSync(""), "ins"), "instala");

    let result = searchQueryChanged(state, "ins");
    expect(result.adopt).toBeNull();
    state = result.state;

    result = searchQueryChanged(state, "instala");
    expect(result.adopt).toBeNull();
    expect(result.state).toEqual({ lastSent: "instala", inFlight: [] });
  });

  it("follows a change that did not come from the box", () => {
    let state = searchSent(initialSearchSync(""), "ebano");
    state = searchQueryChanged(state, "ebano").state;

    // A tab link drops q.
    const cleared = searchQueryChanged(state, "");
    expect(cleared.adopt).toBe("");
    expect(cleared.state).toEqual({ lastSent: "", inFlight: [] });
  });

  it("follows an outside change even when it repeats an old search", () => {
    // The user cleared the box before ("" was sent and landed), searched
    // again, then a tab link clears q: that "" is not an echo any more.
    let state = searchSent(initialSearchSync("abc"), "");
    state = searchQueryChanged(state, "").state;
    state = searchSent(state, "x");
    state = searchQueryChanged(state, "x").state;

    expect(searchQueryChanged(state, "").adopt).toBe("");
  });

  it("the latest echo landing first makes older ones outside changes", () => {
    let state = searchSent(searchSent(initialSearchSync(""), "a"), "ab");
    state = searchQueryChanged(state, "ab").state;
    // Something else navigates to ?q=a afterwards (back/forward).
    expect(searchQueryChanged(state, "a").adopt).toBe("a");
  });
});
