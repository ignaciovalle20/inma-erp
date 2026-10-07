import { describe, it, expect } from "vitest";
import { linkify } from "@/lib/linkify";

describe("linkify", () => {
  it("returns plain text untouched", () => {
    expect(linkify("sin links\nsegunda línea")).toEqual([
      { type: "text", value: "sin links\nsegunda línea" },
    ]);
  });

  it("finds http(s) and www. links and keeps the text around them", () => {
    expect(linkify("ver https://x.com/a?b=1 y www.inma.cl hoy")).toEqual([
      { type: "text", value: "ver " },
      { type: "link", value: "https://x.com/a?b=1", href: "https://x.com/a?b=1" },
      { type: "text", value: " y " },
      { type: "link", value: "www.inma.cl", href: "https://www.inma.cl" },
      { type: "text", value: " hoy" },
    ]);
  });

  it("leaves sentence punctuation and an unmatched parenthesis out of the link", () => {
    expect(linkify("(ver http://a.com/x).")).toEqual([
      { type: "text", value: "(ver " },
      { type: "link", value: "http://a.com/x", href: "http://a.com/x" },
      { type: "text", value: ")." },
    ]);
    expect(linkify("https://es.wikipedia.org/wiki/Foo_(bar), listo")[0]).toEqual({
      type: "link",
      value: "https://es.wikipedia.org/wiki/Foo_(bar)",
      href: "https://es.wikipedia.org/wiki/Foo_(bar)",
    });
  });

  it("does not link other schemes", () => {
    expect(linkify("javascript:alert(1) ftp://x")).toEqual([
      { type: "text", value: "javascript:alert(1) ftp://x" },
    ]);
  });
});
